"""Build the committed jar: python3 build.py /path/to/apache-maven-3.9.11 [--record-dependencies].

One jar, two parts, Java 8 bytecode:
- `src`: the resident javac server (`ai.openidea.javac.Server`), JDK classes only.
- `maven`: the prepare run's Maven extension (`ai.openidea.javac.maven.BuildModel`), compiled
  against Maven 3.9.11's API jars, pinned by build-dependencies.sha256.
Archive order and timestamps are deterministic. Use a JDK that still compiles `--release 8`."""
import hashlib
import os
import pathlib
import subprocess
import sys
import tempfile
import zipfile

root = pathlib.Path(__file__).resolve().parent
maven = pathlib.Path(sys.argv[1]).resolve()
jars = sorted((maven / 'lib').glob('*.jar')) + sorted((maven / 'boot').glob('*.jar'))
actual = ''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  maven/{p.name}\n' for p in jars)
if '--record-dependencies' in sys.argv:
    (root / 'build-dependencies.sha256').write_text(actual)
if (root / 'build-dependencies.sha256').read_text() != actual:
    sys.exit('Build dependencies differ from build-dependencies.sha256')
java_home = os.environ.get('JAVA_HOME')
javac = str(pathlib.Path(java_home) / 'bin' / 'javac') if java_home else 'javac'
with tempfile.TemporaryDirectory() as output:
    for source, classpath in [('src', []), ('maven', jars)]:
        subprocess.run([javac, '--release', '8', '-Xlint:-options', '-proc:none', '-encoding', 'UTF-8', '-g',
                        '-classpath', os.pathsep.join(map(str, classpath)), '-d', output,
                        *map(str, sorted((root / source).rglob('*.java')))], check=True)
    files = {p.relative_to(output).as_posix(): p.read_bytes() for p in pathlib.Path(output).rglob('*.class')}
    files['META-INF/sisu/javax.inject.Named'] = b'ai.openidea.javac.maven.BuildModel\n'
    files['META-INF/MANIFEST.MF'] = b'Manifest-Version: 1.0\nMain-Class: ai.openidea.javac.Server\n\n'
    staged = root / 'openidea-java-build.jar.pending'
    with zipfile.ZipFile(staged, 'w', zipfile.ZIP_DEFLATED) as jar:
        for name, data in sorted(files.items()):
            jar.writestr(zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0)), data)
    staged.replace(root / 'openidea-java-build.jar')
