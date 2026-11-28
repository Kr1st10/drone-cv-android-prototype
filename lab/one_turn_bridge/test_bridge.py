import importlib.util
import json
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import unittest
import uuid

spec = importlib.util.spec_from_file_location("one_turn_bridge", Path(__file__).with_name("bridge.py"))
bridge_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge_module)


def request(**changes):
    value = dict(schema=1, token="local-test-token", attempt_id=str(uuid.uuid4()), frame_id=12,
                 source_id=2, capture_ns="2000000000", armed_ns="1900000000", age_ms=1370.9,
                 offset_x=143.1, width=480, direction="right")
    value.update(changes)
    return value


SUCCESS_OUTPUT = """before seq=1 result=Reply(value=Angles(yawDegrees=-171.7, rollDegrees=0.0, pitchDegrees=30.2))
position_ack seq=32768 return_code=0
after seq=2 result=Reply(value=Angles(yawDegrees=-169.4, rollDegrees=0.0, pitchDegrees=30.2))
settled seq=3 result=Reply(value=Angles(yawDegrees=-169.2, rollDegrees=0.0, pitchDegrees=30.2))
nudge_pass
"""


class BridgeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.journal = bridge_module.Journal(Path(self.temp.name) / "attempts.ndjson")
        self.calls = []

    def tearDown(self):
        self.journal.close()
        self.temp.cleanup()

    def engine(self, execute=None, max_attempts=1):
        def run(value):
            self.calls.append(value)
            return dict(status="success", message="verified", before=dict(yaw=-171.7),
                        after=dict(yaw=-169.4), settled=dict(yaw=-169.2))
        return bridge_module.Bridge("local-test-token", self.journal, execute or run, max_attempts)

    def test_right_frame_runs_once_and_duplicate_reuses_result(self):
        engine = self.engine()
        value = request()
        first = engine.handle(value)
        self.assertEqual(first["status"], "success")
        self.assertEqual(first["yaw_before"], -171.7)
        self.assertEqual(first["yaw_after"], -169.2)
        self.assertEqual(engine.handle(value), first)
        self.assertEqual(len(self.calls), 1)
        rows = [json.loads(line) for line in self.journal.path.read_text().splitlines()]
        self.assertEqual([r["event"] for r in rows], ["attempt_reserved", "attempt_result"])
        self.assertNotIn("local-test-token", self.journal.path.read_text())

    def test_center_left_missing_target_old_frame_and_invalid_age_do_not_move(self):
        engine = self.engine()
        for changes in [dict(offset_x=0), dict(offset_x=48), dict(offset_x=-150),
                        dict(offset_x=None), dict(capture_ns="1800000000"), dict(age_ms=2500.001),
                        dict(age_ms=-1), dict(age_ms=float("nan")), dict(width=True), dict(token="wrong")]:
            with self.subTest(changes=changes):
                self.assertEqual(engine.handle(request(**changes))["status"], "rejected")
        self.assertEqual(self.calls, [])
        self.assertEqual(self.journal.consumed, set())

    def test_no_new_attempt_or_duplicate_frame_after_one_lifetime_attempt(self):
        engine = self.engine()
        engine.handle(request())
        self.assertEqual(engine.handle(request())["status"], "rejected")
        self.assertEqual(engine.handle(request(frame_id=13))["status"], "rejected")
        self.assertEqual(len(self.calls), 1)

    def test_restart_does_not_repeat_a_consumed_attempt(self):
        value = request()
        self.engine().handle(value)
        self.journal.close()
        other_journal = bridge_module.Journal(self.journal.path)
        try:
            other = bridge_module.Bridge("local-test-token", other_journal,
                                         lambda _: self.fail("Repeated transport after restart"))
            self.assertEqual(other.handle(value)["status"], "rejected")
        finally:
            other_journal.close()

    def test_two_process_owners_cannot_open_same_motion_journal(self):
        with self.assertRaises(BlockingIOError):
            bridge_module.Journal(self.journal.path)

    def test_explicit_second_press_can_use_a_new_frame_when_configured(self):
        engine = self.engine(max_attempts=2)
        self.assertEqual(engine.handle(request())["status"], "success")
        self.assertEqual(engine.handle(request(frame_id=13))["status"], "success")
        self.assertEqual(len(self.calls), 2)

    def test_timeout_consumes_attempt_and_does_not_retry(self):
        def failed(command, **options):
            self.calls.append(command)
            self.assertEqual(options["timeout"], 10.0)
            raise subprocess.TimeoutExpired(command, options["timeout"], output=SUCCESS_OUTPUT.split("after")[0])
        probe = bridge_module.ProbeRunner("/fake/dji-rs-probe", "/fake/usb", runner=failed)
        engine = self.engine(execute=probe)
        value = request()
        self.assertEqual(engine.handle(value)["status"], "timeout")
        self.assertEqual(engine.handle(value)["status"], "timeout")
        self.assertEqual(len(self.calls), 1)

    def test_probe_is_fixed_to_one_positive_yaw_nudge_and_saves_angles(self):
        def fake(command, **options):
            self.calls.append(command)
            return subprocess.CompletedProcess(command, 0, SUCCESS_OUTPUT, "")
        probe = bridge_module.ProbeRunner("/fake/dji-rs-probe", "/fake/usb", runner=fake)
        result = probe(request())
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["before"]["yaw"], -171.7)
        self.assertEqual(result["settled"]["yaw"], -169.2)
        self.assertEqual(len(self.calls), 1)
        command = self.calls[0]
        self.assertEqual(command[1], "nudge")
        self.assertEqual(command[command.index("--axis") + 1], "yaw")
        self.assertEqual(command[command.index("--direction") + 1], "positive")

    def test_busy_rejects_other_attempt_and_duplicate_while_running(self):
        entered, leave = threading.Event(), threading.Event()
        def blocking(value):
            self.calls.append(value)
            entered.set()
            leave.wait(2)
            return dict(status="success", message="verified")
        engine = self.engine(execute=blocking, max_attempts=2)
        value = request()
        thread = threading.Thread(target=engine.handle, args=(value,))
        thread.start()
        self.assertTrue(entered.wait(1))
        try:
            self.assertEqual(engine.handle(request(frame_id=13))["status"], "rejected")
            self.assertEqual(engine.handle(value)["status"], "rejected")
        finally:
            leave.set()
            thread.join()
        self.assertEqual(len(self.calls), 1)

    def test_real_loopback_socket_reads_one_line_and_returns_correlated_result(self):
        engine = self.engine()
        with bridge_module.Server(0, engine) as server:
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            try:
                value = request()
                with socket.create_connection(server.server_address, timeout=1) as connection:
                    connection.sendall((json.dumps(value) + "\n").encode())
                    response = json.loads(connection.makefile("rb").readline())
                self.assertEqual(response["attempt_id"], value["attempt_id"])
                self.assertEqual(response["status"], "success")
                self.assertEqual(len(self.calls), 1)
            finally:
                server.shutdown()
                thread.join()


if __name__ == "__main__":
    unittest.main()
