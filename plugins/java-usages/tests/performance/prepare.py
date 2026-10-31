"""Prepare original, optimized, and TEST-ONLY instrumented bundles. No downloads."""
import io
import pathlib
import shutil
import subprocess
import sys
import tarfile
import zipfile

root = pathlib.Path(__file__).resolve().parents[4]
home, output = (pathlib.Path(p).resolve() for p in sys.argv[1:3])
output.mkdir(parents=True, exist_ok=True)
archive = subprocess.check_output(['git', 'archive', '0dad7de27ffd680efd7467f2f6f3f60c693b7a0e', 'plugins/java-usages'], cwd=root)
with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
    tar.extractall(output / 'original-tree', filter='data')
shutil.copytree(output / 'original-tree/plugins/java-usages', output / 'baseline', dirs_exist_ok=True)
shutil.copytree(root / 'plugins/java-usages', output / 'optimized', dirs_exist_ok=True)
# Rebuild both uninstrumented variants with the same ECJ/JDK as the counters.
for variant in ['baseline', 'optimized']:
    subprocess.run(['python3', str(output / variant / 'build.py'), str(home)], check=True)
for variant in ['baseline', 'optimized', 'fallback']:
    source = output / ('optimized' if variant == 'fallback' else variant)
    target = output / (variant + '-count')
    shutil.copytree(source, target, dirs_exist_ok=True)
    path = target / 'src/ai/openidea/usages/UsagesCommand.java'
    text = path.read_text()
    text = text.replace('        String uri =', '        System.setProperty("probe.handler", "0"); System.setProperty("probe.engine", "0");\n        String uri =')
    text = text.replace('        return response;', '        return Map.of("rows", response, "handlerSearches", Integer.parseInt(System.getProperty("probe.handler", "0")), "engineSearches", Integer.parseInt(System.getProperty("probe.engine", "0")));')
    if variant == 'fallback':
        text = text.replace('31ff5a10c7d69d58c6a9b619ef17e3ec41b11b545751ba428618a76cc1341064', '0' * 64)
    path.write_text(text)
    subprocess.run(['python3', str(target / 'build.py'), str(home)], check=True)
agent = output / 'instrument'
agent.mkdir(exist_ok=True)
subprocess.run(['javac', '-cp', str(home / 'plugins/*'), '-d', str(agent), str(pathlib.Path(__file__).parent / 'SearchCounter.java')], check=True)
asm = next((home / 'plugins').glob('org.objectweb.asm_*.jar'))
with zipfile.ZipFile(agent / 'counter.jar', 'w') as jar:
    jar.writestr('META-INF/MANIFEST.MF', f'Manifest-Version: 1.0\nPremain-Class: SearchCounter\nClass-Path: {asm.as_uri()}\n\n')
    for path in agent.glob('*.class'):
        jar.write(path, path.name)
print(output)
