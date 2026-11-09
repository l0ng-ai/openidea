"""Real Maven + JDT LS regression: python3 verify.py JDT_HOME (Java 25; Maven uses JAVA_HOME)."""
import json
import os
import pathlib
import platform
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import xml.etree.ElementTree as ET

home = pathlib.Path(sys.argv[1]).resolve()
bundle = pathlib.Path(__file__).resolve().parents[1] / 'openidea-kotlin-bridge.jar'
work = pathlib.Path(tempfile.mkdtemp(prefix='openidea-kotlin-bridge-', dir=os.environ.get('TMPDIR'))).resolve()
copied_bundle = work/'openidea-kotlin-bridge.jar'
shutil.copyfile(bundle, copied_bundle)
bundle = copied_bundle
projects = work / 'projects'
single = projects / 'single'
multi = projects / 'multi'
lib = multi / 'channel-lib'
app = multi / 'app'
for directory in [single, lib, app]:
    (directory / 'src/main/java/probe').mkdir(parents=True)
plugin = '''<build><plugins><plugin><groupId>org.jetbrains.kotlin</groupId><artifactId>kotlin-maven-plugin</artifactId><version>2.0.10</version><executions><execution><id>kotlin-compile</id><phase>process-sources</phase><goals><goal>compile</goal></goals><configuration><jvmTarget>1.8</jvmTarget><sourceDirs><sourceDir>src/main/java</sourceDir></sourceDirs></configuration></execution></executions></plugin><plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-compiler-plugin</artifactId><version>3.13.0</version></plugin></plugins></build>'''
plugin = plugin.replace('</executions>', '<execution><id>kotlin-test</id><phase>process-test-sources</phase><goals><goal>test-compile</goal></goals><configuration><jvmTarget>1.8</jvmTarget><sourceDirs><sourceDir>src/test/java</sourceDir></sourceDirs></configuration></execution></executions>')
stdlib = '<dependencies><dependency><groupId>org.jetbrains.kotlin</groupId><artifactId>kotlin-stdlib</artifactId><version>2.0.10</version></dependency></dependencies>'
properties = '<properties><maven.compiler.source>8</maven.compiler.source><maven.compiler.target>8</maven.compiler.target></properties>'
prefix = '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion>'
(single / 'pom.xml').write_text(prefix + '<groupId>probe</groupId><artifactId>single</artifactId><version>1</version>' + properties + stdlib + plugin + '</project>')
(multi / 'pom.xml').write_text(prefix + '<groupId>probe</groupId><artifactId>reactor</artifactId><version>1</version><packaging>pom</packaging>' + properties + '<modules><module>channel-lib</module><module>app</module></modules></project>')
parent = '<parent><groupId>probe</groupId><artifactId>reactor</artifactId><version>1</version></parent>'
(lib / 'pom.xml').write_text(prefix + parent + '<artifactId>channel-lib</artifactId>' + stdlib + plugin + '</project>')
(app / 'pom.xml').write_text(prefix + parent + '<artifactId>app</artifactId><dependencies><dependency><groupId>probe</groupId><artifactId>channel-lib</artifactId><version>1</version></dependency></dependencies></project>')
source = 'package probe;\npublic class Caller {\n    public Channel channel() {\n        return Channel.SMS;\n    }\n}\n'
for directory in [single, app]:
    (directory / 'src/main/java/probe/Caller.java').write_text(source)
for directory in [single, lib]:
    (directory / 'src/main/java/probe/Channel.kt').write_text('package probe\nenum class Channel { SMS }\n')

(single/'src/test/java/probe').mkdir(parents=True)
test_source = source.replace('Caller', 'TestCaller').replace('Channel', 'TestChannel')
(single/'src/test/java/probe/TestCaller.java').write_text(test_source)
(single/'src/test/java/probe/TestChannel.kt').write_text('package probe\nenum class TestChannel { SMS }\n')

config = work / 'config'
config.mkdir()
base = {'Darwin': 'config_mac', 'Windows': 'config_win'}.get(platform.system(), 'config_linux')
names = [base + '_arm', base] if platform.machine().lower() in ('arm64', 'aarch64') else [base]
shutil.copyfile(next(home / n / 'config.ini' for n in names if (home/n/'config.ini').exists()), config/'config.ini')
proc = subprocess.Popen(['java', '-Declipse.application=org.eclipse.jdt.ls.core.id1', '-Dosgi.bundles.defaultStartLevel=4', '-Declipse.product=org.eclipse.jdt.ls.core.product', '-Xmx1G', '--add-modules=ALL-SYSTEM', '--add-opens', 'java.base/java.util=ALL-UNNAMED', '--add-opens', 'java.base/java.lang=ALL-UNNAMED', '-jar', str(next((home/'plugins').glob('org.eclipse.equinox.launcher_*.jar'))), '-configuration', str(config), '-data', str(work/'metadata')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=(work/'stderr.log').open('w'))
messages = queue.Queue()
lock = threading.Lock()
transcript = []
seq = 0
def send(message):
    data = json.dumps({'jsonrpc': '2.0', **message}).encode()
    with lock:
        proc.stdin.write(f'Content-Length: {len(data)}\r\n\r\n'.encode() + data)
        proc.stdin.flush()
def read():
    while True:
        headers = {}
        while True:
            line = proc.stdout.readline()
            if not line: return
            if line == b'\r\n': break
            key, value = line.decode().split(':', 1)
            headers[key.lower()] = value.strip()
        message = json.loads(proc.stdout.read(int(headers['content-length'])))
        if 'method' in message and 'id' in message:
            send({'id':message['id'], 'result': [] if message['method']=='workspace/configuration' else None})
        else:
            messages.put(message)
threading.Thread(target=read, daemon=True).start()
def request(method, params):
    global seq
    seq += 1
    send({'id':seq, 'method':method, 'params':params})
    deadline = time.monotonic() + 240
    while time.monotonic() < deadline:
        message = messages.get(timeout=max(1, deadline-time.monotonic()))
        transcript.append(message)
        if message.get('id') == seq:
            if 'error' in message: raise RuntimeError(message['error'])
            return message.get('result')
    raise TimeoutError(method)
def command(snapshot):
    response = request('workspace/executeCommand', {'command':'openidea.kotlin.replace', 'arguments':[snapshot]})
    assert isinstance(response, (int, float)), response
    return response
def build(directory, revision, expected=True):
    staging = work / revision
    result = subprocess.run(['mvn', '-B', '-fae', '-Dstyle.color=never', f'-Dmaven.ext.class.path={bundle}', f'-Dopenidea.kotlin.staging={staging}/staging', 'test-compile'], cwd=directory, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    (work/f'{revision}.log').write_bytes(result.stdout)
    modules = json.loads((staging/'modules.json').read_text())
    eligible = all(m['kotlinGoals'] and all(g['status'] == 'success' for g in m['kotlinGoals']) for m in modules if m['hasKotlin'])
    assert eligible == expected, (modules, result.stdout.decode())
    evidence[revision + '-build'] = {'exitCode':result.returncode, 'modules':modules, 'eligible':eligible}
    return modules
def library(module, revision, test=False, name="Channel"):
    directory = work/'published'/revision
    directory.mkdir(parents=True)
    output = module['testOutput' if test else 'output']
    for file in pathlib.Path(output).rglob('TestChannel*.class' if test else name+'*.class'):
        destination = directory/file.relative_to(output)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(file, destination)
    assert list(directory.rglob('*.class')), module
    return {'path':str(directory), 'test':test}
def state(directory, label, expected, test=False):
    file = directory/('src/test/java/probe/TestCaller.java' if test else 'src/main/java/probe/Caller.java')
    deadline = time.monotonic() + 30
    while True:
        time.sleep(0.25)
        request('workspace/symbol', {'query':'Caller'})
        reports = [m['params'] for m in transcript if m.get('method')=='textDocument/publishDiagnostics' and m['params']['uri']==file.as_uri()]
        errors = [d for d in reports[-1]['diagnostics'] if d.get('severity')==1] if reports else None
        if errors is not None and ((errors == []) == expected): break
        if time.monotonic() > deadline: raise AssertionError((label, errors))
    completion = request('textDocument/completion', {'textDocument':{'uri':file.as_uri()}, 'position':{'line':3,'character':27 if test else 23}})
    items = completion.get('items', []) if isinstance(completion, dict) else completion or []
    labels = [item['label'] for item in items]
    definition = request('textDocument/definition', {'textDocument':{'uri':file.as_uri()}, 'position':{'line':2,'character':12}})
    result = {'errors':errors, 'completion':labels, 'definition':definition}
    evidence[label] = result
    assert errors is not None, (label, "no published diagnostics")
    assert (errors == []) == expected, (label, errors)
    assert any(label.startswith('SMS') for label in labels) == expected, (label, labels)
    assert bool(definition) == expected, (label, definition)
    if expected:
        location = definition[0]
        assert location.get('uri', location.get('targetUri', '')).startswith('jdt:'), definition
    return result

evidence = {'work':str(work)}
try:
    init = request('initialize', {'processId':None, 'rootUri':projects.as_uri(), 'workspaceFolders':[{'uri':projects.as_uri(), 'name':'projects'}], 'capabilities':{'textDocument':{'completion':{'completionItem':{'snippetSupport':True}}, 'definition':{'linkSupport':True}}}, 'initializationOptions':{'bundles':[str(bundle)], 'extendedClientCapabilities':{'classFileContentsSupport':True}, 'settings':{'java':{'import':{'gradle':{'enabled':False}, 'maven':{'enabled':True}}, 'configuration':{'updateBuildConfiguration':'automatic'}}}}})
    send({'method':'initialized', 'params':{}})
    request('java/buildWorkspace', True)
    for directory, test in [(single,False), (app,False), (single,True)]:
        file = directory/('src/test/java/probe/TestCaller.java' if test else 'src/main/java/probe/Caller.java')
        send({'method':'textDocument/didOpen','params':{'textDocument':{'uri':file.as_uri(),'languageId':'java','version':1,'text':test_source if test else source}}})
    # Allow reconcile jobs to publish their first marker batch.
    time.sleep(2)
    state(single, 'single-before', False)
    state(app, 'multi-before', False)
    state(single, 'test-before', False, True)
    def raw(directory):
        entries = ET.parse(directory/'.classpath').getroot()
        return [ET.tostring(e).decode().strip() for e in entries if not any(a.get('name')=='ai.openidea.kotlin' for a in e.findall('./attributes/attribute'))]
    before = {str(d):raw(d) for d in [single, lib, app]}
    sm = build(single, 'single-build')[0]
    assert not (pathlib.Path(sm['output'])/'probe/TestCaller.class').exists()
    assert (pathlib.Path(sm['testOutput'])/'probe/TestCaller.class').is_file()
    mm = build(multi, 'multi-build')
    lm = next(m for m in mm if 'channel-lib' in m['key'])
    sl, ml = library(sm, 'single'), library(lm, 'multi')
    snapshot = [{'projectUri':single.as_uri(),'libraries':[sl, library(sm, 'single-test', True)]}, {'projectUri':lib.as_uri(),'libraries':[ml]}, {'projectUri':app.as_uri(),'libraries':[ml]}]
    command(snapshot)
    time.sleep(2)
    state(single, 'single-after', True)
    state(app, 'multi-after', True)
    state(single, 'test-after', True, True)
    assert all(raw(d) == before[str(d)] for d in [single,lib,app]), 'changed unowned entries'
    # Simulate m2e removing the extra entries during a configuration update.
    send({'method':'java/projectConfigurationsUpdate','params':{'identifiers':[{'uri':(d/'pom.xml').as_uri()} for d in [single,lib,app]]}})
    time.sleep(3)
    state(single, 'single-reimport', True)
    state(app, 'multi-reimport', True)
    assert all(raw(d) == before[str(d)] for d in [single,lib,app]), 'reimport changed unowned entries'
    # A saved API change must replace the immutable binary directory.
    (single/'src/main/java/probe/Channel.kt').write_text('package probe\nenum class Channel { SMS, EMAIL }\n')
    state(single, 'single-during-rebuild', True)
    changed = build(single, 'single-changed')[0]
    snapshot[0]['libraries'] = [library(changed, 'single-changed'), library(changed, 'single-test-changed', True)]
    command(snapshot)
    time.sleep(2)
    changed_state = state(single, 'single-new-enum-member', True)
    assert any(label.startswith('EMAIL') for label in changed_state['completion'])
    # Failed Kotlin compilation keeps both main and test APIs attached.
    (single/'src/main/java/probe/Channel.kt').write_text('package probe\nenum class Channel { ??? }\n')
    broken = build(single, 'single-broken', expected=False)[0]
    assert any(g['status'] == 'failed' for g in broken['kotlinGoals'])
    state(single, 'single-broken-retains-api', True)
    state(single, 'single-broken-retains-test-api', True, True)
    # A javac failure skips test Kotlin targets, so this whole snapshot is retained.
    (single/'src/main/java/probe/Channel.kt').write_text('package probe\nenum class Delivery { SMS }\n')
    skipped = build(single, 'single-skipped-test', expected=False)[0]
    assert any(g['execution'].endswith(':test-compile') and g['status'] == 'skipped' for g in skipped['kotlinGoals'])
    assert list(pathlib.Path(skipped['output']).rglob('Delivery.class'))
    state(single, 'single-skipped-test-retains-api', True)
    # The reactor fixture has no test Kotlin goal. Publish despite downstream javac failure.
    kt = lib/'src/main/java/probe/Channel.kt'
    kt.write_text('package probe\nenum class Delivery { SMS }\n')
    renamed = build(multi, 'multi-renamed')
    renamed_lib = next(m for m in renamed if 'channel-lib' in m['key'])
    new_library = library(renamed_lib, 'multi-renamed', name='Delivery')
    assert not list(pathlib.Path(renamed_lib['output']).rglob('Channel.class'))
    snapshot[1]['libraries'] = snapshot[2]['libraries'] = [new_library]
    command(snapshot)
    state(app, 'multi-renamed', False)
    kt.unlink()
    snapshot[1]['libraries'] = snapshot[2]['libraries'] = []
    command(snapshot)
    state(app, 'multi-deleted', False)
    kt.write_text('package probe\nenum class Channel { SMS }\n')
    restored = next(m for m in build(multi, 'multi-restored') if 'channel-lib' in m['key'])
    restored_library = library(restored, 'multi-restored')
    snapshot[1]['libraries'] = snapshot[2]['libraries'] = [restored_library]
    command(snapshot)
    state(app, 'multi-restored', True)
    (single/'src/main/java/probe/Channel.kt').write_text('package probe\nenum class Channel { SMS }\n')
    repaired = build(single, 'single-repaired')[0]
    snapshot[0]['libraries'] = [library(repaired, 'single-repaired'), library(repaired, 'single-test-repaired', True)]
    command(snapshot)
    time.sleep(2)
    state(single, 'single-repaired', True)
    # No old API after explicit invalidation, and recovery is repeatable.
    command([])
    time.sleep(2)
    state(single, 'single-withdrawn', False)
    state(app, 'multi-withdrawn', False)
    state(single, 'test-withdrawn', False, True)
    command(snapshot)
    time.sleep(2)
    state(single, 'single-recovered', True)
    state(app, 'multi-recovered', True)
    # Main sources must not gain visibility of test-only Kotlin libraries.
    leak = single/'src/main/java/probe/MainLeak.java'
    leak_source = test_source.replace('TestCaller', 'MainLeak')
    leak.write_text(leak_source)
    send({'method':'textDocument/didOpen','params':{'textDocument':{'uri':leak.as_uri(),'languageId':'java','version':1,'text':leak_source}}})
    deadline = time.monotonic() + 30
    while True:
        time.sleep(0.25)
        request('workspace/symbol', {'query':'MainLeak'})
        reports = [m['params'] for m in transcript if m.get('method')=='textDocument/publishDiagnostics' and m['params']['uri']==leak.as_uri()]
        if reports: break
        assert time.monotonic() < deadline, 'no diagnostics for main/test isolation'
    evidence['main-test-isolation'] = reports[-1]['diagnostics']
    assert any(d.get('severity') == 1 for d in reports[-1]['diagnostics']), reports[-1]
    # Compiler and JDT outputs must not share Kotlin classes.
    assert not list(single.glob('target/classes/**/Channel.class'))
    assert not list(lib.glob('target/classes/**/Channel.class'))
    # -fae runs independent Kotlin modules and records upstream-skipped targets.
    fail_reactor = work/'fail-at-end'
    fail_reactor.mkdir()
    (fail_reactor/'pom.xml').write_text(prefix + '<groupId>probe</groupId><artifactId>failure-reactor</artifactId><version>1</version><packaging>pom</packaging>' + properties + '<modules><module>broken-java</module><module>independent</module><module>downstream</module></modules></project>')
    failure_parent = '<parent><groupId>probe</groupId><artifactId>failure-reactor</artifactId><version>1</version></parent>'
    for name in ['broken-java', 'independent', 'downstream']:
        module = fail_reactor/name
        (module/'src/main/java/probe').mkdir(parents=True)
        dependency = '<dependencies><dependency><groupId>probe</groupId><artifactId>broken-java</artifactId><version>1</version></dependency><dependency><groupId>org.jetbrains.kotlin</groupId><artifactId>kotlin-stdlib</artifactId><version>2.0.10</version></dependency></dependencies>' if name == 'downstream' else stdlib
        (module/'pom.xml').write_text(prefix + failure_parent + '<artifactId>' + name + '</artifactId>' + dependency + plugin + '</project>')
        if name == 'broken-java':
            (module/'src/main/java/probe/Broken.java').write_text('package probe; public class Broken { Missing value; }')
        else:
            (module/'src/main/java/probe/Channel.kt').write_text('package probe\nenum class Channel { SMS }\n')
    statuses = build(fail_reactor, 'fail-at-end-statuses', expected=False)
    independent = next(m for m in statuses if ':independent:' in m['key'])
    downstream = next(m for m in statuses if ':downstream:' in m['key'])
    assert all(g['status'] == 'success' for g in independent['kotlinGoals']), independent
    assert all(g['status'] == 'skipped' for g in downstream['kotlinGoals']), downstream
    assert list(pathlib.Path(independent['output']).rglob('Channel.class'))
    print(json.dumps(evidence, indent=2))
finally:
    (work/'evidence.json').write_text(json.dumps(evidence, indent=2))
    (work/'transcript.json').write_text(json.dumps(transcript, indent=2))
    proc.terminate()
    proc.wait(timeout=20)
    print('Evidence:', work, file=sys.stderr)
