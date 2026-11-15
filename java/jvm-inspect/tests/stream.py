"""Drive the stream-trace commands inside a real JDT LS with java-debug.

Usage: OPENIDEA_TEST_JAVA=<jdk>/bin/java[:<jdk>/bin/java...] \
       python3 stream.py /path/to/jdtls /path/to/com.microsoft.java.debug.plugin-<v>.jar \
       [--bundle /path/to/openidea-jvm-inspect.jar] [--case NAME]...

JDT LS runs on the `java` on PATH (JDK 25 for 1.63.0); every case runs once per debuggee JDK in
OPENIDEA_TEST_JAVA. `--bundle` defaults to the checked-in jar; build one from the sources with
`build.py <jdtls> --out <jar>`. `--case` runs only the cases whose name contains NAME. Prints
OK/FAIL/SKIP per check.

A case is a function decorated with `@case`. It gets a stopped `Debuggee` from `launch(...)` or
`attach(...)` and drives it with the DAP helpers (`resume`, `step_out`, `expect_stop`, `breakpoints`)
and `stream(...)`. Debuggee programs live in PROGRAMS; `// @name` at the end of a line names that
line for `line('name')`.
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

STREAM_COMMANDS = ['openidea.jvm.stream.' + c for c in ('arm', 'wait', 'stop', 'abort', 'collect', 'release')]

CHAINS = '''import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.stream.Collectors;

public class Chains {
    public static void main(String[] a) throws Exception {
        List<Integer> nums = new ArrayList<>(Arrays.asList(5, 3, 8, 1, 4, 2, 9, 6));
        System.out.println("READY");
        while (true) {
            List<String> out = nums.stream().filter(x -> x % 2 == 0).map(String::valueOf).collect(Collectors.toList()); // @loop
            Thread.sleep(50);
        }
    }
}
'''
PROGRAMS = {'Chains': CHAINS}

args = sys.argv[1:]


def option(name):
    values = []
    while name in args:
        i = args.index(name)
        values.append(args[i + 1])
        del args[i:i + 2]
    return values


bundle = pathlib.Path((option('--bundle') or [pathlib.Path(__file__).resolve().parents[1] / 'openidea-jvm-inspect.jar'])[0]).resolve()
only = option('--case')
home, java_debug = (pathlib.Path(a).resolve() for a in args[:2])
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


# resolved: on macOS the temp dir is under the /var symlink, and JDT LS matches canonical URIs
work = pathlib.Path(tempfile.mkdtemp(prefix='openidea-jvm-stream-')).resolve()
project = work / 'project'
(project / 'src').mkdir(parents=True)
for name, text in PROGRAMS.items():
    (project / 'src' / f'{name}.java').write_text(text)
classes = work / 'classes'
subprocess.run(['javac', '-g', '--release', '8', '-Xlint:-options', '-d', str(classes),
                *[str(project / 'src' / f'{n}.java') for n in PROGRAMS]], check=True)
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
java = None  # the debuggee JDK of the current round


def source(program):
    return str(project / 'src' / f'{program}.java')


def line(name, program='Chains'):
    """1-based line ending in `// @name`."""
    for i, text in enumerate(PROGRAMS[program].splitlines(), 1):
        if text.rstrip().endswith('// @' + name):
            return i
    raise KeyError(name)


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


class Debuggee:
    """One DAP session stopped on `thread`; `target` selects its VM for the bundle commands."""

    def __init__(self, dap, program, target):
        self.dap, self.program, self.target = dap, program, target
        self.thread = None
        self.generation = 0

    def end(self):
        try:
            self.dap.request('disconnect', {'terminateDebuggee': True}, 20)
        except Exception as e:  # the JVM is killed at exit anyway
            report('NOTE', 'disconnect failed', repr(e))


def session():
    port = lsp.command('vscode.java.startDebugSession', timeout=60)
    sock = socket.create_connection(('127.0.0.1', port))
    reader = sock.makefile('rb', buffering=0)
    d = Dap(reader.read, sock.sendall)
    d.request('initialize', {'clientID': 'openidea-jvm-stream', 'adapterID': 'java', 'linesStartAt1': True,
                             'columnsStartAt1': True, 'pathFormat': 'path'})
    return d


def breakpoints(dbg, *names):
    dbg.dap.request('setBreakpoints', {'source': {'path': source(dbg.program)},
                                       'breakpoints': [{'line': line(n, dbg.program)} for n in names]})


def expect_stop(dbg, timeout=60, what='stopped'):
    """Waits for the next `stopped`; returns its body. Raises TimeoutError when none comes."""
    e = dbg.dap.wait_event(lambda e: e['event'] in ('stopped', 'terminated'), timeout, what)
    if e['event'] == 'terminated':
        raise AssertionError(f'{what}: the debuggee terminated')
    dbg.thread = e['body']['threadId']
    dbg.generation += 1
    dbg.target = dict(dbg.target, generation=dbg.generation)
    return e['body']


def no_stop(dbg, seconds):
    """True when no `stopped` arrives within `seconds`."""
    try:
        dbg.dap.wait_event(lambda e: e['event'] == 'stopped', seconds, 'stopped')
        return False
    except TimeoutError:
        return True


def resume(dbg):
    dbg.dap.request('continue', {'threadId': dbg.thread})


def step_out(dbg, timeout=60):
    dbg.dap.request('stepOut', {'threadId': dbg.thread})
    return expect_stop(dbg, timeout, 'stepOut')


def top(dbg):
    return dbg.dap.request('stackTrace', {'threadId': dbg.thread})['body']['stackFrames'][0]


def start(dbg, command, arguments, stop_at):
    dbg.dap.start(command, arguments)
    dbg.dap.wait_event(lambda e: e['event'] == 'initialized', 60, 'initialized')
    breakpoints(dbg, *stop_at)
    dbg.dap.request('setExceptionBreakpoints', {'filters': []})
    dbg.dap.request('configurationDone')
    expect_stop(dbg, 120, 'first breakpoint')
    return dbg


def launch(program='Chains', stop_at=('loop',)):
    """A launch of `program` stopped at the first of the `stop_at` lines."""
    d = session()
    dbg = Debuggee(d, program, {})
    start(dbg, 'launch', {'mainClass': program, 'projectName': project_name, 'modulePaths': [], 'classPaths': [str(classes)],
                          'cwd': str(project), 'console': 'internalConsole', 'shortenCommandLine': 'none', 'javaExec': java},
          stop_at)
    pid = d.request('processId')['body']['processId']
    launched.append(pid)
    dbg.target = {'pid': pid, 'host': None, 'port': None, 'generation': dbg.generation}
    return dbg


def start_jvm(program='Chains'):
    """A JVM running `program` with a JDWP socket; returns its port once the program printed READY."""
    port = free_port()
    p = subprocess.Popen([java, f'-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:{port}',
                          '-cp', str(classes), program], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    jvms.append(p)
    for out in p.stdout:
        if out.startswith('READY'):
            break
    threading.Thread(target=lambda: [None for _ in p.stdout], daemon=True).start()
    return port


def attach(port, program='Chains', stop_at=('loop',)):
    d = session()
    dbg = Debuggee(d, program, {'pid': None, 'host': 'localhost', 'port': port, 'generation': 0})
    return start(dbg, 'attach', {'hostName': '127.0.0.1', 'port': port, 'timeout': 30000, 'projectName': project_name}, stop_at)


def stream(command, dbg, timeout=120, **arguments):
    return lsp.command('openidea.jvm.stream.' + command, dbg.target, arguments, timeout=timeout)


def spec(name, args=0, skip=0):
    return {'name': name, 'args': args, 'skip': skip}


def plan(at, root=spec('stream'), local=None, steps=(spec('filter', 1), spec('map', 1)), terminal=spec('collect', 1),
         class_filters=('java.util.stream.*', 'java.util.Collection'), step_kinds=('sync', 'sync'), sequentialize=False,
         program='Chains'):
    """A `ide_streams::RealRunPlan` for the chain on line `at`; the defaults fit the `loop` chain."""
    return {'root': root, 'local': local, 'steps': list(steps), 'terminal': terminal, 'classFilters': list(class_filters),
            'stepKinds': list(step_kinds), 'sequentialize': sequentialize, 'firstLine': line(at, program) - 1}


def arm(dbg, at='loop', budget=50_000, **plan_args):
    return stream('arm', dbg, threadId=dbg.thread, plan=plan(at, program=dbg.program, **plan_args), budget=budget)


def ok(reply):
    if 'ok' not in reply:
        raise AssertionError(f'expected ok, got {reply}')
    return reply['ok']


def error(reply):
    return reply.get('error')


CASES = []


def case(fn):
    CASES.append(fn)
    return fn


@case
def arm_busy_release():
    dbg = launch()
    try:
        trace = ok(arm(dbg))['traceId']
        check('arm at the chain\'s breakpoint answers a traceId', isinstance(trace, (int, float)), trace)
        state = ok(stream('wait', dbg, traceId=trace, ms=0))
        check('wait on a fresh trace: running, no records',
              state.get('state') == 'running' and state.get('records') == 0 and state.get('dropped') == 0, state)
        check('stop on a fresh trace keeps 0 records', ok(stream('stop', dbg, traceId=trace)) == {'records': 0})
        r = arm(dbg)
        check('a second arm on the same VM is busy', error(r) == 'busy', r)
        r = stream('wait', dbg, traceId=trace + 1000, ms=0)
        check('an unknown traceId is noTrace', error(r) == 'noTrace', r)
        check('release answers {}', ok(stream('release', dbg, traceId=trace)) == {})
        again = ok(arm(dbg))['traceId']
        check('arm after release works again', again != trace, again)
        ok(stream('release', dbg, traceId=again))
    finally:
        dbg.end()


@case
def breakpoints_silenced_until_release():
    dbg = launch()
    try:
        trace = ok(arm(dbg))['traceId']
        resume(dbg)
        check('while armed, the breakpoint on the looping chain does not stop', no_stop(dbg, 1.5))
        ok(stream('release', dbg, traceId=trace))
        try:
            body = expect_stop(dbg, 10, 'stop after release')
            check('after release the same breakpoint stops again', body.get('reason') == 'breakpoint' and top(dbg)['line'] == line('loop'),
                  body)
        except TimeoutError:
            check('after release the same breakpoint stops again', False, 'no stop within 10 s')
    finally:
        dbg.end()


@case
def arm_while_running():
    dbg = launch()
    try:
        breakpoints(dbg)
        resume(dbg)
        time.sleep(0.2)
        r = arm(dbg)
        check('arm while the thread runs is notSuspended', error(r) == 'notSuspended', r)
        breakpoints(dbg, 'loop')
        expect_stop(dbg, 10)
        trace = ok(arm(dbg))['traceId']
        check('arm works once the thread stops again', trace is not None)
        ok(stream('release', dbg, traceId=trace))
    finally:
        dbg.end()


@case
def arm_in_attach():
    dbg = attach(start_jvm())
    try:
        trace = ok(arm(dbg))['traceId']
        check('arm in an attach session answers a traceId', trace is not None)
        ok(stream('release', dbg, traceId=trace))
    finally:
        dbg.end()


try:
    uri = project.as_uri()
    r = lsp.request('initialize', {'processId': os.getpid(), 'rootUri': uri, 'capabilities': {'workspace': {'executeCommand': {}}},
                                   'initializationOptions': {'bundles': [str(java_debug), str(bundle)],
                                                             'settings': {'java': {'project': {'sourcePaths': ['src']}}}},
                                   'workspaceFolders': [{'uri': uri, 'name': 'project'}]}, timeout=180)
    registered = r['result']['capabilities'].get('executeCommandProvider', {}).get('commands', [])
    if not check('JDT LS registers the stream commands and java-debug',
                 all(c in registered for c in STREAM_COMMANDS + ['vscode.java.startDebugSession']),
                 [c for c in registered if c.startswith(('openidea', 'vscode.java.start'))]):
        sys.exit(1)
    lsp.notify('initialized', {})
    lsp.wait_event(lambda m: m.get('method') == 'language/status' and m['params'].get('type') in ('ServiceReady', 'Started'), 240, 'ServiceReady')
    for name, text in PROGRAMS.items():
        lsp.notify('textDocument/didOpen', {'textDocument': {'uri': pathlib.Path(source(name)).as_uri(), 'languageId': 'java',
                                                             'version': 1, 'text': text}})
    for _ in range(30):
        main = lsp.command('vscode.java.resolveMainClass', uri)
        if main:
            break
        time.sleep(2)
    project_name = main[0].get('projectName')
    for java in javas:
        report('NOTE', 'debuggee', java)
        for fn in CASES:
            if only and not any(o in fn.__name__ for o in only):
                continue
            try:
                fn()
            except Exception as e:
                report('FAIL', fn.__name__, repr(e))
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
