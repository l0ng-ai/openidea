"""Pull Members Up / Push Members Down against a real JDT LS. Argument: jdtls home.

Each case computes the edit from the same unchanged sources, applies it to a copy
of the project and compiles the copy with javac.
"""
import json
import pathlib
import platform
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse

home = pathlib.Path(sys.argv[1]).resolve()
bundle = pathlib.Path(__file__).resolve().parents[1] / 'openidea-java-usages.jar'
work = pathlib.Path(tempfile.mkdtemp(prefix='openidea-hierarchy-'))
config = work / 'config'
config.mkdir()
system, machine = platform.system(), platform.machine().lower()
config_name = {'Windows': 'config_win', 'Darwin': 'config_mac'}.get(system, 'config_linux')
config_names = ([config_name + '_arm'] if machine in ('arm64', 'aarch64') else []) + [config_name]
config_source = next(home / name / 'config.ini' for name in config_names if (home / name / 'config.ini').is_file())
(config / 'config.ini').write_bytes(config_source.read_bytes())
project = work / 'project'
(project / 'src/zoo').mkdir(parents=True)
(project / '.project').write_text('<projectDescription><name>zoo</name><buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name></buildCommand></buildSpec><natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>')
(project / '.classpath').write_text('<classpath><classpathentry kind="src" path="src"/><classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/><classpathentry kind="output" path="bin"/></classpath>')
sources = {
    'Animal.java': '''package zoo;

public abstract class Animal {
    protected String name = "animal";

    public String describe() {
        return "I am " + name;
    }
}
''',
    'Speaker.java': '''package zoo;

public interface Speaker {
}
''',
    'Dog.java': '''package zoo;

public class Dog extends Animal implements Speaker {
    private int tail = 1;

    public String bark() {
        return "Woof";
    }

    public int wag() {
        return tail * 2;
    }
}
''',
    'Cat.java': '''package zoo;

public class Cat extends Animal {
    public String purr() {
        return describe() + " purr";
    }
}
''',
    'Lonely.java': '''package zoo;

public class Lonely {
    public void alone() {
    }
}
''',
    'Use.java': '''package zoo;

public class Use {
    String run(Dog dog, Animal animal) {
        return dog.bark() + dog.wag() + animal.describe();
    }
}
''',
}
for name, text in sources.items():
    (project / 'src/zoo' / name).write_text(text)
uri = lambda name: (project / 'src/zoo' / name).as_uri()

log = (work / 'stderr.log').open('w')
proc = subprocess.Popen(['java', '-Declipse.application=org.eclipse.jdt.ls.core.id1', '-Dosgi.bundles.defaultStartLevel=4', '-Declipse.product=org.eclipse.jdt.ls.core.product', '-Xmx1G', '--add-modules=ALL-SYSTEM', '--add-opens', 'java.base/java.util=ALL-UNNAMED', '--add-opens', 'java.base/java.lang=ALL-UNNAMED', '-jar', str(next((home / 'plugins').glob('org.eclipse.equinox.launcher_*.jar'))), '-configuration', str(config), '-data', str(work / 'metadata')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log)
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
            if not line:
                return
            if line == b'\r\n':
                break
            k, v = line.decode().split(':', 1)
            headers[k.lower()] = v.strip()
        message = json.loads(proc.stdout.read(int(headers['content-length'])))
        if 'method' in message and 'id' in message:
            send({'jsonrpc': '2.0', 'id': message['id'], 'result': [] if message['method'] == 'workspace/configuration' else None})
        else:
            messages.put(message)


threading.Thread(target=read, daemon=True).start()
seq = 0


def request(method, params):
    global seq
    seq += 1
    send({'jsonrpc': '2.0', 'id': seq, 'method': method, 'params': params})
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        msg = messages.get(timeout=max(1, deadline - time.monotonic()))
        if msg.get('id') == seq:
            if 'error' in msg:
                raise RuntimeError(msg['error'])
            return msg.get('result')
    raise TimeoutError(method)


def position(name, needle):
    lines = sources[name].splitlines()
    line = next(i for i, t in enumerate(lines) if needle in t)
    return line, lines[line].index(needle)


def command(name, *args):
    return request('workspace/executeCommand', {'command': name, 'arguments': list(args)})


def members(file, needle, kind):
    line, col = position(file, needle)
    return command('openidea.java.hierarchy.members', uri(file), line, col, kind)


def refactor(file, needle, kind, target, choices):
    line, col = position(file, needle)
    return command('openidea.java.hierarchy.refactor', uri(file), line, col, kind, target, choices)


def offset(text, pos):
    lines = text.split('\n')
    return sum(len(l) + 1 for l in lines[:pos['line']]) + pos['character']


def apply(edit):
    """The project after `edit`, compiled; returns the edited sources."""
    per_file = {}
    for u, edits in (edit.get('changes') or {}).items():
        per_file.setdefault(u, []).extend(edits)
    for change in edit.get('documentChanges') or []:
        assert 'kind' not in change, change
        per_file.setdefault(change['textDocument']['uri'], []).extend(change['edits'])
    out = dict(sources)
    for u, edits in per_file.items():
        name = pathlib.Path(urllib.parse.unquote(urllib.parse.urlparse(u).path)).name
        text = out[name]
        for e in sorted(edits, key=lambda e: offset(text, e['range']['start']), reverse=True):
            text = text[:offset(text, e['range']['start'])] + e['newText'] + text[offset(text, e['range']['end']):]
        out[name] = text
    copy = work / f'compile{seq}'
    (copy / 'zoo').mkdir(parents=True)
    for name, text in out.items():
        (copy / 'zoo' / name).write_text(text)
    javac = subprocess.run(['javac', '-d', str(copy / 'bin'), *map(str, (copy / 'zoo').glob('*.java'))], capture_output=True, text=True)
    assert javac.returncode == 0, (javac.stderr, out)
    return out


def body(text, name):
    return [l.strip() for l in text.splitlines() if name in l]


try:
    init = request('initialize', {'processId': None, 'rootUri': project.as_uri(), 'workspaceFolders': [{'uri': project.as_uri(), 'name': 'zoo'}], 'capabilities': {'workspace': {'workspaceEdit': {'documentChanges': True}}}, 'initializationOptions': {'bundles': [str(bundle)], 'settings': {'java': {'import': {'gradle': {'enabled': False}, 'maven': {'enabled': False}}}}}})
    commands = init['capabilities']['executeCommandProvider']['commands']
    assert 'openidea.java.hierarchy.members' in commands and 'openidea.java.hierarchy.refactor' in commands, commands
    send({'jsonrpc': '2.0', 'method': 'initialized', 'params': {}})
    for name, text in sources.items():
        send({'jsonrpc': '2.0', 'method': 'textDocument/didOpen', 'params': {'textDocument': {'uri': uri(name), 'languageId': 'java', 'version': 1, 'text': text}}})
    request('java/buildWorkspace', True)
    evidence = {}

    # Members of Dog, with bark() preselected; Animal and Speaker are destinations.
    info = members('Dog.java', 'bark', 'pullUp')
    evidence['pullUpMembers'] = info
    assert info['className'] == 'Dog', info
    assert {t['name'] for t in info['targets']} == {'Animal', 'Speaker'}, info['targets']
    rows = {m['label'].split('(')[0].split(':')[0].strip(): m for m in info['members']}
    assert rows['bark']['selected'] and not rows['wag']['selected'] and not rows['tail']['selected'], rows
    assert rows['bark']['abstractable'] and rows['bark']['kind'] == 'method' and rows['tail']['kind'] == 'field', rows
    animal = next(t for t in info['targets'] if t['name'] == 'Animal')
    speaker = next(t for t in info['targets'] if t['name'] == 'Speaker')

    # Caret on the class name: nothing preselected.
    on_class = members('Dog.java', 'class Dog', 'pullUp')
    assert on_class['className'] == 'Dog' and not any(m['selected'] for m in on_class['members']), on_class

    # Pull bark() up to Animal: moved, call sites unchanged, compiles.
    result = refactor('Dog.java', 'bark', 'pullUp', animal['id'], [{'id': rows['bark']['id'], 'abstract': False}])
    evidence['pullUp'] = result
    assert not [p for p in result['problems'] if p['severity'] in ('error', 'fatal')], result['problems']
    out = apply(result['edit'])
    assert 'bark()' in out['Animal.java'] and 'bark()' not in out['Dog.java'], out
    assert out['Use.java'] == sources['Use.java']

    # Make abstract: declared in Animal, kept (and overridden) in Dog.
    result = refactor('Dog.java', 'bark', 'pullUp', animal['id'], [{'id': rows['bark']['id'], 'abstract': True}])
    evidence['pullUpAbstract'] = result
    out = apply(result['edit'])
    assert any('abstract' in l for l in body(out['Animal.java'], 'bark()')), out['Animal.java']
    assert 'Woof' in out['Dog.java'] and '@Override' in out['Dog.java'], out['Dog.java']

    # To an interface, a method is always declared, never moved.
    result = refactor('Dog.java', 'bark', 'pullUp', speaker['id'], [{'id': rows['bark']['id'], 'abstract': False}])
    evidence['pullUpInterface'] = result
    out = apply(result['edit'])
    assert body(out['Speaker.java'], 'bark()') == ['String bark();'] or body(out['Speaker.java'], 'bark()') == ['public String bark();'], out['Speaker.java']
    assert 'Woof' in out['Dog.java'] and '@Override' in out['Dog.java'], out['Dog.java']

    # wag() uses Dog's private field: reported before anything changes.
    result = refactor('Dog.java', 'wag', 'pullUp', animal['id'], [{'id': rows['wag']['id'], 'abstract': False}])
    evidence['pullUpConflict'] = result
    assert any(p['severity'] in ('error', 'fatal') and 'tail' in p['message'] for p in result['problems']), result

    # No superclass in the sources.
    refused = members('Lonely.java', 'alone', 'pullUp')
    evidence['pullUpRefused'] = refused
    assert 'refused' in refused, refused

    # Push describe() down: copied into Dog and Cat, removed from Animal.
    info = members('Animal.java', 'describe', 'pushDown')
    evidence['pushDownMembers'] = info
    assert info['className'] == 'Animal' and {t['name'] for t in info['targets']} == {'Dog', 'Cat'}, info
    rows = {m['label'].split('(')[0].split(':')[0].strip(): m for m in info['members']}
    assert rows['describe']['selected'] and rows['describe']['abstractable'] and not rows['name']['abstractable'], rows
    result = refactor('Animal.java', 'describe', 'pushDown', None, [{'id': rows['describe']['id'], 'abstract': True}])
    evidence['pushDownAbstract'] = result
    assert not [p for p in result['problems'] if p['severity'] in ('error', 'fatal')], result['problems']
    out = apply(result['edit'])
    assert any('abstract' in l for l in body(out['Animal.java'], 'describe()')), out['Animal.java']
    assert 'I am' in out['Dog.java'] and 'I am' in out['Cat.java'], out

    # Without keeping a declaration, Use's animal.describe() breaks: JDT reports it.
    result = refactor('Animal.java', 'describe', 'pushDown', None, [{'id': rows['describe']['id'], 'abstract': False}])
    evidence['pushDownConflict'] = result
    assert any(p['severity'] in ('error', 'fatal') for p in result['problems']), result

    (work / 'evidence.json').write_text(json.dumps(evidence, indent=2))
    print('hierarchy: all cases passed')
finally:
    proc.terminate()
    proc.wait(timeout=20)
    print('Evidence:', work, file=sys.stderr)
