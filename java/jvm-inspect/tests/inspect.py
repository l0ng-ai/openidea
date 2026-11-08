"""Drive the bundle inside a real JDT LS with java-debug.

Usage: OPENIDEA_TEST_JAVA=<jdk>/bin/java[:<jdk>/bin/java...] \
       python3 inspect.py /path/to/jdtls /path/to/com.microsoft.java.debug.plugin-<v>.jar [--heap N]

JDT LS runs on the `java` on PATH (JDK 25 for 1.63.0). OPENIDEA_TEST_JAVA lists the debuggee JDKs:
the attach checks use the first; `classes` runs on the JDK 11 one; `--heap N` counts N objects on the
JDK 21 one while a java-debug request waits behind the count. Prints OK/FAIL/SKIP per check.
"""
import json
import os
import pathlib
import platform
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time

COMMANDS = ['openidea.jvm.vms', 'openidea.jvm.classes', 'openidea.jvm.instances',
            'openidea.jvm.fields', 'openidea.jvm.referrers']
BREAKPOINT_LINE = 6
HEAP = '''public class Heap {
    static final class Live { final int v; Live(int v) { this.v = v; } }
    static Object[] keep;
    static volatile int tick;
    static void pause() {
        tick++;
    }
    public static void main(String[] a) throws Exception {
        int n = Integer.parseInt(a[0]);
        keep = new Object[n];
        for (int i = 0; i < n; i++) keep[i] = new Live(i);
        System.out.println("READY " + n);
        while (true) { pause(); Thread.sleep(100); }
    }
}
'''

args = [a for a in sys.argv[1:]]
heap = None
if '--heap' in args:
    i = args.index('--heap')
    heap = int(args[i + 1])
    del args[i:i + 2]
home, java_debug = (pathlib.Path(a).resolve() for a in args[:2])
bundle = pathlib.Path(__file__).resolve().parents[1] / 'openidea-jvm-inspect.jar'
javas = [p for p in os.environ.get('OPENIDEA_TEST_JAVA', '').split(os.pathsep) if p]
if not javas:
    sys.exit('set OPENIDEA_TEST_JAVA to one or more <jdk>/bin/java, separated by ' + os.pathsep)
failures = []
T0 = time.time()


def report(status, name, detail=''):
    print(f'[{time.time() - T0:6.1f}s] {status} {name}' + (f': {detail}' if detail else ''), flush=True)
    if status == 'FAIL':
        failures.append(name)


def check(name, ok, detail=''):
    report('OK' if ok else 'FAIL', name, '' if ok else detail)
    return ok


def major(java):
    out = subprocess.run([java, '-version'], capture_output=True, text=True).stderr
    version = re.search(r'version "([^"]+)"', out).group(1)
    parts = version.split('.')
    return int(parts[1]) if parts[0] == '1' else int(re.match(r'\d+', parts[0]).group())


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

    def inspect(self, name, *arguments, timeout=180):
        return self.command('openidea.jvm.' + name, *arguments, timeout=timeout)


class Dap(Rpc):
    def receive(self, m):
        if m['type'] == 'response':
            self.store(m['request_seq'], m)
        elif m['type'] == 'event':
            with self.cv:
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


# resolved: on macOS the temp dir is under the /var symlink, and JDT LS matches canonical URIs
work = pathlib.Path(tempfile.mkdtemp(prefix='openidea-jvm-inspect-')).resolve()
project = work / 'project'
(project / 'src').mkdir(parents=True)
(project / 'src' / 'Heap.java').write_text(HEAP)
source = str(project / 'src' / 'Heap.java')
classes = work / 'classes'
subprocess.run(['javac', '-g', '--release', '8', '-Xlint:-options', '-d', str(classes), source], check=True)
config = work / 'config'
config.mkdir()
system, machine = platform.system(), platform.machine().lower()
config_name = {'Windows': 'config_win', 'Darwin': 'config_mac'}.get(system, 'config_linux')
names = ([config_name + '_arm'] if machine in ('arm64', 'aarch64') else []) + [config_name]
(config / 'config.ini').write_bytes(next(home / n / 'config.ini' for n in names if (home / n / 'config.ini').is_file()).read_bytes())

jdtls = subprocess.Popen(['java', '-Declipse.application=org.eclipse.jdt.ls.core.id1', '-Dosgi.bundles.defaultStartLevel=4',
                          '-Declipse.product=org.eclipse.jdt.ls.core.product', '-Xmx1G', '--add-modules=ALL-SYSTEM',
                          '--add-opens', 'java.base/java.util=ALL-UNNAMED', '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
                          '-jar', str(next((home / 'plugins').glob('org.eclipse.equinox.launcher_*.jar'))),
                          '-configuration', str(config), '-data', str(work / 'data')],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=(work / 'jdtls.err').open('w'))


def write_jdtls(data):
    jdtls.stdin.write(data)
    jdtls.stdin.flush()


lsp = Lsp(jdtls.stdout.read, write_jdtls)
jvms = []  # debuggees started here
launched = []  # pids of debuggees java-debug started
project_name = None
modules, classpaths = [], []


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


def start_jvm(java, n, xmx='256m'):
    port = free_port()
    p = subprocess.Popen([java, f'-Xmx{xmx}', f'-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:{port}',
                          '-cp', str(classes), 'Heap', str(n)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    jvms.append(p)
    for line in p.stdout:
        if line.startswith('READY'):
            break
    threading.Thread(target=lambda: [None for _ in p.stdout], daemon=True).start()
    return p, port


def session():
    port = lsp.command('vscode.java.startDebugSession', timeout=60)
    sock = socket.create_connection(('127.0.0.1', port))
    reader = sock.makefile('rb', buffering=0)
    d = Dap(reader.read, sock.sendall)
    d.request('initialize', {'clientID': 'openidea-jvm-inspect', 'adapterID': 'java', 'linesStartAt1': True,
                             'columnsStartAt1': True, 'pathFormat': 'path'})
    return d


def stop_at_breakpoint(d, command, arguments):
    d.start(command, arguments)
    d.wait_event(lambda e: e['event'] == 'initialized', 60, 'initialized')
    d.request('setBreakpoints', {'source': {'path': source}, 'breakpoints': [{'line': BREAKPOINT_LINE}]})
    d.request('configurationDone')
    stopped = d.wait_event(lambda e: e['event'] == 'stopped', 120, 'stopped')
    # Later resumes must not stop again.
    d.request('setBreakpoints', {'source': {'path': source}, 'breakpoints': []})
    return stopped['body']['threadId']


def attach(port):
    d = session()
    thread = stop_at_breakpoint(d, 'attach', {'hostName': '127.0.0.1', 'port': port, 'timeout': 30000, 'projectName': project_name})
    return d, thread


def launch(n):
    d = session()
    thread = stop_at_breakpoint(d, 'launch', {'mainClass': 'Heap', 'projectName': project_name, 'modulePaths': modules,
                                              'classPaths': classpaths, 'args': str(n), 'cwd': str(project),
                                              'console': 'internalConsole', 'shortenCommandLine': 'none'})
    pid = d.request('processId')['body']['processId']
    launched.append(pid)
    return d, thread, pid


def end(d):
    try:
        d.request('disconnect', {'terminateDebuggee': True}, 20)
    except Exception as e:  # the JVM is killed below anyway
        report('NOTE', 'disconnect failed', repr(e))


def by_port(port, generation=1):
    return {'pid': None, 'host': 'localhost', 'port': port, 'generation': generation}


def ok(reply):
    if 'ok' not in reply:
        raise AssertionError(f'expected ok, got {reply}')
    return reply['ok']


def live(target, limit=1000):
    return ok(lsp.inspect('instances', target, 'Heap$Live', limit))


def check_selection_and_objects():
    first = javas[0]
    (_, p1), (_, p2) = start_jvm(first, 11), start_jvm(first, 13)
    a1, _ = attach(p1)
    a2, a2_thread = attach(p2)
    l, _, pid = launch(1500)
    vms = ok(lsp.inspect('vms'))
    print('         vms:', json.dumps(vms), flush=True)
    check('vms lists the launch by pid and both attaches by port',
          sorted(v.get('remotePort') for v in vms if v.get('pid') is None) == sorted([p1, p2])
          and [v.get('pid') for v in vms].count(pid) == 1, vms)
    launch_target = {'pid': pid, 'host': None, 'port': None, 'generation': 1}
    n = len(live(launch_target, 2000))
    check('launch selected by pid: instances of Heap$Live = min(1500, 1000)', n == 1000, n)
    got = (len(live(by_port(p1))), len(live(by_port(p2))))
    check('two attaches to the same program each get their VM by port: 11 and 13 instances', got == (11, 13), got)
    instance = live(by_port(p1), 1)[0]
    fields = ok(lsp.inspect('fields', by_port(p1), instance['id']))
    v = next((f['value'] for f in fields if f['name'] == 'v'), None)
    check('fields of a Heap$Live instance include v (int)', v is not None and v['kind'] == 'primitive' and v['typeName'] == 'int', fields)
    referrers = ok(lsp.inspect('referrers', by_port(p1), instance['id'], 50))
    expected = [{'value': {'kind': 'array', 'typeName': 'java.lang.Object[]', 'length': 11}, 'via': [f'[{v["text"]}]']}]
    shape = [{'value': {k: r['value'].get(k) for k in ('kind', 'typeName', 'length')}, 'via': r['via']} for r in referrers]
    check('referrers of an instance: the array holding it, via its index', shape == expected, referrers)
    error = lsp.inspect('fields', by_port(p1, 2), instance['id'])
    check('an id from an earlier stop is stale', error.get('error') == 'stale', error)
    error = lsp.inspect('instances', by_port(free_port()), 'Heap$Live', 1)
    check('a port no session uses is vmNotFound', error.get('error') == 'vmNotFound', error)
    error = lsp.inspect('instances', by_port(p1), 'NoSuchClass', 1)
    check('a class that is not loaded is classNotLoaded', error.get('error') == 'classNotLoaded', error)
    a2.request('continue', {'threadId': a2_thread})
    for _ in range(50):
        error = lsp.inspect('instances', by_port(p2), 'Heap$Live', 1)
        if error.get('error') == 'notSuspended':
            break
        time.sleep(0.1)
    check('a running VM is notSuspended', error.get('error') == 'notSuspended', error)
    eleven = next((j for j in javas if major(j) == 11), None)
    if eleven is None:
        report('SKIP', 'classes on JDK 11', 'no JDK 11 in OPENIDEA_TEST_JAVA')
    else:
        if eleven == first:
            port, extra = p1, None
        else:
            _, port = start_jvm(eleven, 17)
            extra, _ = attach(port)
        counts = ok(lsp.inspect('classes', by_port(port)))
        n = {c['name']: c['instances'] for c in counts}.get('Heap$Live')
        expected_n = 11 if extra is None else 17
        check(f'classes on JDK 11 while stopped: Heap$Live = {expected_n}, no zero rows',
              n == expected_n and all(c['instances'] > 0 for c in counts), n)
        if extra:
            end(extra)
    for d in (a1, a2, l):
        end(d)
    time.sleep(1)
    check('vms is empty after the sessions end', ok(lsp.inspect('vms')) == [])


def check_large_heap(n):
    java = next((j for j in javas if major(j) == 21), None)
    if java is None:
        report('SKIP', f'--heap {n}', 'no JDK 21 in OPENIDEA_TEST_JAVA')
        return
    _, port = start_jvm(java, n, '2g')
    d, thread = attach(port)
    frame = d.request('stackTrace', {'threadId': thread})['body']['stackFrames'][0]['id']
    box = {}
    counting = threading.Thread(target=lambda: box.update(r=lsp.inspect('classes', by_port(port), timeout=300)))
    started = time.time()
    counting.start()
    time.sleep(0.5)
    t0 = time.time()
    r = d.request('evaluate', {'expression': 'Heap.keep.length', 'frameId': frame, 'context': 'repl'}, 120)
    waited = time.time() - t0
    counting.join()
    counted = time.time() - started
    check(f'a DAP evaluate sent 0.5 s into classes succeeds (waited {waited:.1f} s; classes took {counted:.1f} s)',
          r['success'] and r['body']['result'] == str(n), r)
    counts = {c['name']: c['instances'] for c in ok(box['r'])}
    check(f'classes counts {n} Heap$Live', counts.get('Heap$Live') == n, counts.get('Heap$Live'))
    timeout = next(v['timeout'] for v in ok(lsp.inspect('vms')) if v['remotePort'] == port)
    check('the request timeout is back to 3000 after classes', timeout == 3000, timeout)
    instance = live(by_port(port), 1)[0]
    referrers = ok(lsp.inspect('referrers', by_port(port), instance['id'], 50))
    check(f'a referrer array of {n} elements is not searched for the index',
          [r['via'] for r in referrers] == [[]] and referrers[0]['value']['length'] == n, referrers)
    timeout = next(v['timeout'] for v in ok(lsp.inspect('vms')) if v['remotePort'] == port)
    check('the request timeout is back to 3000 after referrers', timeout == 3000, timeout)
    end(d)


try:
    uri = project.as_uri()
    r = lsp.request('initialize', {'processId': os.getpid(), 'rootUri': uri, 'capabilities': {'workspace': {'executeCommand': {}}},
                                   'initializationOptions': {'bundles': [str(java_debug), str(bundle)],
                                                             'settings': {'java': {'project': {'sourcePaths': ['src']}}}},
                                   'workspaceFolders': [{'uri': uri, 'name': 'project'}]}, timeout=180)
    registered = r['result']['capabilities'].get('executeCommandProvider', {}).get('commands', [])
    if not check('JDT LS registers the bundle commands and java-debug', all(c in registered for c in COMMANDS + ['vscode.java.startDebugSession']),
                 [c for c in registered if c.startswith(('openidea', 'vscode.java.start'))]):
        sys.exit(1)
    lsp.notify('initialized', {})
    lsp.wait_event(lambda m: m.get('method') == 'language/status' and m['params'].get('type') in ('ServiceReady', 'Started'), 240, 'ServiceReady')
    lsp.notify('textDocument/didOpen', {'textDocument': {'uri': pathlib.Path(source).as_uri(), 'languageId': 'java', 'version': 1, 'text': HEAP}})
    check('vms is empty before any session', ok(lsp.inspect('vms')) == [])
    for _ in range(30):
        main = lsp.command('vscode.java.resolveMainClass', uri)
        if main:
            break
        time.sleep(2)
    project_name = main[0].get('projectName')
    modules, classpaths = lsp.command('vscode.java.resolveClasspath', main[0]['mainClass'], project_name)
    check_selection_and_objects()
    if heap:
        check_large_heap(heap)
except Exception as e:
    report('FAIL', 'harness', repr(e))
finally:
    for p in jvms:
        if p.poll() is None:
            p.kill()
            p.wait(10)
    for pid in launched:
        try:
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    try:
        lsp.request('shutdown', None, 10)
        lsp.notify('exit', None)
        jdtls.wait(10)
    except Exception:
        pass
    if jdtls.poll() is None:
        jdtls.kill()
        jdtls.wait(10)
    if failures:
        print(f'kept {work} (JDT LS stderr in jdtls.err, log in data/.metadata/.log)', flush=True)
    else:
        shutil.rmtree(work, ignore_errors=True)
print('FAILED: ' + ', '.join(failures) if failures else 'ALL OK', flush=True)
sys.exit(1 if failures else 0)
