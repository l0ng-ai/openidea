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
(project / '.project').write_text('<projectDescription><name>zoo</name><buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name></buildCommand></buildSpec><natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>')
(project / '.classpath').write_text('<classpath><classpathentry kind="src" path="src"/><classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/><classpathentry kind="output" path="bin"/></classpath>')
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
    for loc in found:
        name = pathlib.Path(urllib.parse.unquote(urllib.parse.urlparse(loc['uri']).path)).name
        names.append(f"{name}:{loc['range']['start']['line']}")
    return sorted(names)


try:
    init = request('initialize', {'processId': None, 'rootUri': project.as_uri(), 'workspaceFolders': [{'uri': project.as_uri(), 'name': 'zoo'}], 'capabilities': {}, 'initializationOptions': {'bundles': [str(bundle)], 'settings': {'java': {'import': {'gradle': {'enabled': False}, 'maven': {'enabled': False}}}}}})
    assert 'openidea.java.implementations' in init['capabilities']['executeCommandProvider']['commands']
    send({'jsonrpc': '2.0', 'method': 'initialized', 'params': {}})
    for name, text in sources.items():
        send({'jsonrpc': '2.0', 'method': 'textDocument/didOpen', 'params': {'textDocument': {'uri': uri(name), 'languageId': 'java', 'version': 1, 'text': text}}})
    request('java/buildWorkspace', True)
    cases = {
        # Classes, abstract ones too; not the sub-interface.
        ('Repo.java', 'Repo<T>'): ['Base.java:2', 'Numbers.java:2', 'Words.java:2'],
        # Through the type arguments; not the abstract re-declaration.
        ('Repo.java', 'save(T'): ['Numbers.java:3', 'Words.java:3'],
        ('Use.java', 'save("x")'): ['Numbers.java:3', 'Words.java:3'],
        ('Repo.java', 'name()'): ['Words.java:6'],
        # A library type's implementations in the sources.
        ('Use.java', 'Runnable task'): ['Task.java:2'],
        ('Use.java', 'run();'): ['Task.java:3'],
        ('Use.java', 'alone()'): [],
    }
    failures = []
    for (file, needle), expected in cases.items():
        actual = implementations(file, needle)
        print(f'{file} {needle!r}: {actual}')
        if actual != expected:
            failures.append((file, needle, expected, actual))
    assert not failures, failures
    print('ok')
finally:
    proc.kill()
    shutil.rmtree(work, ignore_errors=True)
