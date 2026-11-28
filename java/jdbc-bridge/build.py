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
parser.add_argument("--duckdb-jar", type=Path, help="run the real DuckDB pipe tests with this existing JDBC jar")
args = parser.parse_args()
if args.duckdb_jar and not args.test:
    parser.error("--duckdb-jar requires --test")
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
        if args.duckdb_jar:
            classpath = os.pathsep.join((str(classes), str(args.duckdb_jar.resolve(strict=True))))
            subprocess.run([tool("java"), "-ea", "-cp", classpath, "ai.openidea.jdbc.DuckDbSelfTest"],
                           check=True, timeout=45)
    if not args.test or args.out:
        with zipfile.ZipFile(args.out or root / "openidea-jdbc-bridge.jar", "w") as jar:
            for path in sorted(classes.rglob("SelfTest*.class" if args.test else "*.class")):
                entry = zipfile.ZipInfo(path.relative_to(classes).as_posix(), (2026, 1, 1, 0, 0, 0))
                jar.writestr(entry, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED)
