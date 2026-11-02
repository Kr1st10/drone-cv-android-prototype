#!/usr/bin/env bash
# Run the SAME APKs built and verified by assemble-debug; no second model export/build.
set -euo pipefail
trap 'adb logcat -d > instrumentation-logcat.txt || true' EXIT
adb install -r device-apks/app/app-debug.apk
adb install -r device-apks/test/app-debug-androidTest.apk
adb logcat -c
adb shell am instrument -w -r ru.university.dronecv.test/androidx.test.runner.AndroidJUnitRunner 2>&1 | tee instrumentation.txt
# am instrument can return exit 0 for a test failure: assert the runner's terminal success too.
grep -Eq '^OK \([0-9]+ tests?\)' instrumentation.txt
! grep -Eq 'FAILURES|INSTRUMENTATION_FAILED|Process crashed|shortMsg=' instrumentation.txt
