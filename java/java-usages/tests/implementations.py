"""Go to Implementation in project sources against a real JDT LS. Argument: jdtls home."""
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
work = pathlib.Path(tempfile.mkdtemp(prefix='openidea-implementations-'))
config = work / 'config'
config.mkdir()
system, machine = platform.system(), platform.machine().lower()
config_name = {'Windows': 'config_win', 'Darwin': 'config_mac'}.get(system, 'config_linux')
config_names = ([config_name + '_arm'] if machine in ('arm64', 'aarch64') else []) + [config_name]
config_source = next(home / name / 'config.ini' for name in config_names if (home / name / 'config.ini').is_file())
(config / 'config.ini').write_bytes(config_source.read_bytes())
project = work / 'project'
(project / 'src/zoo').mkdir(parents=True)
(project / 'lib').mkdir()
libs = work / 'libsrc/zoo'
libs.mkdir(parents=True)
(libs / 'ExternalRepo.java').write_text('''package zoo;

public interface ExternalRepo {
    String find(String id, int limit);
}
''')
(libs / 'ExternalImpl.java').write_text('''package zoo;

public class ExternalImpl implements ExternalRepo {
    public String find(String id, int limit) {
        return id + limit;
    }
}
''')
lib_classes = work / 'libclasses'
lib_classes.mkdir()
subprocess.run(['javac', '--release', '8', '-d', str(lib_classes)] + [str(p) for p in libs.glob('*.java')], check=True)
subprocess.run(['jar', 'cf', str(project / 'lib/external-api.jar'), '-C', str(lib_classes), '.'], check=True)
(project / '.project').write_text('<projectDescription><name>zoo</name><buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name></buildCommand></buildSpec><natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>')
# `kotlin`: the project's compiled Kotlin classes, as the Kotlin bridge attaches them.
(project / '.classpath').write_text('<classpath><classpathentry kind="src" path="src"/><classpathentry kind="lib" path="lib/external-api.jar"/><classpathentry kind="lib" path="kotlin"><attributes><attribute name="ai.openidea.kotlin" value="true"/></attributes></classpathentry><classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/><classpathentry kind="output" path="bin"/></classpath>')
sources = {
    'Repo.java': '''package zoo;

public interface Repo<T> {
    void save(T item);

    default String name() {
        return "repo";
    }
}
''',
    'SubRepo.java': '''package zoo;

public interface SubRepo extends Repo<String> {
}
''',
    'Base.java': '''package zoo;

public abstract class Base implements Repo<Integer> {
    public abstract void save(Integer item);
}
''',
    'Numbers.java': '''package zoo;

public class Numbers extends Base {
    public void save(Integer item) {
    }
}
''',
    'Words.java': '''package zoo;

public class Words implements SubRepo {
    public void save(String item) {
    }

    public String name() {
        return "words";
    }
}
''',
    'Task.java': '''package zoo;

public class Task implements Runnable {
    public void run() {
    }
}
''',
    'Anon.java': '''package zoo;

public class Anon {
    Repo<Double> make() {
        class Local implements Repo<Double> {
            public void save(Double item) {
            }
        }
        return new Repo<Double>() {
            public void save(Double item) {
            }
        };
    }
}
''',
    'UseExternal.java': '''package zoo;

public class UseExternal {
    void use(ExternalRepo repo) {
        repo.find("x", 1);
    }
}
''',
    'Use.java': '''package zoo;

public class Use {
    void use(Repo<String> repo, Runnable task) {
        repo.save("x");
        task.run();
    }

    void alone() {
    }
}
''',
}
for name, text in sources.items():
    (project / 'src/zoo' / name).write_text(text)
uri = lambda name: (project / 'src/zoo' / name).as_uri()
# Stands in for a Kotlin class of the project implementing the Java interface.
(work / 'kotlin-src/zoo').mkdir(parents=True)
(work / 'kotlin-src/zoo/Longs.java').write_text('package zoo;\n\npublic class Longs implements Repo<Long> {\n    public void save(Long item) {\n    }\n}\n')
subprocess.run(['javac', '-implicit:none', '-sourcepath', str(project / 'src'), '-d', str(project / 'kotlin'), str(work / 'kotlin-src/zoo/Longs.java')], check=True)

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




def implementations(file, needle):
    line, col = position(file, needle)
    found = command('openidea.java.implementations', uri(file), line, col)
    names = []
    for loc in found['locations']:
        name = pathlib.Path(urllib.parse.unquote(urllib.parse.urlparse(loc['uri']).path)).name
        names.append(f"{name}:{loc['range']['start']['line']}")
    return sorted(names), found['complete']


def definition(file, needle):
    line, col = position(file, needle)
    return request('textDocument/definition', {'textDocument': {'uri': uri(file)}, 'position': {'line': line, 'character': col}})


def class_contents(class_uri):
    return request('java/classFileContents', {'uri': class_uri})


def standard_implementations(class_uri, line, col):
    found = request('textDocument/implementation', {'textDocument': {'uri': class_uri}, 'position': {'line': line, 'character': col}})
    return found or []


def implementation_locations(class_uri, line, col, targets):
    found = command('openidea.java.implementationLocations', class_uri, line, col, targets)
    return [
        (pathlib.Path(urllib.parse.unquote(urllib.parse.urlparse(loc['uri']).path)).name, loc['range']['start']['line'])
        for loc in found['locations'] if loc is not None
    ]


try:
    init = request('initialize', {'processId': None, 'rootUri': project.as_uri(), 'workspaceFolders': [{'uri': project.as_uri(), 'name': 'zoo'}], 'capabilities': {}, 'initializationOptions': {'bundles': [str(bundle)], 'extendedClientCapabilities': {'classFileContentsSupport': True}, 'settings': {'java': {'import': {'gradle': {'enabled': False}, 'maven': {'enabled': False}}}}}})
    assert 'openidea.java.implementations' in init['capabilities']['executeCommandProvider']['commands']
    send({'jsonrpc': '2.0', 'method': 'initialized', 'params': {}})
    for name, text in sources.items():
        send({'jsonrpc': '2.0', 'method': 'textDocument/didOpen', 'params': {'textDocument': {'uri': uri(name), 'languageId': 'java', 'version': 1, 'text': text}}})
    request('java/buildWorkspace', True)
    # (implementations in the sources, whether they are all there are)
    cases = {
        # Classes, abstract, local and anonymous ones too, and those of the bridged Kotlin output; not the sub-interface.
        ('Repo.java', 'Repo<T>'): (['Anon.java:4', 'Anon.java:8', 'Base.java:2', 'Longs.java:0', 'Numbers.java:2', 'Words.java:2'], True),
        # Through the type arguments; not the abstract re-declaration.
        ('Repo.java', 'save(T'): (['Anon.java:5', 'Anon.java:9', 'Longs.java:0', 'Numbers.java:3', 'Words.java:3'], True),
        ('Use.java', 'save("x")'): (['Anon.java:5', 'Anon.java:9', 'Longs.java:0', 'Numbers.java:3', 'Words.java:3'], True),
        ('Repo.java', 'name()'): (['Words.java:6'], True),
        # A library type's implementations in the sources; the library has more.
        ('Use.java', 'Runnable task'): (['Task.java:2'], False),
        ('Use.java', 'run();'): (['Task.java:3'], False),
        ('Use.java', 'alone()'): ([], True),
    }
    failures = []
    for (file, needle), expected in cases.items():
        actual = implementations(file, needle)
        print(f'{file} {needle!r}: {actual}')
        if actual != expected:
            failures.append((file, needle, expected, actual))
    assert not failures, failures

    # An interface in a dependency: the standard request starts at the class file, and the
    # extension resolves the implementing method's declaration in the dependency.
    defs = definition('UseExternal.java', 'ExternalRepo repo')
    class_uri = defs[0]['uri']
    text = class_contents(class_uri)
    method_line = next(i for i, line in enumerate(text.splitlines()) if 'find(' in line)
    method_col = text.splitlines()[method_line].index('find')
    std = standard_implementations(class_uri, method_line, method_col)
    targets = [loc['uri'] for loc in std]
    resolved = implementation_locations(class_uri, method_line, method_col, targets)
    print('dependency implementation:', resolved)
    expected = [(pathlib.Path(urllib.parse.unquote(urllib.parse.urlparse(targets[0]).path)).name, 7)]
    assert resolved == expected, (resolved, expected)
    print('ok')
finally:
    proc.kill()
    shutil.rmtree(work, ignore_errors=True)
