#!/usr/bin/env python3
"""Local ADB reverse endpoint for one authenticated YOLO-triggered yaw step."""

import argparse
import fcntl
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import re
import socketserver
import subprocess
import threading
import time
import uuid

MAX_AGE_MS = 2500.0
DEAD_ZONE_FRACTION = 0.1
MAX_REQUEST_BYTES = 4096


class Journal:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._file = self.path.open("a+", encoding="utf-8")
        try:
            fcntl.flock(self._file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self._file.close()
            raise
        os.chmod(self.path, 0o600)
        self.consumed = set()
        self.frames = set()
        if self.path.exists():
            for line in self.path.read_text(encoding="utf-8").splitlines():
                entry = json.loads(line)
                if entry.get("event") == "attempt_reserved":
                    self.consumed.add(entry["attempt_id"])
                    self.frames.add((entry["source_id"], entry["frame_id"]))
        self._lock = threading.Lock()

    def append(self, event, **data):
        with self._lock:
            self._file.write(json.dumps(dict(event=event, epoch_ns=str(time.time_ns()), **data),
                                        ensure_ascii=False, allow_nan=False) + "\n")
            self._file.flush()
            os.fsync(self._file.fileno())

    def close(self):
        self._file.close()


def _integer(value, minimum=0):
    return type(value) is int and value >= minimum


def validate(request, token):
    if not isinstance(request, dict):
        return "JSON object required"
    supplied = request.get("token")
    if not isinstance(supplied, str) or not hmac.compare_digest(supplied, token):
        return "Invalid token"
    if type(request.get("schema")) is not int or request["schema"] != 1:
        return "Unsupported schema"
    attempt = request.get("attempt_id")
    try:
        if not isinstance(attempt, str) or str(uuid.UUID(attempt)) != attempt:
            return "Invalid attempt_id"
    except ValueError:
        return "Invalid attempt_id"
    if not _integer(request.get("frame_id"), 1) or not _integer(request.get("source_id")):
        return "Invalid frame/source ID"
    try:
        armed, capture = request["armed_ns"], request["capture_ns"]
        if not all(isinstance(v, str) and v.isascii() and v.isdigit() for v in (armed, capture)):
            return "Timestamps must be decimal strings"
        if int(armed) <= 0 or int(capture) <= int(armed):
            return "Frame predates arming"
    except KeyError:
        return "Missing Android timestamps"
    age = request.get("age_ms")
    if type(age) not in (int, float) or not math.isfinite(age) or not 0 <= age <= MAX_AGE_MS:
        return "Frame is stale or age is invalid"
    width, offset = request.get("width"), request.get("offset_x")
    if not _integer(width, 1) or type(offset) not in (int, float) or not math.isfinite(offset):
        return "Invalid frame geometry"
    if not DEAD_ZONE_FRACTION * width < offset <= width / 2:
        return "Frame is not right of the dead zone"
    if request.get("direction") != "right":
        return "Only one right yaw step is supported"
    return None


def angles(output, label):
    for line in output.splitlines():
        if line.startswith(label + " "):
            match = re.search(r"Angles\(yawDegrees=(-?[\d.]+), rollDegrees=(-?[\d.]+), pitchDegrees=(-?[\d.]+)\)", line)
            if match:
                values = dict(zip(("yaw", "roll", "pitch"), map(float, match.groups())))
                if all(math.isfinite(v) for v in values.values()):
                    return values
    return None


class ProbeRunner:
    def __init__(self, executable, port, timeout_s=10.0, runner=subprocess.run):
        self.command = [str(executable), "nudge", "--port", port, "--profile", "sdk-classic-stream",
                        "--can-bitrate", "1000000", "--tx-id", "0x223", "--rx-id", "0x222",
                        "--axis", "yaw", "--direction", "positive", "--timeout-ms", "1000"]
        self.timeout_s = timeout_s
        self.runner = runner

    def __call__(self, request):
        try:
            completed = self.runner(self.command, capture_output=True, text=True, timeout=self.timeout_s,
                                    check=False)
            output, error = completed.stdout, completed.stderr
            success = completed.returncode == 0 and "nudge_pass" in output.splitlines()
            status = "success" if success else "error"
            message = "DJI yaw +3 degrees verified" if success else "DJI attempt failed; no retry"
            result = dict(status=status, message=message, return_code=completed.returncode,
                          probe_stdout=output, probe_stderr=error)
        except subprocess.TimeoutExpired as error:
            def decoded(value):
                return value.decode(errors="replace") if isinstance(value, bytes) else value or ""
            output = decoded(error.stdout)
            result = dict(status="timeout", message="DJI outcome uncertain after timeout; no retry",
                          return_code=None, probe_stdout=output, probe_stderr=decoded(error.stderr))
        except OSError as error:
            output = ""
            result = dict(status="error", message="Could not start DJI probe; no retry",
                          return_code=None, probe_stdout="", probe_stderr=str(error))
        result.update(before=angles(output, "before"), after=angles(output, "after"),
                      settled=angles(output, "settled"))
        return result


class Bridge:
    def __init__(self, token, journal, run_probe, max_attempts=1):
        if not token or max_attempts < 1:
            raise ValueError("Token and positive attempt limit required")
        self.token, self.journal, self.run_probe = token, journal, run_probe
        self.max_attempts = max_attempts
        self._lock = threading.Lock()
        self._busy = False
        self._responses = {}

    @staticmethod
    def rejected(request, message):
        attempt = request.get("attempt_id") if isinstance(request, dict) else None
        return dict(attempt_id=attempt, status="rejected", message=message)

    def handle(self, request):
        issue = validate(request, self.token)
        if issue:
            return self.rejected(request, issue)
        attempt = request["attempt_id"]
        with self._lock:
            if attempt in self.journal.consumed:
                return self._responses.get(attempt, self.rejected(request, "Attempt already consumed; no retry"))
            if (request["source_id"], request["frame_id"]) in self.journal.frames:
                return self.rejected(request, "Frame already consumed")
            if self._busy:
                return self.rejected(request, "Another DJI attempt is in progress")
            if len(self.journal.consumed) >= self.max_attempts:
                return self.rejected(request, "Bridge attempt limit reached; start a new test journal")
            public = {k: request[k] for k in ("schema", "attempt_id", "frame_id", "source_id",
                      "capture_ns", "armed_ns", "age_ms", "offset_x", "width", "direction")}
            # Persist before opening the transport, including when the process later times out.
            self.journal.append("attempt_reserved", **public)
            self.journal.consumed.add(attempt)
            self.journal.frames.add((request["source_id"], request["frame_id"]))
            self._busy = True
        try:
            result = self.run_probe(request)
        except Exception as error:
            result = dict(status="error", message="Unexpected bridge failure; outcome uncertain; no retry",
                          bridge_error=str(error), before=None, after=None, settled=None)
        response = dict(attempt_id=attempt, frame_id=request["frame_id"], status=result["status"],
                        message=result["message"], yaw_before=(result.get("before") or {}).get("yaw"),
                        yaw_after=(result.get("settled") or result.get("after") or {}).get("yaw"))
        try:
            self.journal.append("attempt_result", attempt_id=attempt, frame_id=request["frame_id"], **result)
        except OSError:
            response.update(status="error", message="DJI result journal failed; outcome uncertain; no retry")
        finally:
            with self._lock:
                self._responses[attempt] = response
                self._busy = False
        return response


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, port, bridge):
        self.bridge = bridge
        super().__init__(("127.0.0.1", port), Handler)


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(3.0)
        try:
            raw = self.rfile.readline(MAX_REQUEST_BYTES + 1)
            if len(raw) > MAX_REQUEST_BYTES or not raw.endswith(b"\n"):
                response = dict(attempt_id=None, status="rejected", message="Invalid request length/framing")
            else:
                request = json.loads(raw, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
                response = self.server.bridge.handle(request)
        except (ValueError, UnicodeError, TimeoutError):
            response = dict(attempt_id=None, status="rejected", message="Invalid JSON request")
        try:
            self.wfile.write((json.dumps(response, allow_nan=False) + "\n").encode())
        except OSError:
            pass  # The consumed attempt remains in the journal after a disconnected client.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=18765)
    parser.add_argument("--token-file", required=True, type=Path)
    parser.add_argument("--journal", required=True, type=Path)
    parser.add_argument("--probe", required=True, type=Path)
    parser.add_argument("--weact-port", required=True)
    parser.add_argument("--max-attempts", type=int, default=1)
    args = parser.parse_args()
    token = args.token_file.read_text(encoding="utf-8").strip()
    journal = Journal(args.journal)
    bridge = Bridge(token, journal, ProbeRunner(args.probe.resolve(), args.weact_port), args.max_attempts)
    journal.append("bridge_started", listen="127.0.0.1", port=args.port, max_attempts=args.max_attempts,
                   yaw_direction="positive", step_degrees=3, max_android_age_ms=MAX_AGE_MS,
                   token_sha256=hashlib.sha256(token.encode()).hexdigest())
    try:
        with Server(args.port, bridge) as server:
            print(f"Listening on 127.0.0.1:{server.server_address[1]}; right = yaw +3 degrees", flush=True)
            server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        journal.close()


if __name__ == "__main__":
    main()
