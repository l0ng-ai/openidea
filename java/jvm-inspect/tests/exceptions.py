"""Drive the exception breakpoint command inside a real JDT LS with java-debug.

Usage: python3 -I exceptions.py /path/to/jdtls /path/to/com.microsoft.java.debug.plugin-<v>.jar \
       [--bundle /path/to/openidea-jvm-inspect.jar]

JDT LS and the debuggees run on the `java` on PATH (JDK 25 for 1.63.0). The breakpoints are set the
way ide-dap sets them: after `initialized`, `setExceptionBreakpoints`, then this command, then
`configurationDone`, and the command again after every later `setExceptionBreakpoints`. Prints
OK/FAIL per check.
"""
import json
import pathlib
import subprocess
import sys
import tempfile
import threading
import time

sys.path.append(str(pathlib.Path(__file__).resolve().parent))
sys.dont_write_bytecode = True  # no __pycache__ in the source tree
from jdtls_harness import check, debug_session, finish, free_port, kill, report, start_jdtls, stop_jdtls, wait_ready  # noqa: E402

COMMAND = 'openidea.jvm.exceptions.set'
# `// @name` names a line for `line('name')`.
PROGRAM = '''public class Exc {
    static class Lazy { static void boom() { throw new Boom("lazy"); } } // @boom
    static class Boom extends RuntimeException { Boom(String m) { super("boom: " + m); } } // @message
    public static void main(String[] a) throws Exception {
        try { throw new IllegalStateException("first line"); } catch (IllegalStateException e) { } // @first
        try { Integer.parseInt("x"); } catch (NumberFormatException e) { }
        try { Lazy.boom(); } catch (Boom e) { }
        try { Lazy.boom(); } catch (Boom e) { }
        try { Filtered.run(); } catch (UnsupportedOperationException e) { }
        try { throw new IllegalStateException("second"); } catch (IllegalStateException e) { } // @second
        try { Filtered.run(); } catch (UnsupportedOperationException e) { }
        try { throw new IllegalStateException("third"); } catch (IllegalStateException e) { } // @third
        throw new IllegalArgumentException("uncaught"); // @uncaught
    }
}
class Filtered { static void run() { throw new UnsupportedOperationException("filtered"); } } // @filtered
'''

args = sys.argv[1:]
bundle = pathlib.Path(__file__).resolve().parents[1] / 'openidea-jvm-inspect.jar'
if '--bundle' in args:
    i = args.index('--bundle')
    bundle = pathlib.Path(args[i + 1]).resolve()
    del args[i:i + 2]
home, java_debug = (pathlib.Path(a).resolve() for a in args[:2])
# resolved: on macOS the temp dir is under the /var symlink, and JDT LS matches canonical URIs
work = pathlib.Path(tempfile.mkdtemp(prefix='openidea-jvm-exceptions-')).resolve()
project = work / 'project'
(project / 'src').mkdir(parents=True)
source = project / 'src' / 'Exc.java'
source.write_text(PROGRAM)
classes = work / 'classes'
subprocess.run(['javac', '-g', '-d', str(classes), str(source)], check=True)
jdtls = lsp = None
jvms, launched = [], []


def line(name):
    return next(i for i, t in enumerate(PROGRAM.splitlines(), 1) if t.rstrip().endswith('// @' + name))


def bp(id, class_name, caught=True, uncaught=True, enabled=True, include=(), exclude=()):
    return {'id': id, 'className': class_name, 'caught': caught, 'uncaught': uncaught, 'enabled': enabled,
            'classFilters': list(include), 'classExclusionFilters': list(exclude)}


def arm(target, *breakpoints):
    reply = lsp.command(COMMAND, target, {'breakpoints': list(breakpoints)})
    if 'ok' not in reply:
        raise AssertionError(f'{COMMAND}: {reply}')
    return {s['id']: s['state'] for s in reply['ok']}


def stop(d, what, timeout=30):
    e = d.wait_event(lambda e: e['event'] in ('stopped', 'terminated'), timeout, what)
    if e['event'] == 'terminated':
        raise AssertionError(f'{what}: the debuggee terminated')
    thread = e['body']['threadId']
    frames = d.request('stackTrace', {'threadId': thread})['body']['stackFrames']
    top = frames[0] if frames else {}
    info = d.request('exceptionInfo', {'threadId': thread}).get('body', {})
    return e['body'], thread, top, info


def no_more_stops(d, seconds=2.0):
    try:
        d.wait_event(lambda e: e['event'] == 'stopped', seconds, 'stopped')
        return False
    except TimeoutError:
        return True


def expect(d, name, reason_line, exception, what):
    """The next stop is a java-debug exception stop at `reason_line` for `exception`, and the only one."""
    body, thread, top, info = stop(d, what)
    check(f'{name}: {exception} stops at line {reason_line}',
          body['reason'] == 'exception' and top['line'] == reason_line and info['exceptionId'] == exception,
          (body, top.get('name'), top.get('line'), info))
    check(f'{name}: one stopped event', no_more_stops(d))
    return thread, info


def configure(d, target, *breakpoints, filters=()):
    d.wait_event(lambda e: e['event'] == 'initialized', 60, 'initialized')
    d.request('setExceptionBreakpoints', {'filters': list(filters)})
    states = arm(target, *breakpoints)
    d.request('configurationDone')
    return states


def launch_case(project_name, classpaths):
    d = debug_session(lsp, 'openidea-jvm-exceptions')
    d.start('launch', {'mainClass': 'Exc', 'projectName': project_name, 'modulePaths': [], 'classPaths': classpaths,
                       'cwd': str(project), 'console': 'internalConsole', 'shortenCommandLine': 'none'})
    pid = d.wait_event(lambda e: e['event'] == 'processid', 60, 'processid')['body']['processId']
    launched.append(pid)
    target = {'pid': pid, 'host': None, 'port': None, 'generation': 0}
    exc_filter = 'Exc'
    states = configure(d, target,
                       bp('ise', 'java.lang.IllegalStateException', uncaught=False, include=[exc_filter]),
                       bp('nfe', 'java.lang.NumberFormatException', enabled=False),
                       bp('boom', 'Exc$Boom'),
                       bp('uoe', 'java.lang.UnsupportedOperationException', exclude=['Filtered']),
                       bp('iae', 'java.lang.IllegalArgumentException', caught=False))
    print('         states before configurationDone:', json.dumps(states), flush=True)
    # The JDK may have loaded a java.lang class before main; Exc$Boom is loaded by `Lazy.boom()` only.
    check('launch: states before the program runs', states['nfe'] == 'disabled' and states['boom'] == 'pending'
          and all(states[k] in ('pending', 'armed') for k in ('ise', 'uoe', 'iae')), states)
    thread, _ = expect(d, 'launch start-up', line('first'), 'java.lang.IllegalStateException', 'first line')

    # java-debug re-applying its filters deletes every exception request; the client arms again.
    d.request('setExceptionBreakpoints', {'filters': []})
    states = arm(target, bp('ise', 'java.lang.IllegalStateException', uncaught=False, include=[exc_filter]),
                 bp('nfe', 'java.lang.NumberFormatException', enabled=False), bp('boom', 'Exc$Boom'),
                 bp('uoe', 'java.lang.UnsupportedOperationException', exclude=['Filtered']),
                 bp('iae', 'java.lang.IllegalArgumentException', caught=False))
    check('launch: re-armed after setExceptionBreakpoints', states['ise'] == 'armed' and states['boom'] == 'pending', states)
    d.request('continue', {'threadId': thread})
    thread, _ = expect(d, 'launch lazily loaded', line('boom'), 'Exc$Boom', 'boom')
    d.request('continue', {'threadId': thread})
    thread, _ = expect(d, 'launch loaded class, second throw', line('boom'), 'Exc$Boom', 'boom again')
    d.request('continue', {'threadId': thread})
    thread, _ = expect(d, 'launch class filter', line('second'), 'java.lang.IllegalStateException', 'second (UOE excluded in Filtered)')

    # A breakpoint on the superclass and the ISE one both report the caught `third`: one stop.
    rte = bp('rte', 'java.lang.RuntimeException', uncaught=False)
    states = arm(target, bp('ise', 'java.lang.IllegalStateException', uncaught=False, include=[exc_filter]), rte)
    check('launch: superclass breakpoint armed', states == {'ise': 'armed', 'rte': 'armed'}, states)
    d.request('continue', {'threadId': thread})
    thread, _ = expect(d, 'launch superclass', line('filtered'), 'java.lang.UnsupportedOperationException', 'UOE by RuntimeException')
    d.request('continue', {'threadId': thread})
    thread, _ = expect(d, 'launch overlapping own breakpoints', line('third'), 'java.lang.IllegalStateException', 'third')

    # java-debug's own "Uncaught Exceptions" and the IAE breakpoint both report the last throw: one stop.
    d.request('setExceptionBreakpoints', {'filters': ['uncaught']})
    states = arm(target, bp('iae', 'java.lang.IllegalArgumentException', caught=False))
    check('launch: covered by java-debug filter is still armed', states == {'iae': 'armed'}, states)
    d.request('continue', {'threadId': thread})
    thread, _ = expect(d, 'launch overlapping java-debug filter', line('uncaught'), 'java.lang.IllegalArgumentException', 'uncaught')
    d.request('continue', {'threadId': thread})
    d.wait_event(lambda e: e['event'] in ('terminated', 'exited'), 30, 'end')
    d.request('disconnect', {'terminateDebuggee': True}, 20)


def hot_swap_case(project_name, classpaths):
    """Hot swap of the exception class itself while its request is on it. Last: it edits the source."""
    d = debug_session(lsp, 'openidea-jvm-exceptions')
    d.start('launch', {'mainClass': 'Exc', 'projectName': project_name, 'modulePaths': [], 'classPaths': classpaths,
                       'cwd': str(project), 'console': 'internalConsole', 'shortenCommandLine': 'none'})
    pid = d.wait_event(lambda e: e['event'] == 'processid', 60, 'processid')['body']['processId']
    launched.append(pid)
    target = {'pid': pid, 'host': None, 'port': None, 'generation': 0}
    configure(d, target, bp('boom', 'Exc$Boom'))
    thread, _ = expect(d, 'hot swap: before', line('boom'), 'Exc$Boom', 'boom')
    text = PROGRAM.replace('"boom: "', '"BOOM: "')
    lsp.notify('textDocument/didChange', {'textDocument': {'uri': source.as_uri(), 'version': 2},
                                          'contentChanges': [{'text': text}]})
    source.write_text(text)
    lsp.notify('textDocument/didSave', {'textDocument': {'uri': source.as_uri()}, 'text': text})
    lsp.request('java/buildWorkspace', False, 120)
    # What the app's Reload Changed Classes sends (DebugManager::redefine_classes).
    r = d.request('redefineClasses', {}, 60)
    check('hot swap: java-debug redefines Exc$Boom', r['success'] and 'Exc$Boom' in r.get('body', {}).get('changedClasses', []), r)
    # java-debug pops the frames of redefined classes and re-enters them (a `step` stop), so the throw runs again.
    swapped = []
    for _ in range(4):
        d.request('continue', {'threadId': thread})
        try:
            body, thread, top, info = stop(d, 'after hot swap', 10)
        except (TimeoutError, AssertionError):
            break
        print('         after hot swap:', body['reason'], top.get('name'), top.get('line'), info.get('description'), flush=True)
        if body['reason'] == 'exception' and info.get('exceptionId') == 'Exc$Boom':
            swapped.append(info.get('description', ''))
            break
    check('hot swap: the Exc$Boom breakpoint still stops, in the new constructor',
          bool(swapped) and all('BOOM: lazy' in s for s in swapped), swapped)
    d.request('disconnect', {'terminateDebuggee': True}, 20)


def attach_case(project_name):
    port = free_port()
    p = subprocess.Popen(['java', f'-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:{port}',
                          '-cp', str(classes), 'Exc'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    jvms.append(p)
    p.stdout.readline()  # "Listening for transport dt_socket ..."
    threading.Thread(target=lambda: [None for _ in p.stdout], daemon=True).start()
    d = debug_session(lsp, 'openidea-jvm-exceptions')
    d.start('attach', {'hostName': '127.0.0.1', 'port': port, 'timeout': 30000, 'projectName': project_name})
    target = {'pid': None, 'host': 'localhost', 'port': port, 'generation': 0}
    states = configure(d, target, bp('ise', 'java.lang.IllegalStateException', uncaught=False))
    check('attach: pending before the program runs', states == {'ise': 'pending'}, states)
    expect(d, 'attach start-up', line('first'), 'java.lang.IllegalStateException', 'first line')
    d.request('disconnect', {'terminateDebuggee': True}, 20)


try:
    wanted = [COMMAND, 'vscode.java.startDebugSession']
    jdtls, lsp, registered = start_jdtls(home, work, project, [java_debug, bundle], wanted)
    if check('JDT LS registers the exception command and java-debug', all(c in registered for c in wanted), registered):
        wait_ready(lsp)
        lsp.notify('textDocument/didOpen', {'textDocument': {'uri': source.as_uri(), 'languageId': 'java', 'version': 1,
                                                             'text': PROGRAM}})
        lsp.command('vscode.java.updateDebugSettings', json.dumps({'hotCodeReplace': 'auto', 'logLevel': 'WARNING'}))
        for _ in range(30):
            main = lsp.command('vscode.java.resolveMainClass', project.as_uri())
            if main:
                break
            time.sleep(2)
        project_name = main[0].get('projectName')
        _, classpaths = lsp.command('vscode.java.resolveClasspath', 'Exc', project_name)
        for case in (lambda: launch_case(project_name, classpaths), lambda: attach_case(project_name),
                     lambda: hot_swap_case(project_name, classpaths)):
            try:
                case()
            except Exception as e:
                report('FAIL', 'case', repr(e))
except Exception as e:
    report('FAIL', 'harness', repr(e))
finally:
    kill(jvms, launched)
    if lsp:
        stop_jdtls(jdtls, lsp)
sys.exit(finish(work))
