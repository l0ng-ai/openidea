"""Build with JDT LS 1.63.0 + Maven 3.9.11. Checksums pin every compiler dependency."""
import hashlib
import os
import pathlib
import subprocess
import sys
import tempfile
import zipfile

root = pathlib.Path(__file__).resolve().parent
jdt, maven = map(lambda p: pathlib.Path(p).resolve(), sys.argv[1:3])
jars = sorted((jdt / 'plugins').glob('*.jar')) + sorted((maven / 'lib').glob('*.jar'))
actual = ''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {"jdt/" if p.parent.name == "plugins" else "maven/"}{p.name}\n' for p in jars)
if '--record-dependencies' in sys.argv:
    (root / 'build-dependencies.sha256').write_text(actual)
if (root / 'build-dependencies.sha256').read_text() != actual:
    sys.exit('Build dependencies differ from build-dependencies.sha256')
with tempfile.TemporaryDirectory() as output:
    for source, target, classpath in [('src', '-21', jars[:len(list((jdt / 'plugins').glob('*.jar')))]), ('maven', '-8', jars)]:
        subprocess.run(['java', '-cp', str(jdt / 'plugins/*'), 'org.eclipse.jdt.internal.compiler.batch.Main', target, '-proc:none', '-classpath', os.pathsep.join(map(str, classpath)), '-d', output, *map(str, sorted((root/source).rglob('*.java')))], check=True)
    files = {'META-INF/MANIFEST.MF': root/'MANIFEST.MF', 'plugin.xml': root/'plugin.xml', 'META-INF/plexus/components.xml': root/'components.xml'}
    files.update({p.relative_to(output).as_posix(): p for p in pathlib.Path(output).rglob('*.class')})
    archive = pathlib.Path(output)/'bundle.jar'
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as jar:
        for name, path in sorted(files.items()):
            data = path.read_bytes()
            if name == 'META-INF/MANIFEST.MF':
                data = data.rstrip(b'\r\n') + b'\n\n'
            jar.writestr(zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0)), data)
    staged = root/'openidea-kotlin-bridge.jar.pending'
    staged.write_bytes(archive.read_bytes())
    staged.replace(root/'openidea-kotlin-bridge.jar')
