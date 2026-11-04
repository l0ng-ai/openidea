"""Compile and run builder regressions with javac and the compiler shipped by JDT LS.

Usage: python3 plugins/lombok/tests/verify.py /path/to/jdtls /path/to/lombok.jar
Requires a JDK 21+ on PATH. All generated files stay in a temporary directory.
"""

import os
import pathlib
import subprocess
import sys
import tempfile


def main():
    home, lombok = (pathlib.Path(p).resolve() for p in sys.argv[1:3])
    ecj, = (home / "plugins").glob("org.eclipse.jdt.core.compiler.batch_*.jar")
    source = pathlib.Path(__file__).with_name("BuilderCompactConstructor.java")
    with tempfile.TemporaryDirectory(prefix="openidea-lombok-builders-") as tmp:
        for compiler in ("javac", "ecj"):
            output = pathlib.Path(tmp) / compiler
            output.mkdir()
            if compiler == "javac":
                command = ["javac", "--release", "21", "-processorpath", str(lombok)]
            else:
                command = ["java", f"-javaagent:{lombok}", "-jar", str(ecj), "-21"]
            subprocess.run(command + ["-cp", str(lombok), "-d", str(output), str(source)], check=True)
            subprocess.run(["java", "-ea", "-cp", os.pathsep.join((str(output), str(lombok))),
                            "BuilderCompactConstructor"], check=True)
            print(f"{compiler}: builder regression assertions passed", flush=True)


if __name__ == "__main__":
    main()
