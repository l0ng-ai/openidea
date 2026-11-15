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
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import time

# -I leaves the script's directory off sys.path; the shared harness lives there. Appended, not
# prepended: tests/inspect.py would shadow the standard library's `inspect`.
sys.path.append(str(pathlib.Path(__file__).resolve().parent))
sys.dont_write_bytecode = True  # no __pycache__ in the source tree
from jdtls_harness import (check, debug_session, finish, free_port, kill, report, start_jdtls, stop_jdtls,  # noqa: E402
                           wait_ready)

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
# resolved: on macOS the temp dir is under the /var symlink, and JDT LS matches canonical URIs
work = pathlib.Path(tempfile.mkdtemp(prefix='openidea-jvm-stream-')).resolve()
project = work / 'project'
(project / 'src').mkdir(parents=True)
for name, text in PROGRAMS.items():
    (project / 'src' / f'{name}.java').write_text(text)
classes = work / 'classes'
subprocess.run(['javac', '-g', '--release', '8', '-Xlint:-options', '-d', str(classes),
                *[str(project / 'src' / f'{n}.java') for n in PROGRAMS]], check=True)
jdtls = lsp = None
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
    return debug_session(lsp, 'openidea-jvm-stream')


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


@case
def deleted_breakpoint_stays_deleted():
    dbg = launch()
    try:
        trace = ok(arm(dbg))['traceId']
        breakpoints(dbg)  # java-debug deletes the silenced request
        ok(stream('release', dbg, traceId=trace))
        resume(dbg)
        check('a breakpoint removed while armed does not come back after release', no_stop(dbg, 1.5))
    finally:
        dbg.end()


@case
def budget_out_of_range():
    dbg = launch()
    try:
        for budget in (0, -1, 2.5, 2 ** 31):
            r = arm(dbg, budget=budget)
            check(f'arm with budget {budget} is badArgument', error(r) == 'badArgument', r)
    finally:
        dbg.end()


def run():
    global jdtls, lsp, project_name, java
    uri = project.as_uri()
    wanted = STREAM_COMMANDS + ['vscode.java.startDebugSession']
    jdtls, lsp, registered = start_jdtls(home, work, project, [java_debug, bundle], wanted)
    if not check('JDT LS registers the stream commands and java-debug', all(c in registered for c in wanted),
                 [c for c in registered if c.startswith(('openidea', 'vscode.java.start'))]):
        return
    wait_ready(lsp)
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


try:
    run()
except Exception as e:
    report('FAIL', 'harness', repr(e))
finally:
    kill(jvms, launched)
    if lsp:
        stop_jdtls(jdtls, lsp)
sys.exit(finish(work))
