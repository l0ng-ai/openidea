"""Build the committed Java 17 JDBC bridge, or run its standalone protocol tests."""
import argparse
import os
from pathlib import Path
import subprocess
import tempfile
import zipfile

root = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--test", action="store_true")
parser.add_argument("--out", type=Path, help="output JAR (with --test: the fixture driver for JDBC_FIXTURE_JAR)")
args = parser.parse_args()
java_home = os.environ.get("JAVA_HOME")
def tool(name):
    return str(Path(java_home) / "bin" / name) if java_home else name

with tempfile.TemporaryDirectory() as scratch:
    classes = Path(scratch) / "classes"
    classes.mkdir()
    sources = sorted((root / "src").rglob("*.java"))
    if args.test:
        sources += sorted((root / "tests").glob("*.java"))
    subprocess.run([tool("javac"), "--release", "17", "-encoding", "UTF-8", "-g:none",
                    "-d", classes, *sources], check=True)
    if args.test:
        subprocess.run([tool("java"), "-ea", "-cp", classes, "ai.openidea.jdbc.SelfTest"], check=True, timeout=45)
    if not args.test or args.out:
        with zipfile.ZipFile(args.out or root / "openidea-jdbc-bridge.jar", "w") as jar:
            for path in sorted(classes.rglob("SelfTest*.class" if args.test else "*.class")):
                entry = zipfile.ZipInfo(path.relative_to(classes).as_posix(), (2026, 1, 1, 0, 0, 0))
                jar.writestr(entry, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED)
