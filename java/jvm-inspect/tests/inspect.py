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
import re
import subprocess
import sys
import tempfile
import threading
import time

# -I leaves the script's directory off sys.path; the shared harness lives there. Appended, not
# prepended: this file would shadow the standard library's `inspect`.
sys.path.append(str(pathlib.Path(__file__).resolve().parent))
sys.dont_write_bytecode = True  # no __pycache__ in the source tree
from jdtls_harness import (Lsp, check, debug_session, finish, free_port, kill, report, start_jdtls,  # noqa: E402
                           stop_jdtls, wait_ready)

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


def major(java):
    out = subprocess.run([java, '-version'], capture_output=True, text=True).stderr
    version = re.search(r'version "([^"]+)"', out).group(1)
    parts = version.split('.')
    return int(parts[1]) if parts[0] == '1' else int(re.match(r'\d+', parts[0]).group())


class InspectLsp(Lsp):
    def inspect(self, name, *arguments, timeout=180):
        return self.command('openidea.jvm.' + name, *arguments, timeout=timeout)


# resolved: on macOS the temp dir is under the /var symlink, and JDT LS matches canonical URIs
work = pathlib.Path(tempfile.mkdtemp(prefix='openidea-jvm-inspect-')).resolve()
project = work / 'project'
(project / 'src').mkdir(parents=True)
(project / 'src' / 'Heap.java').write_text(HEAP)
source = str(project / 'src' / 'Heap.java')
classes = work / 'classes'
subprocess.run(['javac', '-g', '--release', '8', '-Xlint:-options', '-d', str(classes), source], check=True)
jdtls = lsp = None
jvms = []  # debuggees started here
launched = []  # pids of debuggees java-debug started
project_name = None
modules, classpaths = [], []


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
    return debug_session(lsp, 'openidea-jvm-inspect')


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
    wanted = COMMANDS + ['vscode.java.startDebugSession']
    jdtls, lsp, registered = start_jdtls(home, work, project, [java_debug, bundle], wanted, InspectLsp)
    if not check('JDT LS registers the bundle commands and java-debug', all(c in registered for c in wanted),
                 [c for c in registered if c.startswith(('openidea', 'vscode.java.start'))]):
        sys.exit(1)
    wait_ready(lsp)
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
    kill(jvms, launched)
    if lsp:
        stop_jdtls(jdtls, lsp)
sys.exit(finish(work))
