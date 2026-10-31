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

home, lombok, bundle, output = map(lambda p: pathlib.Path(p).resolve(), sys.argv[1:5])
agent = pathlib.Path(sys.argv[5]).resolve() if len(sys.argv) > 5 else None
work = pathlib.Path(tempfile.mkdtemp(prefix='openidea-usages-'))
config = work / 'config'
config.mkdir()
(config / 'config.ini').write_bytes((home / 'config_linux/config.ini').read_bytes())
project = work / 'project'
project.mkdir()
(project / 'src').mkdir()
(project / '.project').write_text('<projectDescription><name>accessors</name><buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name></buildCommand></buildSpec><natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>')
(project / '.classpath').write_text(f'<classpath><classpathentry kind="src" path="src"/><classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/><classpathentry kind="lib" path="{lombok}"/><classpathentry kind="output" path="bin"/></classpath>')
source = 'import lombok.*;\nimport lombok.experimental.Accessors;\n@Data class Bean { public String name; }\n@Data @Accessors(fluent=false,chain=false) class Explicit { public String title; }\n@Data @Accessors(fluent=true,chain=true,prefix="m") class Fluent { public String mText; }\n@Data @Builder(builderClassName="Maker") class Built { public String value; static class Maker { private String value; public Maker value(String x) { value=x; return this; } } }\nclass Use {\n void many(Bean b, Explicit e, Fluent f, Built u) {\n'
source += ''.join('b.name = b.getName(); b.setName(b.name); e.title = e.getTitle(); e.setTitle(e.title); f.mText = f.text(); f.text(f.mText); u.value = u.getValue(); u.setValue(u.value); Built.builder().value(\"builder\").build();\n' for _ in range(150))
source += 'java.util.Comparator<String> cmp = String.CASE_INSENSITIVE_ORDER;\n}\n}\n'
all_lines=source.splitlines()
sources={}
for i,name in enumerate(['Bean','Explicit','Fluent','Built'],2):
    text='\n'.join(all_lines[:2]+[all_lines[i]])+'\n'
    path=project/'src'/f'{name}.java';path.write_text(text);sources[name]=path
source='\n'.join(all_lines[:2]+all_lines[6:])+'\n'
file = project / 'src/Use.java'
file.write_text(source)
log = (work / 'stderr.log').open('w')
proc = subprocess.Popen(['java', *([f'-javaagent:{agent}'] if agent else []), f'-javaagent:{lombok}', '-Declipse.application=org.eclipse.jdt.ls.core.id1', '-Dosgi.bundles.defaultStartLevel=4', '-Declipse.product=org.eclipse.jdt.ls.core.product', '-Xmx1G', '--add-modules=ALL-SYSTEM', '--add-opens', 'java.base/java.util=ALL-UNNAMED', '--add-opens', 'java.base/java.lang=ALL-UNNAMED', '-jar', str(next((home/'plugins').glob('org.eclipse.equinox.launcher_*.jar'))), '-configuration', str(config), '-data', str(work/'metadata')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log)
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
    init = request('initialize', {'processId':None, 'rootUri':project.as_uri(), 'workspaceFolders':[{'uri':project.as_uri(), 'name':'accessors'}], 'capabilities':{'textDocument':{'definition':{'linkSupport':False}}}, 'initializationOptions':{'bundles':[str(bundle)], 'extendedClientCapabilities':{'classFileContentsSupport':True}, 'settings':{'java':{'references':{'includeAccessors':True}, 'import':{'gradle':{'enabled':False}, 'maven':{'enabled':False}}}}}})
    send({'jsonrpc':'2.0','method':'initialized','params':{}})
    send({'jsonrpc':'2.0','method':'textDocument/didOpen','params':{'textDocument':{'uri':file.as_uri(), 'languageId':'java','version':1,'text':source}}})
    request('java/buildWorkspace', True)
    cases = {}
    for name, needle in [('plain','String name;'), ('explicit','String title;'), ('fluent','String mText;'), ('builder','String value;'), ('method','b.getName()')]:
        path = sources[{'plain':'Bean','explicit':'Explicit','fluent':'Fluent','builder':'Built'}[name]] if name != 'method' else file
        line, text = next((i,t) for i,t in enumerate(path.read_text().splitlines()) if needle in t)
        col = text.index(needle) + (7 if needle.startswith('String ') else 3)
        cases[name] = (path.as_uri(),line,col)
    evidence = {'workspace':str(work), 'source':source, 'jdtls':next((home/'plugins').glob('org.eclipse.jdt.ls.core_*.jar')).name, 'bundle':str(bundle), 'sources':{k:v.read_text() for k,v in sources.items()}, 'agent':str(agent), 'samples':{}, 'results':{}}
    def query(line,col,decl=False,uri=None):
        return request('workspace/executeCommand',{'command':'openidea.java.usages','arguments':[uri or file.as_uri(),line,col,decl]})
    def canonical(result):
        rows = result['rows'] if isinstance(result,dict) else result
        return sorted(rows,key=lambda r:json.dumps(r,sort_keys=True))
    # First plain query follows import/build in a fresh process. Remaining scenarios
    # are explicitly first-touch, not claimed to be globally cold.
    for name,(uri,line,col) in cases.items():
        samples=[]
        t=time.perf_counter_ns();result=query(line,col,uri=uri);samples.append((time.perf_counter_ns()-t)/1e6)
        evidence['results'][name]=result
        for i in range(5): query(line,col,uri=uri)
        for i in range(30):
            t=time.perf_counter_ns();again=query(line,col,uri=uri);samples.append((time.perf_counter_ns()-t)/1e6)
            assert canonical(again)==canonical(result), name
        evidence['samples'][name]={'first_ms':samples[0],'warm_ms':samples[1:]}
        standard=request('textDocument/references',{'textDocument':{'uri':uri},'position':{'line':line,'character':col},'context':{'includeDeclaration':False}})
        assert all(any(r['location']==loc for r in canonical(result)) for loc in standard), name
        evidence['results'][name+'-native']=standard
    uri,line,col=cases['plain']
    evidence['results']['includeDeclaration']=query(line,col,True,uri=uri)
    send({'jsonrpc':'2.0','method':'workspace/didChangeConfiguration','params':{'settings':{'java':{'references':{'includeAccessors':False}}}}})
    for name,(uri,line,col) in cases.items(): evidence['results'][name+'-accessorsOff']=query(line,col,uri=uri)
    send({'jsonrpc':'2.0','method':'workspace/didChangeConfiguration','params':{'settings':{'java':{'references':{'includeAccessors':True}}}}})
    line,text=next((i,t) for i,t in enumerate(source.splitlines()) if 'CASE_INSENSITIVE_ORDER' in t)
    definition=request('textDocument/definition',{'textDocument':{'uri':file.as_uri()},'position':{'line':line,'character':text.index('CASE_INSENSITIVE_ORDER')}})
    evidence['libraryDefinition']=definition
    if definition:
        loc=definition[0]
        if loc['uri'].startswith('jdt:'):
            content=request('java/classFileContents',{'uri':loc['uri']})
            evidence['libraryContent']=content
            evidence['results']['library']=query(loc['range']['start']['line'],loc['range']['start']['character'],uri=loc['uri'])
    # Retain diagnostics and response JSON, not only timing summaries.
    evidence['diagnostics']=[m for m in transcript if m.get('method')=='textDocument/publishDiagnostics']
    output.write_text(json.dumps(evidence,indent=2))
    print(output)
finally:
    (work/'transcript.json').write_text(json.dumps(transcript, indent=2))
    proc.terminate()
    proc.wait(timeout=20)
    print('Evidence:', work, file=sys.stderr)
