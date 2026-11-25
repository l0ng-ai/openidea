"""What inspect.py and stream.py share: JSON-RPC over LSP and DAP, a JDT LS process, OK/FAIL reports.

Imported by path (the scripts put their own directory on sys.path), so it needs no package.
"""
import json
import os
import platform
import re
import shutil
import signal
import socket
import subprocess
import threading
import time

failures = []
T0 = time.time()


def report(status, name, detail=''):
    print(f'[{time.time() - T0:6.1f}s] {status} {name}' + (f': {detail}' if detail else ''), flush=True)
    if status == 'FAIL':
        failures.append(name)


def check(name, ok, detail=''):
    report('OK' if ok else 'FAIL', name, '' if ok else detail)
    return ok


class Rpc:
    """Content-Length framed JSON; responses are matched by id so two threads can wait at once."""

    def __init__(self, read, write):
        self.read, self.write = read, write
        self.lock = threading.Lock()
        self.cv = threading.Condition()
        self.next_id = 0
        self.responses = {}
        self.events = []
        threading.Thread(target=self.pump, daemon=True).start()

    def pump(self):
        while True:
            header = b''
            while not header.endswith(b'\r\n\r\n'):
                c = self.read(1)
                if not c:
                    return
                header += c
            length = int(re.search(rb'Content-Length: (\d+)', header).group(1))
            body = b''
            while len(body) < length:
                chunk = self.read(length - len(body))
                if not chunk:
                    return
                body += chunk
            self.receive(json.loads(body))

    def send(self, message):
        data = json.dumps(message).encode()
        with self.lock:
            self.write(b'Content-Length: %d\r\n\r\n' % len(data) + data)

    def allocate(self):
        with self.lock:
            self.next_id += 1
            return self.next_id

    def store(self, key, message):
        with self.cv:
            self.responses[key] = message
            self.cv.notify_all()

    def wait_for(self, key, timeout, what):
        end = time.time() + timeout
        with self.cv:
            while key not in self.responses:
                if not self.cv.wait(max(0.01, end - time.time())) and time.time() > end:
                    raise TimeoutError(what)
            return self.responses.pop(key)

    def wait_event(self, predicate, timeout, what):
        end = time.time() + timeout
        with self.cv:
            while True:
                for event in self.events:
                    if predicate(event):
                        self.events.remove(event)
                        return event
                if not self.cv.wait(max(0.01, end - time.time())) and time.time() > end:
                    raise TimeoutError(what)


class Lsp(Rpc):
    def receive(self, m):
        if 'method' in m and 'id' in m:
            self.send({'jsonrpc': '2.0', 'id': m['id'], 'result': None})
        elif 'method' in m:
            with self.cv:
                self.events.append(m)
                self.cv.notify_all()
        else:
            self.store(m['id'], m)

    def request(self, method, params, timeout=120):
        rid = self.allocate()
        self.send({'jsonrpc': '2.0', 'id': rid, 'method': method, 'params': params})
        return self.wait_for(rid, timeout, method)

    def notify(self, method, params):
        self.send({'jsonrpc': '2.0', 'method': method, 'params': params})

    def command(self, command, *arguments, timeout=120):
        r = self.request('workspace/executeCommand', {'command': command, 'arguments': list(arguments)}, timeout)
        if 'error' in r:
            raise RuntimeError(f'{command}: {r["error"]}')
        return r['result']


class Dap(Rpc):
    """`output` events go to `output`, not `events`."""

    def __init__(self, read, write):
        self.output = []
        super().__init__(read, write)

    def receive(self, m):
        if m['type'] == 'response':
            self.store(m['request_seq'], m)
        elif m['type'] == 'event':
            with self.cv:
                if m['event'] == 'output':
                    self.output.append(m['body'].get('output', ''))
                else:
                    self.events.append(m)
                self.cv.notify_all()
        elif m['type'] == 'request':  # runInTerminal and the like: refuse
            self.send({'seq': 0, 'type': 'response', 'request_seq': m['seq'], 'command': m['command'], 'success': False})

    def request(self, command, arguments=None, timeout=60):
        rid = self.allocate()
        self.send({'seq': rid, 'type': 'request', 'command': command, 'arguments': arguments or {}})
        return self.wait_for(rid, timeout, command)

    def start(self, command, arguments):
        rid = self.allocate()
        self.send({'seq': rid, 'type': 'request', 'command': command, 'arguments': arguments})


def start_jdtls(home, work, project, bundles, wanted, lsp_type=Lsp):
    """JDT LS from the distribution at `home`, initialized on `project` with `bundles`.

    Returns `(process, lsp, registered)`. JDT LS can build its `initialize` reply before it has read a
    bundle's command handlers, so a command of `wanted` missing from the reply is counted as
    registered when executing it does not fail with "No delegateCommandHandler".
    """
    process, lsp = launch_jdtls(home, work, lsp_type=lsp_type)
    try:
        registered = initialize(lsp, project, bundles)
        late = [c for c in wanted if c not in registered and handled(lsp, c)]
    except BaseException:
        stop_jdtls(process, lsp)
        raise
    if late:
        report('NOTE', 'left out of the initialize reply but handled', late)
    return process, lsp, registered + late


def handled(lsp, command):
    """Executes `command` with no arguments: any answer but a missing handler means it is registered."""
    r = lsp.request('workspace/executeCommand', {'command': command, 'arguments': []}, 60)
    return 'No delegateCommandHandler' not in json.dumps(r.get('error', {}))


def launch_jdtls(home, work, lsp_type=Lsp):
    """JDT LS from the distribution at `home` on the `java` on PATH, configured and logging under `work`."""
    config = work / 'config'
    config.mkdir()
    system, machine = platform.system(), platform.machine().lower()
    config_name = {'Windows': 'config_win', 'Darwin': 'config_mac'}.get(system, 'config_linux')
    names = ([config_name + '_arm'] if machine in ('arm64', 'aarch64') else []) + [config_name]
    (config / 'config.ini').write_bytes(next(home / n / 'config.ini' for n in names if (home / n / 'config.ini').is_file()).read_bytes())
    process = subprocess.Popen(['java', '-Declipse.application=org.eclipse.jdt.ls.core.id1', '-Dosgi.bundles.defaultStartLevel=4',
                                '-Declipse.product=org.eclipse.jdt.ls.core.product', '-Xmx1G', '--add-modules=ALL-SYSTEM',
                                '--add-opens', 'java.base/java.util=ALL-UNNAMED', '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
                                '-jar', str(next((home / 'plugins').glob('org.eclipse.equinox.launcher_*.jar'))),
                                '-configuration', str(config), '-data', str(work / 'data')],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=(work / 'jdtls.err').open('w'))

    def write(data):
        process.stdin.write(data)
        process.stdin.flush()

    return process, lsp_type(process.stdout.read, write)


def initialize(lsp, project, bundles):
    """Initializes JDT LS on `project` (sources in `src`) with `bundles`; returns the commands it registered."""
    uri = project.as_uri()
    r = lsp.request('initialize', {'processId': os.getpid(), 'rootUri': uri, 'capabilities': {'workspace': {'executeCommand': {}}},
                                   'initializationOptions': {'bundles': [str(b) for b in bundles],
                                                             'settings': {'java': {'project': {'sourcePaths': ['src']}}}},
                                   'workspaceFolders': [{'uri': uri, 'name': project.name}]}, timeout=180)
    return r['result']['capabilities'].get('executeCommandProvider', {}).get('commands', [])


def wait_ready(lsp):
    lsp.notify('initialized', {})
    lsp.wait_event(lambda m: m.get('method') == 'language/status' and m['params'].get('type') in ('ServiceReady', 'Started'), 240, 'ServiceReady')


def stop_jdtls(process, lsp):
    try:
        lsp.request('shutdown', None, 10)
        lsp.notify('exit', None)
        process.wait(10)
    except Exception:
        pass
    if process.poll() is None:
        process.kill()
        process.wait(10)


def kill(jvms, pids):
    """Stops the debuggee processes started here and the ones java-debug launched, by pid."""
    for p in jvms:
        if p.poll() is None:
            p.kill()
            p.wait(10)
    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass


def debug_session(lsp, client_id):
    """A new java-debug DAP session, initialized."""
    port = lsp.command('vscode.java.startDebugSession', timeout=60)
    sock = socket.create_connection(('127.0.0.1', port))
    reader = sock.makefile('rb', buffering=0)
    d = Dap(reader.read, sock.sendall)
    d.request('initialize', {'clientID': client_id, 'adapterID': 'java', 'linesStartAt1': True,
                             'columnsStartAt1': True, 'pathFormat': 'path'})
    return d


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


def finish(work):
    """Keeps `work` when something failed, else removes it; prints the verdict. Returns the exit status."""
    if failures:
        print(f'kept {work} (JDT LS stderr in jdtls.err, log in data/.metadata/.log)', flush=True)
    else:
        shutil.rmtree(work, ignore_errors=True)
    print('FAILED: ' + ', '.join(failures) if failures else 'ALL OK', flush=True)
    return 1 if failures else 0
