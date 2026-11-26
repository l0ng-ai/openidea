"""The exception class at a caret, against a real JDT LS. Arguments: jdtls home, optional bundle jar.

Each case puts the caret at an offset inside a unique piece of text and compares the answer of
`openidea.java.exceptionType` with IntelliJ's ControlExceptionBreakpointJVMSupport: the class a
reference resolves to (a constructor's class), a class declaration's name, or the type a throw
statement throws, when that class is a Throwable with a qualified name.
"""
import json
import pathlib
import platform
import queue
import subprocess
import sys
import tempfile
import threading
import time

home = pathlib.Path(sys.argv[1]).resolve()
bundle = pathlib.Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else pathlib.Path(__file__).resolve().parents[1] / 'openidea-java-usages.jar'
work = pathlib.Path(tempfile.mkdtemp(prefix='openidea-exception-type-'))
config = work / 'config'
config.mkdir()
system, machine = platform.system(), platform.machine().lower()
config_name = {'Windows': 'config_win', 'Darwin': 'config_mac'}.get(system, 'config_linux')
config_names = ([config_name + '_arm'] if machine in ('arm64', 'aarch64') else []) + [config_name]
config_source = next(home / name / 'config.ini' for name in config_names if (home / name / 'config.ini').is_file())
(config / 'config.ini').write_bytes(config_source.read_bytes())
project = work / 'project'
(project / 'src/app/errors').mkdir(parents=True)
(project / '.project').write_text('<projectDescription><name>app</name><buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name></buildCommand></buildSpec><natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>')
(project / '.classpath').write_text('<classpath><classpathentry kind="src" path="src"/><classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/><classpathentry kind="output" path="bin"/></classpath>')
sources = {
    'errors/OrderException.java': '''package app.errors;

public class OrderException extends Exception {
    public OrderException(String message) {
        super(message);
    }
}
''',
    'Main.java': '''package app;

import app.errors.OrderException;
import java.io.IOException;

public class Main {
    static class Failure extends RuntimeException {
    }

    static class NotAnException {
    }

    void place(Exception given, String msg) throws Exception {
        try {
            throw new OrderException("order " + msg);
        } catch (OrderException | IllegalArgumentException e) {
            throw given;
        }
    }

    void qualified() {
        throw new java.lang.IllegalStateException("qualified");
    }

    void nested() {
        throw new Failure();
    }

    void missing() {
        throw new Missing();
    }

    Object plain() {
        return new NotAnException();
    }

    static Exception build(String why) {
        return new IOException(why);
    }

    void call() throws Exception {
        throw build("call");
    }

    void qualifiedCall() throws Exception {
        throw Main.build("qualifiedCall");
    }

    <T extends Exception> void typeVariable(T t) throws T {
        throw t;
    }

    void local() {
        class Local extends RuntimeException {
        }
        throw new Local();
    }
}
''',
}
for name, text in sources.items():
    (project / 'src/app' / name).write_text(text)
uri = lambda name: (project / 'src/app' / name).as_uri()

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


def exception_type(file, needle, at=0):
    """The answer with the caret `at` characters into the only line holding `needle`."""
    lines = sources[file].splitlines()
    found = [i for i, t in enumerate(lines) if needle in t]
    assert len(found) == 1, (needle, found)
    line = found[0]
    column = lines[line].index(needle) + at
    return request('workspace/executeCommand', {'command': 'openidea.java.exceptionType', 'arguments': [uri(file), line, column]})


ORDER = {'qualifiedName': 'app.errors.OrderException', 'displayName': 'OrderException'}
EXCEPTION = {'qualifiedName': 'java.lang.Exception', 'displayName': 'Exception'}
CASES = [
    # throw new X(…): on the class, on `throw`, on `new`, inside a literal argument; a variable is not a class.
    ('throw new OrderException', 'OrderException', 10, ORDER),
    ('throw new OrderException', 'throw', 0, ORDER),
    ('throw new OrderException', 'new', 1, ORDER),
    ('throw new OrderException', '"order "', 2, ORDER),
    ('throw new OrderException', 'msg', 1, None),
    # Multi-catch: each alternative; the caret right after a name takes the name to its left.
    ('catch (OrderException', 'OrderException', 3, ORDER),
    ('catch (OrderException', 'IllegalArgumentException', 0, {'qualifiedName': 'java.lang.IllegalArgumentException', 'displayName': 'IllegalArgumentException'}),
    ('catch (OrderException', 'OrderException', len('OrderException'), ORDER),
    ('catch (OrderException', 'catch', 1, None),
    ('catch (OrderException', '|', 0, None),
    ('catch (OrderException', ' e)', 1, None),
    # A thrown variable: its declared type on `throw`, nothing on the variable.
    ('throw given', 'throw', 2, EXCEPTION),
    ('throw given', 'given', 2, None),
    # A qualified name: the class, not its packages.
    ('java.lang.IllegalStateException', 'IllegalStateException', 4, {'qualifiedName': 'java.lang.IllegalStateException', 'displayName': 'IllegalStateException'}),
    ('java.lang.IllegalStateException', 'java', 1, None),
    ('java.lang.IllegalStateException', 'lang', 1, None),
    # A nested class: its binary name, its simple name; also on its declaration and its superclass.
    ('throw new Failure', 'Failure', 2, {'qualifiedName': 'app.Main$Failure', 'displayName': 'Failure'}),
    ('static class Failure', 'Failure', 0, {'qualifiedName': 'app.Main$Failure', 'displayName': 'Failure'}),
    ('static class Failure', 'RuntimeException', 3, {'qualifiedName': 'java.lang.RuntimeException', 'displayName': 'RuntimeException'}),
    ('static class Failure', 'static', 1, None),
    # A type that does not resolve, and a class that is not a Throwable.
    ('throw new Missing', 'Missing', 2, None),
    ('throw new Missing', 'throw', 1, None),
    ('static class NotAnException', 'NotAnException', 2, None),
    ('return new NotAnException', 'NotAnException', 2, None),
    # A call: its return type on `throw`; the method name is not a class.
    ('throw build', 'throw', 0, EXCEPTION),
    ('throw build', 'build', 1, None),
    ('throw build', '"call"', 1, EXCEPTION),
    # A qualified call is a reference to its method (UAST): nothing inside it, the qualifier's class aside.
    ('throw Main.build', '"qualifiedCall"', 1, None),
    ('throw Main.build', 'throw', 0, EXCEPTION),
    # A type variable and a local class have no qualified name.
    ('throw t;', 'throw', 0, None),
    ('throw new Local', 'Local', 1, None),
    # An import names the class too.
    ('import app.errors.OrderException', 'OrderException', 1, ORDER),
    # Outside a throw, a reference or a class name: nothing.
    ('void nested()', 'nested', 1, None),
    ('public class Main', 'Main', 1, None),
]

try:
    init = request('initialize', {'processId': None, 'rootUri': project.as_uri(), 'workspaceFolders': [{'uri': project.as_uri(), 'name': 'app'}], 'capabilities': {}, 'initializationOptions': {'bundles': [str(bundle)], 'settings': {'java': {'import': {'gradle': {'enabled': False}, 'maven': {'enabled': False}}}}}})
    commands = init['capabilities']['executeCommandProvider']['commands']
    assert 'openidea.java.exceptionType' in commands, commands
    send({'jsonrpc': '2.0', 'method': 'initialized', 'params': {}})
    for name, text in sources.items():
        send({'jsonrpc': '2.0', 'method': 'textDocument/didOpen', 'params': {'textDocument': {'uri': uri(name), 'languageId': 'java', 'version': 1, 'text': text}}})
    request('java/buildWorkspace', True)
    failed = []
    for line_needle, needle, at, expected in CASES:
        lines = sources['Main.java'].splitlines()
        line = next(i for i, t in enumerate(lines) if line_needle in t)
        column = lines[line].index(needle, lines[line].index(line_needle) if needle in line_needle else 0) + at
        got = request('workspace/executeCommand', {'command': 'openidea.java.exceptionType', 'arguments': [uri('Main.java'), line, column]})
        status = 'OK' if got == expected else 'FAIL'
        if got != expected:
            failed.append((line_needle, needle, at))
        print(f'{status} {line_needle!r} at {needle!r}+{at}: {got}')
    # A class declared in another file, read through the position in that file.
    got = exception_type('errors/OrderException.java', 'class OrderException', 6)
    print(('OK' if got == ORDER else 'FAIL'), 'declaration in its own file:', got)
    if got != ORDER:
        failed.append('declaration in its own file')
    assert not failed, failed
    print('exception-type: all cases passed')
finally:
    proc.terminate()
    proc.wait(timeout=20)
    print('Evidence:', work, file=sys.stderr)
