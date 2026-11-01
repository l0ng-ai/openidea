"""Reproducible bundle build: python3 build.py /path/to/jdtls (JDT LS 1.63.0, Java 25; target Java 21)."""
import os
import pathlib
import subprocess
import sys
import tempfile
import zipfile

root = pathlib.Path(__file__).resolve().parent
plugins = pathlib.Path(sys.argv[1]).resolve() / 'plugins'
with tempfile.TemporaryDirectory() as out:
    subprocess.run(['java', '-cp', str(plugins / '*'),
                    'org.eclipse.jdt.internal.compiler.batch.Main', '-21', '-proc:none',
                    '-classpath', os.pathsep.join(str(p) for p in sorted(plugins.glob('*.jar'))),
                    '-d', out, *[str(p) for p in sorted((root / 'src').rglob('*.java'))]], check=True)
    with zipfile.ZipFile(root / 'openidea-java-usages.jar', 'w', zipfile.ZIP_DEFLATED) as jar:
        files = {'META-INF/MANIFEST.MF': root / 'MANIFEST.MF', 'plugin.xml': root / 'plugin.xml'}
        files.update({str(p.relative_to(out)): p for p in pathlib.Path(out).rglob('*.class')})
        for name, path in sorted(files.items()):
            jar.writestr(zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0)), path.read_bytes())
