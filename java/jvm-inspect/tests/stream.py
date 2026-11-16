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
import signal
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
# One chain per method; `main` runs the method named by its argument. The chains of A, B, C, D, G and H
# are those of the spike behind the spec's Grounding (§2, G1).
REAL = '''import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.locks.LockSupport;
import java.util.stream.Collectors;
import java.util.stream.IntStream;
import java.util.stream.Stream;

public class Real {
    static int sideEffects;
    static final List<Integer> nums = new ArrayList<>(Arrays.asList(5, 3, 8, 1, 4, 2, 9, 6));

    static boolean keep(int x) {
        sideEffects++;
        return x % 2 == 0;
    }

    static final class Hostile {
        final int v;

        Hostile(int v) {
            this.v = v;
        }

        @Override
        public String toString() {
            throw new IllegalStateException("hostile toString");
        }
    }

    public static void main(String[] a) throws Exception {
        switch (a[0]) {
            case "A": a(); break;
            case "B": b(); break;
            case "C": c(); break;
            case "D": d(); break;
            case "G": g(); break;
            case "H": h(); break;
            case "local": local(); break;
            case "parallel": parallel(); break;
            case "nested": nested(); break;
            case "hostile": hostile(); break;
            case "sr": stopRecording(Integer.parseInt(a[1])); break;
            case "rel": releaseRunning(Integer.parseInt(a[1])); break;
            case "inl": inLambda(); break;
            case "abort": abort(); break;
            case "twice": abortAfterTrace(); break;
            case "exit": exit(); break;
            case "mid": mid(); break;
            case "fn": functionAndData(); break;
            case "throws": throwsBeforeRoot(); break;
            case "hit": hitWhileRunning(Integer.parseInt(a[1])); break;
            default: throw new IllegalArgumentException(a[0]);
        }
        System.out.println("END");
    }

    static void a() {
        int base = 1;
        List<String> out = nums.stream() // @A
                .filter(Real::keep)
                .map(x -> x * 10 + base)
                .sorted()
                .map(String::valueOf)
                .collect(Collectors.toList());
        System.out.println("A " + out + " side=" + sideEffects);
    }

    static void b() {
        int sum = IntStream.range(0, 20).filter(i -> i % 3 == 0).map(i -> i * i).sum(); // @B
        System.out.println("B " + sum);
    }

    static void c() {
        long n = nums.stream().filter(x -> x > 100).count(); // @C
        System.out.println("C " + n);
    }

    static void d() {
        long t0 = System.nanoTime();
        long d = IntStream.range(0, 1_000_000).filter(i -> i % 7 == 0).mapToObj(Integer::toString).filter(s -> s.endsWith("7")).count(); // @D
        System.out.println("D " + d + " ms=" + (System.nanoTime() - t0) / 1_000_000);
    }

    static void g() {
        try {
            List<Integer> g = nums.stream().map(x -> 10 / (x - 4)).collect(Collectors.toList()); // @G
            System.out.println("G " + g);
        } catch (ArithmeticException ex) {
            System.out.println("G caught " + ex.getMessage()); // @G_catch
        }
    }

    static void h() {
        int h = nums.stream().mapToInt(x -> { // @H
            int y = x * 2; // @H_in
            return y;
        }).sum();
        System.out.println("H " + h);
        long next = nums.stream().count(); // @H_next
        System.out.println("H next " + next);
    }

    static void local() {
        List<Integer> list = nums;
        Stream<Integer> s = nums.stream();
        long k = s.filter(x -> x > 5).count(); // @local
        System.out.println("LOCAL " + k + " " + list.size());
    }

    static void parallel() {
        List<Integer> p = nums.parallelStream().map(x -> x + 1).collect(Collectors.toList()); // @parallel
        List<Integer> q = nums.stream().parallel().map(x -> x * 2).collect(Collectors.toList()); // @parallel2
        System.out.println("P " + p + " " + q);
    }

    static void nested() {
        long n = nums.stream().flatMap(x -> Stream.of(x, x)).count(); // @nested
        System.out.println("NESTED " + n);
    }

    static void hostile() {
        List<Hostile> hs = new ArrayList<>();
        for (int i = 1; i <= 3; i++) hs.add(new Hostile(i));
        long n = hs.stream().filter(x -> x.v > 0).count(); // @hostile
        System.out.println("HOSTILE " + n);
    }

    /** Slow enough that "stop recording" lands while the terminal runs, with few records to collect. */
    static boolean evenSlowly(int i) {
        if (i % 10 == 0) LockSupport.parkNanos(1_000_000);
        if (i == 25_000) {
            sideEffects++; // @sr_late
        }
        return i % 2 == 0;
    }

    static void stopRecording(int size) {
        long n = Stream.iterate(0, i -> i + 1).limit(size).filter(Real::evenSlowly).count(); // @sr
        System.out.println("SR " + n); // @sr_old
        System.out.println("SR next"); // @sr_new
    }

    static void releaseRunning(int size) {
        long n = Stream.iterate(0, i -> i + 1).limit(size).filter(Real::evenSlowly).count(); // @rel
        long m = nums.stream().filter(x -> x > 4).count(); // @rel_next
        System.out.println("REL " + n + " " + m);
    }

    static void inLambda() {
        Runnable r = () -> {
            long k = nums.stream().filter(x -> x > 4).count(); // @in_lambda
            System.out.println("INL " + k);
        };
        r.run();
    }

    static void abort() {
        try {
            Optional<Integer> f = Stream.generate(() -> 1).filter(x -> x > 1).findFirst(); // @abort
            System.out.println("ABORT none " + f);
        } catch (RuntimeException e) {
            System.out.println("ABORT caught " + e.getMessage()); // @abort_catch
        }
    }

    static void abortAfterTrace() {
        long evens = nums.stream().filter(x -> x % 2 == 0).map(x -> x * 10).count(); // @twice_a
        System.out.println("TWICE A " + evens);
        try {
            long never = Stream.iterate(1L, x -> x + 1).filter(x -> x % 7 == 0).map(x -> x * 2).filter(x -> x < 0).count(); // @twice_endless
            System.out.println("TWICE none " + never);
        } catch (RuntimeException e) {
            System.out.println("TWICE caught " + e.getMessage());
        }
    }

    static void exit() {
        List<Integer> e = nums.stream().filter(x -> { // @exit
            if (x == 8) System.exit(3);
            return true;
        }).collect(Collectors.toList());
        System.out.println("EXIT not reached " + e);
    }

    static void mid() {
        List<String> m = nums.stream().map(String::valueOf).collect(Collectors.toList()); // @mid
        List<String> head = // @head
                nums.stream()
                        .map(String::valueOf)
                        .collect(Collectors.toList());
        System.out.println("MID " + m + " " + head);
    }

    static int touched;

    static boolean touch(int x) {
        touched++; // @touch
        return x % 2 == 0;
    }

    static void functionAndData() {
        long n = nums.stream().filter(Real::touch).count(); // @fn
        System.out.println("FN " + n);
        touch(1); // @fn_after
        System.out.println("FN after " + touched);
    }

    static List<Integer> parse(String s) {
        return new ArrayList<>(Arrays.asList(Integer.parseInt(s)));
    }

    static void escapes() {
        long n = parse("x").stream().filter(x -> x > 0).count(); // @escapes
        System.out.println("ESCAPES not reached " + n);
    }

    static void escapesLater() {
        long n = nums.stream().filter(x -> x > 0).limit(parse("z").size()).count(); // @escapes_later
        System.out.println("ESCAPES_LATER not reached " + n);
    }

    static void throwsBeforeRoot() {
        try {
            escapes();
        } catch (NumberFormatException e) {
            System.out.println("ESCAPES caught by the caller");
        }
        try {
            escapesLater();
        } catch (NumberFormatException e) {
            System.out.println("ESCAPES_LATER caught by the caller"); // @later_landing
            System.out.println("ESCAPES_LATER after the catch's first line"); // @later_catch
        }
        long n;
        try {
            n = parse("y").stream().filter(x -> x > 0).count(); // @caught
        } catch (NumberFormatException e) {
            n = -1;
        }
        long m = nums.stream().count();
        System.out.println("THROWS " + n + " " + m); // @throws_end
    }

    static void hitWhileRunning(int size) {
        long n = Stream.iterate(0, i -> i + 1).limit(size).filter(Real::evenSlowly).count(); // @hit
        evenSlowly(25_000);
        System.out.println("HIT " + n);
    }
}
'''
# Compiled with ECJ, as JDT LS builds a project: a declaration head like `List<String> out =` gets no
# code of its own, and an assignment head's only code is the store after the chain.
ECJ = '''import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.stream.Collectors;

public class Ecj {
    static final List<Integer> nums = new ArrayList<>(Arrays.asList(5, 3, 8, 1, 4, 2, 9, 6));

    public static void main(String[] a) {
        List<String> out = // @ecj_head
                nums.stream() // @ecj_first
                        .map(String::valueOf)
                        .collect(Collectors.toList());
        long n;
        n = // @ecj_assign
                nums.stream().filter(x -> x > 4).count();
        System.out.println("ECJ " + out + " " + n);
    }
}
'''
PROGRAMS = {'Chains': CHAINS, 'Real': REAL, 'Ecj': ECJ}
ECJ_PROGRAMS = {'Ecj'}

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
                *[str(project / 'src' / f'{n}.java') for n in PROGRAMS if n not in ECJ_PROGRAMS]], check=True)
subprocess.run(['java', '-cp', str(home / 'plugins' / '*'), 'org.eclipse.jdt.internal.compiler.batch.Main', '-8', '-g', '-proc:none',
                '-nowarn', '-d', str(classes), *[str(project / 'src' / f'{n}.java') for n in ECJ_PROGRAMS]], check=True)
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


def launch(program='Chains', stop_at=('loop',), args=''):
    """A launch of `program` with `args` stopped at the first of the `stop_at` lines."""
    d = session()
    dbg = Debuggee(d, program, {})
    start(dbg, 'launch', {'mainClass': program, 'projectName': project_name, 'modulePaths': [], 'classPaths': [str(classes)],
                          'cwd': str(project), 'console': 'internalConsole', 'shortenCommandLine': 'none', 'javaExec': java,
                          'args': args},
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
    first = line(at, program) - 1
    return {'root': root, 'local': local, 'steps': list(steps), 'terminal': terminal, 'classFilters': list(class_filters),
            'stepKinds': list(step_kinds), 'sequentialize': sequentialize, 'firstLine': first,
            'lastLine': statement_end(program, first)}


def statement_end(program, first):
    """0-based line of the `;` that ends the statement starting on 0-based line `first`, lambda bodies skipped."""
    depth = 0
    for i, text in enumerate(PROGRAMS[program].splitlines()[first:], first):
        for ch in text.split('//')[0]:
            depth += ch in '({'
            depth -= ch in ')}'
            if ch == ';' and depth == 0:
                return i
    raise ValueError(f'no statement end after line {first + 1}')


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
        # (stop on a fresh trace takes it down: real_run_cancel_before_terminal)
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


# The real run: arm → DAP continue → wait until parked → DAP stepOut → collect.

def real(name, *stop_at, extra=()):
    """A launch of `Real <name> <extra...>` stopped at the first of `stop_at` (default: the line named `name`)."""
    return launch('Real', stop_at=stop_at or (name,), args=' '.join((name, *map(str, extra))))


def wait_until_done(dbg, trace, timeout=60):
    end = time.time() + timeout
    while True:
        state = ok(stream('wait', dbg, traceId=trace, ms=1000))
        if state['state'] != 'running' or time.time() > end:
            return state


def run_until_parked(dbg, at, budget=50_000, timeout=60, **plan_args):
    """Arms at line `at`, continues; returns (traceId, last wait reply, ms from continue to that reply)."""
    trace = ok(arm(dbg, at=at, budget=budget, **plan_args))['traceId']
    t = time.time()
    resume(dbg)
    state = wait_until_done(dbg, trace, timeout)
    return trace, state, (time.time() - t) * 1000


def step_out_and_collect(dbg, trace):
    step_out(dbg)
    return ok(stream('collect', dbg, traceId=trace))


def show(value):
    kind = value.get('kind')
    if kind in ('boxed', 'primitive'):
        return value.get('text')
    if kind == 'string':
        return '"' + str(value.get('text')) + '"'
    if kind == 'null':
        return 'null'
    return value.get('typeName')


def tokens(collected):
    return [f"{r['step']}={show(r['value'])}" for r in collected['records']]


def terminal_text(collected):
    t = collected['terminal']
    return show(t['value']) if t['kind'] == 'value' else t['kind']


def output_line(dbg, prefix, timeout=30):
    """The first program output line starting with `prefix`, waiting for it; None when none comes."""
    end = time.time() + timeout
    while time.time() < end:
        for text in ''.join(dbg.dap.output).splitlines():
            if text.startswith(prefix):
                return text
        time.sleep(0.1)
    return None


def collected_ok(name, collected, records=None, terminal=None, steps=None):
    if records is not None:
        check(f'{name}: records', tokens(collected) == records if isinstance(records, list) else len(collected['records']) == records,
              ' '.join(tokens(collected)[:40]))
    if terminal is not None:
        check(f'{name}: terminal is {terminal}', terminal_text(collected) == terminal, collected['terminal'])
    if steps is not None:
        check(f'{name}: recorded steps', sorted({r['step'] for r in collected['records']}) == steps,
              sorted({r['step'] for r in collected['records']}))


PLAN_A = dict(root=spec('stream'), steps=(spec('filter', 1), spec('map', 1), spec('sorted'), spec('map', 1)), terminal=spec('collect', 1),
              step_kinds=('sync', 'sync', 'reorder', 'sync'))
GROUNDING_A = '0=5 0=3 0=8 1=8 2=81 0=1 0=4 1=4 2=41 0=2 1=2 2=21 0=9 0=6 1=6 2=61 3=21 4="21" 3=41 4="41" 3=61 4="61" 3=81 4="81"'


@case
def real_run_a():
    dbg = real('A')
    try:
        trace, state, _ = run_until_parked(dbg, 'A', **PLAN_A)
        check('A: wait reaches parked', state['state'] == 'parked' and state['records'] == 24, state)
        c = step_out_and_collect(dbg, trace)
        collected_ok('A', c, records=GROUNDING_A.split())
        t = c['terminal']
        check('A: the terminal is the ArrayList collect returned, with an id',
              t['kind'] == 'value' and t['value'].get('typeName') == 'java.util.ArrayList' and 'id' in t['value'], t)
        check('A: nothing dropped, no breakpoint skipped but the chain\'s own, not sequentialized',
              c['dropped'] == 0 and c['skippedBreakpoints'] == 1 and c['sequentialized'] is False, c)
        resume(dbg)
        out = output_line(dbg, 'A ')
        check('A: the program ran each lambda once (side=8)', out == 'A [21, 41, 61, 81] side=8', out)
    finally:
        dbg.end()


@case
def real_run_b_c():
    dbg = real('B')
    try:
        trace, state, _ = run_until_parked(dbg, 'B', root=spec('range', 2), steps=(spec('filter', 1), spec('map', 1)),
                                           terminal=spec('sum'), class_filters=('java.util.stream.*',))
        c = step_out_and_collect(dbg, trace)
        collected_ok('B', c, records=34, terminal='819')
        resume(dbg)
        check('B: program output', output_line(dbg, 'B ') == 'B 819')
    finally:
        dbg.end()
    dbg = real('C')
    try:
        trace, state, _ = run_until_parked(dbg, 'C', steps=(spec('filter', 1),), terminal=spec('count'), step_kinds=('sync',))
        c = step_out_and_collect(dbg, trace)
        collected_ok('C', c, records=8, terminal='0')
    finally:
        dbg.end()


@case
def real_run_d_million():
    dbg = real('D')
    try:
        trace, state, ms = run_until_parked(dbg, 'D', root=spec('range', 2),
                                            steps=(spec('filter', 1), spec('mapToObj', 1), spec('filter', 1)), terminal=spec('count'),
                                            class_filters=('java.util.stream.*',), step_kinds=('sync', 'sync', 'sync'))
        report('NOTE', f'D: continue to parked {ms:.0f} ms')
        check('D: continue to parked under 2000 ms', state['state'] == 'parked' and ms < 2000, f'{state} in {ms:.0f} ms')
        t = time.time()
        c = step_out_and_collect(dbg, trace)
        report('NOTE', f'D: stepOut + collect {(time.time() - t) * 1000:.0f} ms')
        collected_ok('D', c, records=50_000, terminal='14286')
        check('D: dropped past the budget', c['dropped'] == 1_250_002, c['dropped'])
        resume(dbg)
        out = output_line(dbg, 'D ')
        check('D: program output', out is not None and out.startswith('D 14286 '), out)
    finally:
        dbg.end()


@case
def real_run_g_throws():
    dbg = real('G')
    try:
        trace, state, _ = run_until_parked(dbg, 'G', steps=(spec('map', 1),), step_kinds=('sync',))
        check('G: parked after the lambda threw', state['state'] == 'parked', state)
        c = step_out_and_collect(dbg, trace)
        t = c['terminal']
        check('G: the terminal threw ArithmeticException',
              t['kind'] == 'threw' and t['exception'].get('typeName') == 'java.lang.ArithmeticException', t)
        check('G: stepOut lands in the catch', top(dbg)['line'] == line('G_catch', 'Real'), top(dbg))
        resume(dbg)
        check('G: program output', output_line(dbg, 'G ') == 'G caught / by zero')
    finally:
        dbg.end()


@case
def real_run_h_breakpoint_in_lambda():
    dbg = real('H', 'H', 'H_in', 'H_next')
    try:
        trace, state, _ = run_until_parked(dbg, 'H', steps=(spec('mapToInt', 1),), terminal=spec('sum'), step_kinds=('sync',))
        check('H: parked though a breakpoint sits in the lambda', state['state'] == 'parked', state)
        c = step_out_and_collect(dbg, trace)
        collected_ok('H', c, records=16, terminal='76')
        check('H: the silenced breakpoints are reported', c['skippedBreakpoints'] >= 1, c['skippedBreakpoints'])
        resume(dbg)
        try:
            expect_stop(dbg, 20, 'next chain')
            check('H: the next chain\'s breakpoint still stops', top(dbg)['line'] == line('H_next', 'Real'), top(dbg))
        except TimeoutError:
            check('H: the next chain\'s breakpoint still stops', False, 'no stop')
        check('H: program output', output_line(dbg, 'H ') == 'H 76')
    finally:
        dbg.end()


@case
def real_run_local_root():
    dbg = real('local')
    try:
        r = arm(dbg, at='local', root=None, local='list', steps=(spec('filter', 1),), terminal=spec('count'), step_kinds=('sync',))
        check('local: a local declared as a List is unsupported', error(r) == 'unsupported', r)
        trace, state, _ = run_until_parked(dbg, 'local', root=None, local='s', steps=(spec('filter', 1),), terminal=spec('count'),
                                           class_filters=('java.util.stream.*',), step_kinds=('sync',))
        c = step_out_and_collect(dbg, trace)
        collected_ok('local', c, terminal='3')
        check('local: step 0 recorded every element', sum(r['step'] == 0 for r in c['records']) == 8, tokens(c))
        resume(dbg)
        check('local: program output', output_line(dbg, 'LOCAL ') == 'LOCAL 3 8')
    finally:
        dbg.end()


@case
def real_run_parallel():
    dbg = real('parallel', 'parallel', 'parallel2')
    try:
        trace, state, _ = run_until_parked(dbg, 'parallel', root=spec('parallelStream'), steps=(spec('map', 1),), step_kinds=('sync',),
                                           sequentialize=True)
        c = step_out_and_collect(dbg, trace)
        collected_ok('parallelStream', c, records='0=5 1=6 0=3 1=4 0=8 1=9 0=1 1=2 0=4 1=5 0=2 1=3 0=9 1=10 0=6 1=7'.split())
        check('parallelStream: sequentialized', c['sequentialized'] is True, c['sequentialized'])
        resume(dbg)
        expect_stop(dbg, 20, 'parallel2')
        trace, state, _ = run_until_parked(dbg, 'parallel2', steps=(spec('parallel'), spec('map', 1)), step_kinds=('sync',),
                                           sequentialize=True)
        c = step_out_and_collect(dbg, trace)
        collected_ok('parallel()', c, records='0=5 1=10 0=3 1=6 0=8 1=16 0=1 1=2 0=4 1=8 0=2 1=4 0=9 1=18 0=6 1=12'.split())
        resume(dbg)
        check('parallel: program output', output_line(dbg, 'P ') == 'P [6, 4, 9, 2, 5, 3, 10, 7] [10, 6, 16, 2, 8, 4, 18, 12]')
    finally:
        dbg.end()


@case
def real_run_nested():
    dbg = real('nested')
    try:
        trace, state, _ = run_until_parked(dbg, 'nested', steps=(spec('flatMap', 1),), terminal=spec('count'), step_kinds=('sync',))
        c = step_out_and_collect(dbg, trace)
        collected_ok('nested', c, records=24, terminal='16', steps=[0, 1])
    finally:
        dbg.end()


@case
def real_run_hostile_to_string():
    dbg = real('hostile')
    try:
        trace, state, _ = run_until_parked(dbg, 'hostile', steps=(spec('filter', 1),), terminal=spec('count'), step_kinds=('sync',))
        c = step_out_and_collect(dbg, trace)
        collected_ok('hostile', c, records=['0=Real$Hostile', '1=Real$Hostile'] * 3, terminal='3')
        resume(dbg)
        out = output_line(dbg, 'END')
        text = ''.join(dbg.dap.output)
        check('hostile: no toString ran', out == 'END' and 'hostile toString' not in text and 'Exception' not in text, text[-500:])
    finally:
        dbg.end()


SR_SIZE = 30_000  # about 3 s: the filter parks 1 ms every 10 elements


@case
def real_run_stop_recording_and_edit_breakpoints():
    dbg = real('sr', 'sr', 'sr_old', extra=(SR_SIZE,))
    try:
        trace = ok(arm(dbg, at='sr', root=spec('iterate', 2), steps=(spec('limit', 1), spec('filter', 1)),
                       terminal=spec('count'), class_filters=('java.util.stream.*',)))['traceId']
        resume(dbg)
        first = ok(stream('wait', dbg, traceId=trace, ms=300))
        check('stop-recording: still running after 300 ms, records growing below the budget',
              first['state'] == 'running' and 0 < first['records'] < 50_000, first)
        kept = ok(stream('stop', dbg, traceId=trace))['records']
        # sr_late runs inside the terminal's invoke about 2 s from now: hit there, it would hang the session.
        dbg.dap.request('setBreakpoints', {'source': {'path': source('Real')},
                                           'breakpoints': [{'line': line(n, 'Real')} for n in ('sr', 'sr_new', 'sr_late')]})
        later = ok(stream('wait', dbg, traceId=trace, ms=300))
        check('stop-recording: records stop growing', later['records'] <= kept + 1 and later['dropped'] > first['dropped'], (kept, later))
        state = wait_until_done(dbg, trace, 120)
        check('stop-recording: the terminal still finishes', state['state'] == 'parked', state)
        c = step_out_and_collect(dbg, trace)
        collected_ok('stop-recording', c, records=later['records'], terminal=str(SR_SIZE // 2))
        resume(dbg)
        try:
            expect_stop(dbg, 20, 'edited breakpoint')
            check('edit-breakpoints: stops at the breakpoint added mid-trace, not the removed one',
                  top(dbg)['line'] == line('sr_new', 'Real'), top(dbg))
        except TimeoutError:
            check('edit-breakpoints: stops at the breakpoint added mid-trace, not the removed one', False, 'no stop')
    finally:
        dbg.end()


@case
def real_run_abort():
    dbg = real('abort')
    try:
        trace = ok(arm(dbg, at='abort', root=spec('generate', 1), steps=(spec('filter', 1),), terminal=spec('findFirst'),
                       class_filters=('java.util.stream.*',), step_kinds=('sync',)))['traceId']
        resume(dbg)
        first = ok(stream('wait', dbg, traceId=trace, ms=500))
        check('abort: the endless terminal is running', first['state'] == 'running', first)
        t = time.time()
        r = ok(stream('abort', dbg, traceId=trace, timeout=30))
        report('NOTE', f'abort: {r} in {(time.time() - t) * 1000:.0f} ms')
        check('abort: interrupted or stopped', r.get('state') in ('interrupted', 'stopped'), r)
        state = wait_until_done(dbg, trace, 20)
        check('abort: parked after the cancel', state['state'] == 'parked', state)
        c = step_out_and_collect(dbg, trace)
        t = c['terminal']
        check('abort: the terminal threw the cancel exception',
              t['kind'] == 'threw' and t['exception'].get('typeName') == 'java.lang.RuntimeException', t)
        resume(dbg)
        out = output_line(dbg, 'ABORT ')
        check('abort: the program caught oi-cancel', out is not None and out.startswith('ABORT caught oi-cancel:'), out)
    finally:
        dbg.end()


@case
def real_run_abort_after_a_trace():
    # The first trace loads every class the endless terminal needs, so no class is prepared inside its
    # invoke: no event of the thread's own then comes between the terminal's entry and the abort.
    dbg = real('twice', 'twice_a', 'twice_endless')
    try:
        trace, state, _ = run_until_parked(dbg, 'twice_a', terminal=spec('count'), timeout=20)
        check('abort-after-trace: the first trace parks', state['state'] == 'parked', state)
        collected_ok('abort-after-trace', step_out_and_collect(dbg, trace), records=16, terminal='4')
        resume(dbg)
        expect_stop(dbg, 20, 'twice_endless')
        trace = ok(arm(dbg, at='twice_endless', root=spec('iterate', 2), steps=(spec('filter', 1), spec('map', 1), spec('filter', 1)),
                       terminal=spec('count'), class_filters=('java.util.stream.*',), step_kinds=('sync', 'sync', 'sync')))['traceId']
        resume(dbg)
        first = ok(stream('wait', dbg, traceId=trace, ms=500))
        check('abort-after-trace: the endless terminal is running', first['state'] == 'running', first)
        t = time.time()
        r = ok(stream('abort', dbg, traceId=trace, timeout=30))
        report('NOTE', f'abort-after-trace: {r} in {(time.time() - t) * 1000:.0f} ms')
        check('abort-after-trace: interrupted or stopped', r.get('state') in ('interrupted', 'stopped'), r)
        state = wait_until_done(dbg, trace, 20)
        check('abort-after-trace: parked after the cancel', state['state'] == 'parked', state)
        if state['state'] != 'parked':
            return
        c = step_out_and_collect(dbg, trace)
        t = c['terminal']
        check('abort-after-trace: the terminal threw the cancel exception',
              t['kind'] == 'threw' and t['exception'].get('typeName') == 'java.lang.RuntimeException', t)
        resume(dbg)
        out = output_line(dbg, 'TWICE caught')
        check('abort-after-trace: the program caught oi-cancel', out is not None and out.startswith('TWICE caught oi-cancel:'), out)
    finally:
        dbg.end()


def next_breakpoint_stops(dbg, name, what):
    """After a trace that ended without parking: the user's breakpoints are back on."""
    try:
        expect_stop(dbg, 20, what)
        check(f'{name}: the next chain\'s breakpoint still stops', top(dbg)['line'] == line('H_next', 'Real'), top(dbg))
    except TimeoutError:
        check(f'{name}: the next chain\'s breakpoint still stops', False, 'no stop')
    resume(dbg)


PLAN_H = dict(steps=(spec('mapToInt', 1),), terminal=spec('sum'), step_kinds=('sync',))


@case
def real_run_cancel_before_terminal():
    dbg = real('H', 'H', 'H_next')
    try:
        trace = ok(arm(dbg, at='H', **PLAN_H))['traceId']
        check('cancel: stop while armed answers the records', ok(stream('stop', dbg, traceId=trace)) == {'records': 0})
        state = ok(stream('wait', dbg, traceId=trace, ms=0))
        check('cancel: stop before the terminal cancels the trace', state['state'] == 'cancelled'
              and state.get('detail') == 'cancelled before the terminal ran', state)
        r = stream('collect', dbg, traceId=trace)
        check('cancel: collect on a cancelled trace is failed', error(r) == 'failed', r)
        trace = ok(arm(dbg, at='H', **PLAN_H))['traceId']
        r = ok(stream('abort', dbg, traceId=trace))
        check('cancel: abort before the terminal is cancelled', r == {'state': 'cancelled'}, r)
        resume(dbg)
        next_breakpoint_stops(dbg, 'cancel', 'H_next after cancel')
        check('cancel: the program runs on untouched', output_line(dbg, 'H ') == 'H 76')
    finally:
        dbg.end()


@case
def real_run_missed_step():
    dbg = real('H', 'H', 'H_next')
    try:
        trace, state, _ = run_until_parked(dbg, 'H', steps=(spec('map', 1),), terminal=spec('sum'), step_kinds=('sync',), timeout=20)
        check('missed: a chain unlike the plan fails', state['state'] == 'failed' and state.get('detail') == 'missed map', state)
        next_breakpoint_stops(dbg, 'missed', 'H_next after missed')
        check('missed: the program runs on untouched', output_line(dbg, 'H ') == 'H 76')
    finally:
        dbg.end()


@case
def real_run_release_while_running():
    dbg = real('rel', 'rel', 'rel_next', extra=(SR_SIZE,))
    try:
        trace = ok(arm(dbg, at='rel', root=spec('iterate', 2), steps=(spec('limit', 1), spec('filter', 1)),
                       terminal=spec('count'), class_filters=('java.util.stream.*',)))['traceId']
        resume(dbg)
        first = ok(stream('wait', dbg, traceId=trace, ms=300))
        check('release-running: the terminal runs', first['state'] == 'running' and first['records'] > 0, first)
        ok(stream('release', dbg, traceId=trace))
        state = wait_until_done(dbg, trace, 60)
        check('release-running: wait after the terminal returned is no longer running',
              state['state'] == 'failed' and state.get('detail') == 'released', state)
        r = ok(stream('abort', dbg, traceId=trace))
        check('release-running: abort leaves the thread alone', r == {'state': 'finished'}, r)
        try:
            expect_stop(dbg, 20, 'rel_next')
            check('release-running: the next breakpoint stops', top(dbg)['line'] == line('rel_next', 'Real'), top(dbg))
        except TimeoutError:
            check('release-running: the next breakpoint stops', False, 'no stop')
            return
        trace, state, _ = run_until_parked(dbg, 'rel_next', steps=(spec('filter', 1),), terminal=spec('count'), step_kinds=('sync',))
        check('release-running: a new arm on the VM parks', state['state'] == 'parked', state)
        c = step_out_and_collect(dbg, trace)
        collected_ok('release-running', c, terminal='4')
        resume(dbg)
        check('release-running: program output', output_line(dbg, 'REL ') == f'REL {SR_SIZE // 2} 4')
    finally:
        dbg.end()


@case
def real_run_lambda_frame():
    # Stopped inside the chain's own lambda, with the plan of that chain: its lines pass the line check.
    dbg = real('H', 'H_in')
    try:
        frame = top(dbg)
        check('lambda: stopped inside the chain\'s lambda', 'lambda$' in frame['name'], frame)
        r = arm(dbg, at='H', **PLAN_H)
        check('lambda: arm in a lambda of the chain is notAtChainStart', error(r) == 'notAtChainStart', r)
        breakpoints(dbg)
        resume(dbg)
        check('lambda: program output', output_line(dbg, 'H ') == 'H 76')
    finally:
        dbg.end()
    dbg = real('inl', 'in_lambda')
    try:
        trace, state, _ = run_until_parked(dbg, 'in_lambda', steps=(spec('filter', 1),), terminal=spec('count'), step_kinds=('sync',))
        check('lambda: a chain written inside a lambda body is traced', state['state'] == 'parked', state)
        c = step_out_and_collect(dbg, trace)
        collected_ok('chain in a lambda', c, terminal='4')
        resume(dbg)
        check('chain in a lambda: program output', output_line(dbg, 'INL ') == 'INL 4')
    finally:
        dbg.end()


@case
def real_run_exit_in_lambda():
    dbg = real('exit')
    try:
        trace = ok(arm(dbg, at='exit', steps=(spec('filter', 1),), step_kinds=('sync',)))['traceId']
        t = time.time()
        resume(dbg)
        state = ok(stream('wait', dbg, traceId=trace, ms=5000))
        ms = (time.time() - t) * 1000
        report('NOTE', f'exit-in-lambda: continue to failed {ms:.0f} ms')
        # HotSpot does not finish exiting while the exiting thread is inside a JDI invoke: no disconnect comes.
        check('exit-in-lambda: wait answers failed within 5 s', state['state'] == 'failed' and ms < 5000
              and 'began to exit' in state.get('detail', ''), f'{state} in {ms:.0f} ms')
        again = stream('wait', dbg, traceId=trace, ms=0)
        check('exit-in-lambda: a later wait still answers failed', again.get('ok', {}).get('state') == 'failed', again)
        t = time.time()
        r = stream('release', dbg, traceId=trace)
        check('exit-in-lambda: release does not wait on the stuck invoke', 'ok' in r and time.time() - t < 2, r)
    finally:
        dbg.end()
        # java-debug's terminate does not end the wedged VM either; while it lingers, new launches can stall.
        time.sleep(2)
        try:
            os.kill(dbg.target['pid'], signal.SIGKILL)
            report('NOTE', 'exit-in-lambda: the VM outlived the session\'s terminate; killed')
        except (ProcessLookupError, PermissionError, TypeError):
            pass


@case
def real_run_mid_line():
    dbg = real('mid', 'mid', 'head')
    try:
        plan_mid = dict(steps=(spec('map', 1),), step_kinds=('sync',))
        trace = ok(arm(dbg, at='mid', **plan_mid))['traceId']
        check('mid-line: arm at the chain\'s breakpoint works', trace is not None)
        ok(stream('release', dbg, traceId=trace))
        dbg.dap.request('stepIn', {'threadId': dbg.thread})
        expect_stop(dbg, 20, 'stepIn')
        step_out(dbg)
        check('mid-line: stepOut is back on the chain\'s line', top(dbg)['line'] == line('mid', 'Real'), top(dbg))
        r = arm(dbg, at='mid', **plan_mid)
        check('mid-line: arm after the first call is notAtChainStart', error(r) == 'notAtChainStart', r)
        resume(dbg)
        expect_stop(dbg, 20, 'head')
        trace, state, _ = run_until_parked(dbg, 'head', **plan_mid)
        c = step_out_and_collect(dbg, trace)
        collected_ok('declaration head on its own line (javac)', c, records=16)
    finally:
        dbg.end()


@case
def real_run_ecj_heads():
    dbg = launch('Ecj', stop_at=('ecj_first', 'ecj_assign'))
    try:
        plan_out = dict(steps=(spec('map', 1),), step_kinds=('sync',), program='Ecj')
        r = stream('arm', dbg, threadId=dbg.thread, plan=plan('ecj_head', **plan_out), budget=50_000)
        check('ECJ: arm at the first code of a statement whose head line has none', 'ok' in r, r)
        trace = ok(r)['traceId']
        resume(dbg)
        state = wait_until_done(dbg, trace, 20)
        c = step_out_and_collect(dbg, trace)
        collected_ok('ECJ head', c, records=16)
        resume(dbg)
        expect_stop(dbg, 20, 'ecj_assign')
        r = stream('arm', dbg, threadId=dbg.thread, budget=50_000,
                   plan=plan('ecj_assign', steps=(spec('filter', 1),), terminal=spec('count'), step_kinds=('sync',), program='Ecj'))
        check('ECJ: an assignment head whose code runs after the chain is notAtChainStart', error(r) == 'notAtChainStart', r)
    finally:
        dbg.end()


@case
def real_run_function_and_data_breakpoints():
    # java-debug makes a function breakpoint a MethodEntryRequest and a data breakpoint a watchpoint
    # request; left on, either is hit inside the terminal's invoke (and slows it to the interpreter).
    kinds = (('function', 'setFunctionBreakpoints', {'breakpoints': [{'name': 'Real#touch'}]}),
             ('data', 'setDataBreakpoints', {'breakpoints': [{'dataId': 'Real#touched', 'accessType': 'write'}]}))
    for kind, command, arguments in kinds:
        dbg = real('fn')
        try:
            reply = dbg.dap.request(command, arguments)
            check(f'{kind} breakpoint: java-debug verifies it', all(b.get('verified') for b in reply['body']['breakpoints']), reply)
            trace, state, _ = run_until_parked(dbg, 'fn', steps=(spec('filter', 1),), terminal=spec('count'), step_kinds=('sync',),
                                               timeout=20)
            check(f'{kind} breakpoint: silenced while the chain runs, so the trace parks', state['state'] == 'parked', state)
            if state['state'] != 'parked':
                continue
            c = step_out_and_collect(dbg, trace)
            collected_ok(f'{kind} breakpoint', c, terminal='4')
            resume(dbg)
            try:
                body = expect_stop(dbg, 20, f'{kind} breakpoint after the trace')
                check(f'{kind} breakpoint: back on after the trace', body.get('reason') == f'{kind} breakpoint'
                      and top(dbg)['line'] == line('touch', 'Real'), (body, top(dbg)))
            except TimeoutError:
                check(f'{kind} breakpoint: back on after the trace', False, 'no stop')
        finally:
            dbg.end()


PLAN_THROWS = dict(steps=(spec('filter', 1),), terminal=spec('count'), step_kinds=('sync',))


@case
def real_run_statement_throws_before_the_root():
    # JDWP reports no method exit for a frame an exception pops: the trace must notice the caller's
    # catch before the caller's next breakpoint, which is still off until then.
    dbg = real('throws', 'escapes', 'escapes_later', 'later_landing', 'later_catch', 'caught', 'throws_end')
    try:
        trace, state, _ = run_until_parked(dbg, 'escapes', timeout=20, **PLAN_THROWS)
        check('throws, uncaught in the frame: the trace fails', state['state'] == 'failed'
              and state.get('detail', '').startswith('the chain did not run'), state)
        try:
            expect_stop(dbg, 20, 'escapes_later')
            check('throws, uncaught in the frame: the next breakpoint stops', top(dbg)['line'] == line('escapes_later', 'Real'),
                  top(dbg))
        except TimeoutError:
            check('throws, uncaught in the frame: the next breakpoint stops', False, 'no stop')
            return
        # The root and filter are wrapped (invokes into the thread) before limit's argument throws.
        trace, state, _ = run_until_parked(dbg, 'escapes_later', timeout=20, steps=(spec('filter', 1), spec('limit', 1)),
                                           terminal=spec('count'), step_kinds=('sync', 'sync'))
        check('throws in a step argument: the trace fails', state['state'] == 'failed'
              and state.get('detail', '').startswith('the chain did not run'), state)
        try:
            expect_stop(dbg, 20, 'later_catch')
            if top(dbg)['line'] == line('later_landing', 'Real'):
                report('NOTE', "throws in a step argument: the breakpoint where the step out lands stopped too")
                resume(dbg)
                expect_stop(dbg, 20, 'later_catch')
            else:
                # The step out lands on the handler's first line, with its breakpoint still off: JVMTI
                # checks for a breakpoint before posting the step, so switching it on then is too late.
                report('NOTE', "throws in a step argument: the breakpoint where the step out lands is missed")
            check("throws in a step argument: the caller's catch stops", top(dbg)['line'] == line('later_catch', 'Real'), top(dbg))
        except TimeoutError:
            check("throws in a step argument: the caller's catch stops", False, 'no stop')
            return
        resume(dbg)
        try:
            expect_stop(dbg, 20, 'caught')
            check('throws: the breakpoint after stops', top(dbg)['line'] == line('caught', 'Real'), top(dbg))
        except TimeoutError:
            check('throws: the breakpoint after stops', False, 'no stop')
            return
        trace, state, _ = run_until_parked(dbg, 'caught', timeout=20, **PLAN_THROWS)
        check('throws, caught in the frame: the trace fails', state['state'] == 'failed'
              and state.get('detail', '').startswith('the chain did not run'), state)
        try:
            expect_stop(dbg, 20, 'throws_end')
            check('throws, caught in the frame: a later breakpoint stops', top(dbg)['line'] == line('throws_end', 'Real'), top(dbg))
        except TimeoutError:
            check('throws, caught in the frame: a later breakpoint stops', False, 'no stop')
            return
        resume(dbg)
        check('throws: the program runs on untouched', output_line(dbg, 'THROWS ') == 'THROWS -1 8')
    finally:
        dbg.end()


@case
def real_run_breakpoint_hit_while_running():
    # A breakpoint set while the terminal runs and hit before the bundle's next re-silence: ide-dap
    # continues the thread (R32), which lets the invoke go on. No `wait` before the hit, so nothing
    # re-silences it first.
    dbg = real('hit', 'hit', extra=(SR_SIZE,))
    try:
        trace = ok(arm(dbg, at='hit', root=spec('iterate', 2), steps=(spec('limit', 1), spec('filter', 1)),
                       terminal=spec('count'), class_filters=('java.util.stream.*',)))['traceId']
        traced = dbg.thread
        resume(dbg)
        time.sleep(0.3)
        breakpoints(dbg, 'hit', 'sr_late')
        try:
            body = expect_stop(dbg, 20, 'sr_late inside the invoke')
            check('hit-while-running: the new breakpoint stops the traced thread inside the invoke',
                  body.get('threadId') == traced and top(dbg)['line'] == line('sr_late', 'Real'), (body, top(dbg)))
        except TimeoutError:
            check('hit-while-running: the new breakpoint stops the traced thread inside the invoke', False, 'no stop')
            return
        dbg.dap.request('continue', {'threadId': traced})
        state = wait_until_done(dbg, trace, 30)
        check('hit-while-running: after a continue the trace still parks', state['state'] == 'parked', state)
        if state['state'] != 'parked':
            return
        c = step_out_and_collect(dbg, trace)
        collected_ok('hit-while-running', c, terminal=str(SR_SIZE // 2))
        resume(dbg)
        try:
            expect_stop(dbg, 20, 'sr_late after the trace')
            check('hit-while-running: the breakpoint is back on after the trace', top(dbg)['line'] == line('sr_late', 'Real'), top(dbg))
        except TimeoutError:
            check('hit-while-running: the breakpoint is back on after the trace', False, 'no stop')
            return
        resume(dbg)
        check('hit-while-running: program output', output_line(dbg, 'HIT ') == f'HIT {SR_SIZE // 2}')
    finally:
        dbg.end()


@case
def real_run_wait_after_the_vm_is_gone():
    # Once java-debug no longer lists the VM, `wait` still answers the trace's end from what was read
    # before, without touching the dead VM.
    dbg = real('fn')
    trace, state, _ = run_until_parked(dbg, 'fn', steps=(spec('filter', 1),), terminal=spec('count'), step_kinds=('sync',),
                                       timeout=20)
    check('gone: the trace parks first', state['state'] == 'parked', state)
    dbg.end()
    # collect has no answer for a gone VM, so it tells when java-debug dropped it.
    for _ in range(100):
        if error(stream('collect', dbg, traceId=trace)) == 'vmNotFound':
            break
        time.sleep(0.1)
    else:
        check('gone: java-debug drops the VM', False)
        return
    for attempt in ('first', 'second'):
        reply = stream('wait', dbg, traceId=trace, ms=0)
        check(f'gone: the {attempt} wait answers the counts read before', 'ok' in reply and reply['ok']['state'] == 'parked'
              and reply['ok']['records'] == state['records'], reply)
    check('gone: release answers too', 'ok' in stream('release', dbg, traceId=trace))


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
