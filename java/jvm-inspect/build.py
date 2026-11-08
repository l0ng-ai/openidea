"""Reproducible bundle build: python3 build.py /path/to/jdtls [--test] (JDT LS 1.63.0, Java 25; target Java 21).

--test compiles tests/SelfTest.java with the sources and runs it; it does not write the jar."""
import os
import pathlib
import subprocess
import sys
import tempfile
import zipfile

def run(command):
    code = subprocess.run(command).returncode
    if code:
        sys.exit(f'{command[-1]} failed with exit status {code}')


root = pathlib.Path(__file__).resolve().parent
test = '--test' in sys.argv[1:]
plugins = pathlib.Path(next(a for a in sys.argv[1:] if a != '--test')).resolve() / 'plugins'
with tempfile.TemporaryDirectory() as tmp:
    tmp = pathlib.Path(tmp)
    # org.eclipse.jdt.debug ships the JDI model as a nested jar, which javac cannot read in place.
    with zipfile.ZipFile(next(plugins.glob('org.eclipse.jdt.debug_*.jar'))) as debug:
        (tmp / 'jdimodel.jar').write_bytes(debug.read('jdimodel.jar'))
    classpath = [str(p) for p in sorted(plugins.glob('*.jar'))] + [str(tmp / 'jdimodel.jar')]
    out = tmp / 'classes'
    sources = sorted((root / 'src').rglob('*.java')) + ([root / 'tests' / 'SelfTest.java'] if test else [])
    run(['java', '-cp', str(plugins / '*'),
         'org.eclipse.jdt.internal.compiler.batch.Main', '-21', '-proc:none',
         '-classpath', os.pathsep.join(classpath),
         '-d', str(out), *[str(p) for p in sources]])
    if test:
        run(['java', '-cp', os.pathsep.join([str(out), *classpath]), 'ai.openidea.jvminspect.SelfTest'])
        sys.exit(0)
    with zipfile.ZipFile(root / 'openidea-jvm-inspect.jar', 'w', zipfile.ZIP_DEFLATED) as jar:
        files = {'META-INF/MANIFEST.MF': root / 'MANIFEST.MF', 'plugin.xml': root / 'plugin.xml'}
        files.update({p.relative_to(out).as_posix(): p for p in out.rglob('*.class')})
        for name, path in sorted(files.items()):
            jar.writestr(zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0)), path.read_bytes())
