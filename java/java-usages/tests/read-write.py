"""Run actual JDT LS + Lombok integration test. Arguments: jdtls home, lombok jar."""
import os
import hashlib
import zipfile
import json
import pathlib
import platform
import queue
import subprocess
import sys
import tempfile
import threading
import time

home, lombok = map(lambda p: pathlib.Path(p).resolve(), sys.argv[1:3])
bundle = pathlib.Path(__file__).resolve().parents[1] / 'openidea-java-usages.jar'
work = pathlib.Path(tempfile.mkdtemp(prefix='openidea-usages-'))
config = work / 'config'
config.mkdir()
system, machine = platform.system(), platform.machine().lower()
config_name = {'Windows': 'config_win', 'Darwin': 'config_mac'}.get(system, 'config_linux')
config_names = ([config_name + '_arm'] if machine in ('arm64', 'aarch64') else []) + [config_name]
config_source = next(home / name / 'config.ini' for name in config_names
                     if (home / name / 'config.ini').is_file())
(config / 'config.ini').write_bytes(config_source.read_bytes())
project = work / 'project'
project.mkdir()
(project / 'src').mkdir()
(project / '.project').write_text('<projectDescription><name>accessors</name><buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name></buildCommand></buildSpec><natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>')
(project / '.classpath').write_text(f'<classpath><classpathentry kind="src" path="src"/><classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/><classpathentry kind="lib" path="{lombok}"/><classpathentry kind="output" path="bin"/></classpath>')
source = (pathlib.Path(__file__).parent / 'ReadWrite.java').read_text()
index_stress = os.environ.get('OPENIDEA_USAGES_INDEX_STRESS') == '1'
if index_stress:
    # Keep the original nested/method-reference cases, but cross the index threshold
    # for both standard and fluent accessors without changing their expected rows.
    source = source[:-len(' }\n}\n')] + ('  b.getCount(); b.setCount(0); f.score(); f.score(0);' * 12) + '\n }\n}\n'
    source += 'class More extends Bean { void calls() { super.setCount(super.getCount()); } }\n'
file = project / 'src/Bean.java'
file.write_text(source)
log = (work / 'stderr.log').open('w')
proc = subprocess.Popen(['java', f'-javaagent:{lombok}', '-Declipse.application=org.eclipse.jdt.ls.core.id1', '-Dosgi.bundles.defaultStartLevel=4', '-Declipse.product=org.eclipse.jdt.ls.core.product', '-Xmx1G', '--add-modules=ALL-SYSTEM', '--add-opens', 'java.base/java.util=ALL-UNNAMED', '--add-opens', 'java.base/java.lang=ALL-UNNAMED', '-jar', str(next((home/'plugins').glob('org.eclipse.equinox.launcher_*.jar'))), '-configuration', str(config), '-data', str(work/'metadata')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log)
messages = queue.Queue()
lock = threading.Lock()
def send(message):
    data = json.dumps(message).encode()
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
            k,v = line.decode().split(':', 1)
            headers[k.lower()] = v.strip()
        message = json.loads(proc.stdout.read(int(headers['content-length'])))
        if 'method' in message and 'id' in message:
            send({'jsonrpc':'2.0', 'id':message['id'], 'result': [] if message['method']=='workspace/configuration' else None})
        else: messages.put(message)
threading.Thread(target=read, daemon=True).start()
seq = 0
transcript = []
def request(method, params):
    global seq
    seq += 1
    send({'jsonrpc':'2.0', 'id':seq, 'method':method, 'params':params})
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        msg = messages.get(timeout=max(1, deadline-time.monotonic()))
        transcript.append(msg)
        if msg.get('id') == seq:
            if 'error' in msg: raise RuntimeError(msg['error'])
            return msg.get('result')
    raise TimeoutError(method)
try:
    init = request('initialize', {'processId':None, 'rootUri':project.as_uri(), 'workspaceFolders':[{'uri':project.as_uri(), 'name':'accessors'}], 'capabilities':{}, 'initializationOptions':{'bundles':[str(bundle)], 'settings':{'java':{'references':{'includeAccessors':True}, 'import':{'gradle':{'enabled':False}, 'maven':{'enabled':False}}}}}})
    send({'jsonrpc':'2.0','method':'initialized','params':{}})
    send({'jsonrpc':'2.0','method':'textDocument/didOpen','params':{'textDocument':{'uri':file.as_uri(), 'languageId':'java','version':1,'text':source}}})
    request('java/buildWorkspace', True)
    evidence = {'workspace':str(work), 'source':source, 'lombokSha256':hashlib.sha256(lombok.read_bytes()).hexdigest(), 'lombokManifest':zipfile.ZipFile(lombok).read('META-INF/MANIFEST.MF').decode(), 'jdtls':next((home/'plugins').glob('org.eclipse.jdt.ls.core_*.jar')).name, 'commands':init.get('capabilities', {}).get('executeCommandProvider'), 'cases':{}}
    evidence['cases']={}
    for field in ['count','score','items','next']:
        line,text=next((i,t) for i,t in enumerate(source.splitlines()) if f'public int {field};' in t or f'public int[] {field};' in t or f'public Bean {field};' in t)
        col=text.index(field)
        evidence['cases'][field]=request('workspace/executeCommand',{'command':'openidea.java.usages','arguments':[file.as_uri(),line,col,False]})
    errors=[d for m in transcript if m.get('method')=='textDocument/publishDiagnostics' for d in m['params']['diagnostics'] if d.get('severity')==1]
    assert not errors, errors
    expected={8:['read'],9:['write'],10:['readWrite'],11:['readWrite'],12:['readWrite'],13:['read','write'],14:['read','write'],15:['read','write'],16:['unknown'],17:['unknown'],21:['write']}
    if index_stress:
        expected[22]=['read','write']*12
        expected[len(source.splitlines())-1]=['read','write']
    actual={}
    for row in evidence['cases']['count']:
        actual.setdefault(row['location']['range']['start']['line'],[]).append(row['access'])
    for line,accesses in expected.items(): assert sorted(actual.get(line,[]))==sorted(accesses),(line,actual)
    assert [r['access'] for r in evidence['cases']['items']]==['read'],evidence['cases']['items']
    assert [r['access'] for r in evidence['cases']['next']]==['read'],evidence['cases']['next']
    scores={}
    for row in evidence['cases']['score']: scores.setdefault(row['location']['range']['start']['line'],[]).append(row['access'])
    expected_scores={18:['read','write'],19:['read','write']}
    if index_stress: expected_scores[22]=sorted(['read','write']*12)
    assert {l:sorted(a) for l,a in scores.items()}==expected_scores,scores
    # Exercise the real JSON-RPC cancellation path separately from assertions
    # about successful responses. Send cancellation immediately after dispatch.
    line,text=next((i,t) for i,t in enumerate(source.splitlines()) if 'public int count;' in t)
    seq += 1
    send({'jsonrpc':'2.0','id':seq,'method':'workspace/executeCommand','params':{'command':'openidea.java.usages','arguments':[file.as_uri(),line,text.index('count'),False]}})
    send({'jsonrpc':'2.0','method':'$/cancelRequest','params':{'id':seq}})
    deadline=time.monotonic()+30
    while True:
        message=messages.get(timeout=max(.1,deadline-time.monotonic()))
        transcript.append(message)
        if message.get('id')==seq:
            evidence['cancellation']=message
            assert message.get('error',{}).get('code') == -32800, message
            break
        assert time.monotonic()<deadline, 'Cancellation response timed out'
    evidence['assertions']='direct field read/write/readWrite, nested calls, inherited/interface, method references unknown, fluent, array/receiver reads passed'
    (work/'evidence.json').write_text(json.dumps(evidence, indent=2))
    print(json.dumps(evidence, indent=2))
finally:
    (work/'transcript.json').write_text(json.dumps(transcript, indent=2))
    proc.terminate()
    proc.wait(timeout=20)
    print('Evidence:', work, file=sys.stderr)
