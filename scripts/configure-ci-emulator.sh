#!/usr/bin/env bash
# CI-only correction for API 29 AOSP's early-zygote 16 MiB heap on our 2 GiB AVD.
# Android 10's phone-xhdpi-2048-dalvik-heap.mk uses 192m growth / 512m maximum:
# https://android.googlesource.com/platform/frameworks/native/+/android10-release/build/phone-xhdpi-2048-dalvik-heap.mk
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true ]] || { echo 'Only configure the GitHub CI emulator'; exit 1; }
[[ $(adb shell getprop ro.kernel.qemu | tr -d '\r') == 1 ]] || { echo 'Expected an emulator'; exit 1; }
[[ $(adb shell getprop ro.build.version.sdk | tr -d '\r') == 29 ]] || { echo 'Expected API 29'; exit 1; }

record_heap() {
    for property in dalvik.vm.heapstartsize dalvik.vm.heapgrowthlimit dalvik.vm.heapsize; do
        echo "$property=$(adb shell getprop "$property" | tr -d '\r')"
    done
}
{ echo 'Before CI configuration'; record_heap; } | tee emulator-environment.txt
# Fail on a changed image instead of silently tuning an unknown environment.
[[ $(adb shell getprop dalvik.vm.heapsize | tr -d '\r') == 512m ]] || { echo 'Unexpected maximum heap'; exit 1; }
case $(adb shell getprop dalvik.vm.heapgrowthlimit | tr -d '\r') in
    ''|16m)
        # This image has no growth-limit property. AndroidRuntime falls back to 16m
        # if zygote starts before ranchu's on-boot action sets heapsize to 512m.
        adb root
        adb wait-for-device
        adb shell stop
        adb shell setprop dalvik.vm.heapgrowthlimit 192m
        adb shell setprop sys.boot_completed 0
        adb shell start
        # New apps inherit ART options from the restarted zygote, not the old one.
        timeout 120 bash -c 'until [[ $(adb shell getprop sys.boot_completed | tr -d "\r") == 1 ]]; do sleep 1; done'
        ;;
    192m) ;; # Already configured, e.g. when reusing an AVD in this job.
    *) echo 'Unexpected normal-app heap limit; inspect the image'; exit 1 ;;
esac
# Repeat emulator-runner's unlock after restarting the Android framework.
adb shell input keyevent 82
{ echo 'After CI configuration / Android restart'; record_heap; } | tee -a emulator-environment.txt
[[ $(adb shell getprop dalvik.vm.heapgrowthlimit | tr -d '\r') == 192m ]]
