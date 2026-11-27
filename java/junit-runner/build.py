"""Build the committed JUnit Platform runner (Java 8 bytecode), or test it: python3 build.py [--test].

Compiles against the JUnit jars of build-dependencies.sha256, taken from the local Maven
repository (MAVEN_REPO, default ~/.m2/repository; `mvn dependency:get` fetches a missing one).
--test runs tests/SampleTest.java through the runner and checks its service messages."""
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import zipfile

root = Path(__file__).resolve().parent
repo = Path(os.environ.get("MAVEN_REPO", Path.home() / ".m2" / "repository"))
java_home = os.environ.get("JAVA_HOME")
test = "--test" in sys.argv[1:]


def tool(name):
    return str(Path(java_home) / "bin" / name) if java_home else name


jars = []
for line in (root / "build-dependencies.sha256").read_text().splitlines():
    digest, path = line.split()
    jar = repo / path
    if hashlib.sha256(jar.read_bytes()).hexdigest() != digest:
        sys.exit(f"{jar}: SHA-256 mismatch")
    jars.append(str(jar))
# The launcher API and JUnit 4 only: the runner must not depend on an engine.
api = [j for j in jars if "/junit-platform-" in j or "apiguardian" in j or "/junit/junit/" in j]

with tempfile.TemporaryDirectory() as scratch:
    classes = Path(scratch) / "classes"
    sources = sorted((root / "src").rglob("*.java"))
    subprocess.run([tool("javac"), "--release", "8", "-encoding", "UTF-8", "-g", "-Xlint:-options",
                    "-cp", os.pathsep.join(api), "-d", str(classes), *map(str, sources)], check=True)
    if test:
        sample = Path(scratch) / "sample"
        cp = os.pathsep.join(jars)
        subprocess.run([tool("javac"), "-encoding", "UTF-8", "-cp", cp, "-d", str(sample),
                        str(root / "tests" / "SampleTest.java"), str(root / "tests" / "Junit4SampleTest.java")], check=True)
        run = subprocess.run([tool("java"), "-cp", os.pathsep.join([str(classes), str(sample), cp]),
                              "ai.openidea.junit.Runner", "sample.SampleTest"], capture_output=True)
        out = run.stdout.decode("utf-8")
        print(out)
        expected = [
            "##teamcity[testStarted name='passes' className='sample.SampleTest']",
            "##teamcity[testStdOut name='passes' className='sample.SampleTest' out='hello |[ünï|]|n']",
            "##teamcity[testFailed name='fails' className='sample.SampleTest' message='org.opentest4j.AssertionFailedError: it|'s wrong ==> expected: <1> but was: <2>'",
            "##teamcity[testIgnored name='disabled' className='sample.SampleTest'",
            "##teamcity[testIgnored name='aborted' className='sample.SampleTest']",
            "##teamcity[testFailed name='parameterized' className='sample.SampleTest'",
            "##teamcity[testFinished name='nested' className='sample.SampleTest$Inner' duration=",
            "7 tests completed, 2 failed, 2 skipped",
        ]
        missing = [e for e in expected if e not in out]
        assert not missing, missing
        assert run.returncode == 1, run.returncode
        method = subprocess.run([tool("java"), "-cp", os.pathsep.join([str(classes), str(sample), cp]),
                                 "ai.openidea.junit.Runner", "sample.SampleTest#parameterized"], capture_output=True)
        assert method.stdout.decode().count("testStarted") == 2, method.stdout
        # JUnit 4 runs on JUnitCore, with the JUnit Platform on the classpath (no Vintage engine) and without it.
        junit4 = [j for j in jars if "/junit/junit/" in j or "hamcrest" in j]
        for classpath in (cp, os.pathsep.join(junit4)):
            run4 = lambda *tests: subprocess.run([tool("java"), "-cp", os.pathsep.join([str(classes), str(sample), classpath]),
                                                  "ai.openidea.junit.Runner", *tests], capture_output=True)
            four = run4("sample.Junit4SampleTest", "sample.Junit4SampleTest$Params", "sample.Junit4SampleTest$Broken")
            out = four.stdout.decode("utf-8")
            print(out)
            expected = [
                "##teamcity[testStarted name='passes' className='sample.Junit4SampleTest']",
                "##teamcity[testStdOut name='passes' className='sample.Junit4SampleTest' out='hello |[ünï|]|n']",
                "##teamcity[testFailed name='fails' className='sample.Junit4SampleTest' message='java.lang.AssertionError: it|'s wrong expected:<1> but was:<2>'",
                "##teamcity[testIgnored name='ignored' className='sample.Junit4SampleTest' message='later']",
                "##teamcity[testIgnored name='assumed' className='sample.Junit4SampleTest'",
                "##teamcity[testFailed name='parameterized|[1|]' className='sample.Junit4SampleTest$Params'",
                "##teamcity[testFailed name='initializationError' className='sample.Junit4SampleTest$Broken' message='java.lang.IllegalStateException: no database'",
                "9 tests completed, 3 failed, 2 skipped",
            ]
            missing = [e for e in expected if e not in out]
            assert not missing, missing
            assert "at ai.openidea.junit." not in out, out
            assert four.returncode == 1, four.returncode
            method = run4("sample.Junit4SampleTest$Params#parameterized").stdout.decode()
            assert method.count("testStarted") == 2 and "other" not in method, method
            single = run4("sample.Junit4SampleTest#passes")
            assert single.returncode == 0 and "1 test completed" in single.stdout.decode(), single.stdout
        print("ok")
        sys.exit(0)
    with zipfile.ZipFile(root / "openidea-junit-runner.jar", "w") as jar:
        for path in sorted(classes.rglob("*.class")):
            entry = zipfile.ZipInfo(path.relative_to(classes).as_posix(), (2026, 1, 1, 0, 0, 0))
            jar.writestr(entry, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED)
