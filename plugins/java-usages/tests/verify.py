"""Run actual JDT LS + Lombok integration test. Arguments: jdtls home, lombok jar."""
import hashlib
import zipfile
import json
import pathlib
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
(config / 'config.ini').write_bytes((home / 'config_linux/config.ini').read_bytes())
project = work / 'project'
project.mkdir()
(project / 'src').mkdir()
(project / '.project').write_text('<projectDescription><name>accessors</name><buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name></buildCommand></buildSpec><natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>')
(project / '.classpath').write_text(f'<classpath><classpathentry kind="src" path="src"/><classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/><classpathentry kind="lib" path="{lombok}"/><classpathentry kind="output" path="bin"/></classpath>')
source = '''import lombok.Data;
@Data
class Bean {
    private String name;
    private boolean active;
    void direct() { name = "direct"; System.out.println(name); }
}
@Data
@lombok.experimental.Accessors(fluent=true, chain=true, prefix="m")
class Fluent {
    private String mTitle;
}
@Data
@lombok.experimental.Accessors(chain=true, prefix="m")
class Prefixed {
    private String mLabel;
}
class Manual {
    private int size;
    public int getSize() { return size; }
    public void setSize(int value) { size = value; }
    public void setSize(String unrelated) {}
}
class Child extends Manual {}
@Data
@lombok.experimental.Accessors(fluent=true)
class NotSetter {
    private String value;
    public int value(String x) { return 1; }
}
class Use {
    void unrelated(NotSetter n) { n.value("not a setter"); }
    void manual(Manual m, Child c) { m.setSize(m.getSize()); System.out.println(c.getSize()); m.setSize("unrelated"); }
    void prefixed(Prefixed p) { p.setLabel(p.getLabel()); }
    void fluent(Fluent f) { f.title(f.title()); }
    void calls(Bean b) { b.setName(b.getName()); b.setActive(b.isActive()); }
    java.util.function.Supplier<String> getter(Bean b) { return b::getName; }
    java.util.function.Consumer<String> setter(Bean b) { return b::setName; }
}
'''
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
    for field, expected in [('name',(2,2,2)), ('active',(1,1,0)), ('mTitle',(1,1,0)), ('mLabel',(1,1,0)), ('size',(2,1,2)), ('value',(0,0,0))]:
        line, text = next((i, t) for i,t in enumerate(source.splitlines()) if 'private ' in t and f' {field};' in t)
        col = text.index(field)
        before = request('textDocument/references', {'textDocument':{'uri':file.as_uri()},'position':{'line':line,'character':col},'context':{'includeDeclaration':False}})
        after = request('workspace/executeCommand', {'command':'openidea.java.usages','arguments':[file.as_uri(),line,col,False]})
        evidence['cases'][field] = {'before':before,'after':after}
        assert all(any(row['location'] == loc for row in after) for loc in before), 'lost standard references'
        kinds = [r['kind'] for r in after]
        assert kinds.count('getter') == expected[0], (field, kinds)
        assert kinds.count('setter') == expected[1], (field, kinds)
        assert kinds.count('field') == expected[2], (field, kinds)
    # Respect the existing global preference: the command must not switch it on.
    send({'jsonrpc':'2.0','method':'workspace/didChangeConfiguration','params':{'settings':{'java':{'references':{'includeAccessors':False}}}}})
    disabled = request('workspace/executeCommand', {'command':'openidea.java.usages','arguments':[file.as_uri(),3,19,False]})
    assert len(disabled) == 2 and all(r['kind'] == 'field' for r in disabled), disabled
    evidence['accessorsDisabled'] = disabled
    (work/'evidence.json').write_text(json.dumps(evidence, indent=2))
    print(json.dumps(evidence, indent=2))
finally:
    (work/'transcript.json').write_text(json.dumps(transcript, indent=2))
    proc.terminate()
    proc.wait(timeout=20)
    print('Evidence:', work, file=sys.stderr)
