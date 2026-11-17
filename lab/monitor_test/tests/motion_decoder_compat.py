#!/usr/bin/env python3
"""Compile the unmodified production Kotlin decoder and check a site-rendered PNG.

python3 lab/monitor_test/tests/motion_decoder_compat.py frame.png 12345678 42
Use expected_run_id 'none' for images without a valid sync or with duplicates.
Uses cached Kotlin 2.0.21 compiler jars; does not invoke Gradle or edit Android.
"""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('png', type=Path)
    parser.add_argument('expected_run_id')
    parser.add_argument('expected_step_id', type=int)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[3]
    cache = Path(os.environ.get('GRADLE_USER_HOME', Path.home() / '.gradle')) / 'caches/modules-2/files-2.1'
    def jar(group, name, version):
        found = list((cache / group / name / version).glob('*/*.jar'))
        if not found:
            raise SystemExit(f'Missing cached {name} {version}; run the normal project dependency setup first.')
        return str(found[0])
    compiler = jar('org.jetbrains.kotlin', 'kotlin-compiler-embeddable', '2.0.21')
    stdlib = jar('org.jetbrains.kotlin', 'kotlin-stdlib', '2.0.21')
    classpath = [compiler, stdlib, jar('org.jetbrains.kotlin', 'kotlin-script-runtime', '2.0.21'),
                 jar('org.jetbrains.kotlin', 'kotlin-reflect', '1.6.10'),
                 jar('org.jetbrains.kotlin', 'kotlin-daemon-embeddable', '2.0.21'),
                 jar('org.jetbrains.intellij.deps', 'trove4j', '1.0.20200330'),
                 jar('org.jetbrains.kotlinx', 'kotlinx-coroutines-core-jvm', '1.6.4'),
                 jar('org.jetbrains', 'annotations', '13.0')]
    studio = Path('/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java')
    java = str(Path(os.environ['JAVA_HOME']) / 'bin/java') if os.environ.get('JAVA_HOME') else str(studio) if studio.exists() else shutil.which('java')
    if not java:
        raise SystemExit('JDK is unavailable.')
    with tempfile.TemporaryDirectory(prefix='motion-decoder-') as temporary:
        output = Path(temporary) / 'classes'
        subprocess.run([java, '-cp', os.pathsep.join(classpath), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
                        '-no-stdlib', '-no-reflect', '-classpath', stdlib, '-d', str(output),
                        str(repo / 'app/src/main/java/ru/university/dronecv/motion/MotionMarkerDecoder.kt'),
                        str(repo / 'app/src/main/java/ru/university/dronecv/detection/yolo/ArgbImage.kt'),
                        str(Path(__file__).with_suffix('.kt'))], check=True)
        subprocess.run([java, '-Djava.awt.headless=true', '-cp', os.pathsep.join([str(output), stdlib]),
                        'ru.university.dronecv.motion.Motion_decoder_compatKt', str(args.png.resolve()),
                        args.expected_run_id, str(args.expected_step_id)], check=True)


if __name__ == '__main__':
    main()
