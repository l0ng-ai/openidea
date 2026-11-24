# JVM inspection inside java-debug

An OSGi bundle loaded into JDT LS next to microsoft java-debug. While a Java debug session is
suspended, it lists the instances of a class, the fields of an object and the objects that refer to
it, and counts the instances of every loaded class; it also traces a stream chain while the program
runs it, and stops on the exceptions of a chosen class. It works on java-debug's own JDI connection to the debuggee, so no second debugger connects
to the JVM.

## Commands

Every command but `openidea.jvm.vms` takes `target` first:
`{"pid": n|null, "host": s|null, "port": n|null, "generation": n}`. A launch session is found by
`pid` (the process java-debug started); an attach session by the remote port of java-debug's socket,
then by `host` when several VMs share that port. Two JVMs running the same program have the same
thread ids and names, so threads are never used to tell sessions apart.

| Command                  | Arguments after `target` | `ok`                                                                               |
| ------------------------ | ------------------------ | ---------------------------------------------------------------------------------- |
| `openidea.jvm.vms`       | none (no `target`)       | `[{pid, remoteHost, remotePort, localPort, version, canGetInstanceInfo, timeout}]` |
| `openidea.jvm.classes`   | none                     | `[{name, instances}]`, classes with no instances left out                          |
| `openidea.jvm.instances` | `className`, `limit`     | `[JvmValue]`, at most 1000                                                         |
| `openidea.jvm.fields`    | `objectId`               | `[{name, value}]`; the first 100 elements, as `"[i]"`, of an array                 |
| `openidea.jvm.referrers` | `objectId`, `limit`      | `[{value, via}]`, at most 200; `via` lists the fields or `"[i]"` slots             |

A reply is `{"ok": payload}` or `{"error": code, "detail": text}`, `code` being one of
`unsupported`, `vmNotFound`, `stale`, `collected`, `classNotLoaded`, `notSuspended`, `timedOut`.
Anything else (a malformed argument, a JDI error the bundle does not expect) is an ordinary
`executeCommand` error. Values have the JSON shape of `ide_jvm_inspect::JvmValue`. JDT LS writes
replies with Gson, which leaves out `null` members: an attached VM has no `pid`, and a long string
no `text`.

- Data is read only while some thread of the VM is suspended (`notSuspended` otherwise), one command
  per VM at a time.
- An `objectId` is valid only in the `generation` (the session's stop) it was returned in; any other
  is `stale`. Each VM keeps a table of the objects the bundle handed out, emptied when the generation
  changes or when it grows past 100 000 entries.
- Previews follow the JDWP link's rules: arrays give only their length, boxed types the primitive in
  their `value` field, a `String` the length of its backing array (by `coder`) and its text only up
  to 1000 characters. Nothing is invoked: no `toString`, no `invokeMethod`.
- A referrer array longer than 10 000 elements is not searched for the slot (`via` is empty).
- An object collected before its preview is left out of `instances` and `referrers`.

## Stream trace

The `openidea.jvm.stream.*` commands trace a stream chain while the program itself runs it, so no
lambda runs twice. They take `target` first, like the commands above, then one object:

| Command          | Object after `target`      | `ok`                                                                                |
| ---------------- | -------------------------- | ----------------------------------------------------------------------------------- |
| `stream.arm`     | `{threadId, plan, budget}` | `{traceId}`                                                                         |
| `stream.wait`    | `{traceId, ms}`            | `{state, records, dropped, elapsedMs, detail?}`                                     |
| `stream.stop`    | `{traceId}`                | `{records}`                                                                         |
| `stream.abort`   | `{traceId}`                | `{state, holders?}`, `holders` being `[{threadId, name}]`                           |
| `stream.collect` | `{traceId}`                | `{records: [{step, value}], dropped, terminal, skippedBreakpoints, sequentialized}` |
| `stream.release` | `{traceId}`                | `{}`                                                                                |

`plan` is the JSON of `ide_streams::RealRunPlan`; `budget`, a whole number from 1 to 2³¹ − 1
(default 50 000), caps the records kept, past which they are only counted in `dropped`. `wait`'s
`state` is `running`, `parked`, `failed` or `cancelled` (both with `detail`). `abort`'s is `interrupted`, `stopped` or
`stuck` while the terminal runs, `cancelled` before it started and `finished` once the trace parked
or failed. `collect` takes the new stop's `target.generation`; a record's `step` counts the wrapped
ops from 0 (the source), modifiers left out, and `value`, like the `terminal`'s, is a `JvmValue`
preview (a primitive result previews as `primitive`). `terminal` is `{kind: "value", value}`,
`{kind: "void"}` or `{kind: "threw", exception}`.
Besides the codes above, a reply's `error` can be `noSession` (java-debug registered no session for
the VM), `notAtChainStart`, `busy` (the VM has a trace still running; `collect` before the trace
parked), `noTrace` (the `traceId` is not the VM's current trace), `badArgument` (a `budget` out of
range) or `failed` (`collect` on a failed trace, with its `detail`, or a JDI failure the commands do
not expect, or a VM unlike the plan). `collect` in the stop `arm` ran in is `stale`. Any other malformed argument is an
ordinary `executeCommand` error.

- `arm` needs the thread suspended by an event (a breakpoint or a step) and a VM that can force early
  returns and report return values (HotSpot 11 to 25 can). It defines the recorder
  (`recorder/OiRecorder.java`, embedded as `ai/openidea/jvminspect/OiRecorder.bin`) in a
  `SecureClassLoader` of its own whose parent is the boot loader, once per VM, and creates the log and
  the exception that cancels the terminal (`java.lang.RuntimeException: oi-cancel:<nonce>`).
- From `arm` until the trace is released, every enabled breakpoint, exception, method entry, method
  exit and watchpoint request that is not the bundle's own is switched off, then back on: java-debug
  makes a function breakpoint a method entry request and a data breakpoint a watchpoint request. A
  breakpoint hit while the bundle invokes into the thread hangs the session. A request java-debug deleted meanwhile (the user edited or removed the
  breakpoint) stays off: Eclipse JDI would enable a deleted request again, so only requests the VM
  still lists are switched back on.
- One trace per VM. A finished trace (parked or failed) is released by the next `arm` on that VM or
  when the VM disconnects; the client need not call `release`. Releasing a parked trace the client
  never stepped out of resumes the thread; releasing one whose terminal still runs takes effect when
  the terminal returns, and until then the VM's next `arm` is `busy`. The program then runs on with
  the terminal's outcome and the trace is `failed` (`released`), so a later `abort` is `finished` and
  the next `arm` replaces it. After the VM disconnected, `wait` still answers the trace's last state
  and the counts last read, for the 16 latest such traces.
- `arm` refuses a chain that has started (`notAtChainStart`): the stop must be on or after the
  statement's first line with no code of those lines before it. javac puts a statement's first
  instruction on its first line; ECJ, which JDT LS builds with, gives a head like
  `List<String> out =` no code, and a head like `n =` only the store after the chain. A stop inside a
  lambda (a synthetic method, or one named `lambda$…`) is refused when a deeper frame of the same class
  has code on the chain's lines up to the stop: that frame runs the chain, and the stop is in one of the
  chain's lambdas, from which the root is never called. A chain written inside a lambda body has its
  lines in the lambda alone and stays traceable. A `local` root
  must be declared as a `Stream`, `IntStream`, `LongStream` or `DoubleStream` (`unsupported`
  otherwise); `arm` replaces it by `local.peek(recorder)`.
- After the client continues the thread, each build-phase `MethodExit` of the chain's next op is held
  and its stream returned as `stream.peek(recorder)` through `forceEarlyReturn`. The root is matched
  by name, JVM arity, stream return type and caller (the stopped method, one frame deeper), after the
  plan's `skip` such exits; every later op by receiver: a call from that method on the last wrapped
  stream is the chain's next op, and one that differs from the plan fails the trace
  (`missed <op>`) and lets the program run on. Modifiers are matched but not wrapped. With
  `sequentialize`, the source becomes `peek(…).sequential()` and each `parallel()` returns
  `sequential()`.
- The build phase ends in `failed` (`the chain did not run: …`), the program running on, when the
  statement throws before the terminal is called (the root's or a step's arguments). The bundle also
  watches the stopped method's class for method exits, and steps out of its frame: JDWP reports no
  method exit for a frame an exception pops, but the step out lands in the caller's handler. Any of
  the trace's events with that frame gone, or on a line outside the plan's `firstLine`..`lastLine`
  (the statement caught the exception), fails the trace. A breakpoint on the line the step out lands
  on is missed (it is switched back on only once the thread is there), and so are breakpoints the
  frame's own catch block passes before the trace's next event.
- At the terminal's `MethodEntry`, with no method request left on (any slows the thread to the
  interpreter), the bundle runs the terminal once by `invokeMethod`, with the JDI timeout raised, and
  forces its result as the entered frame's return, or throws its exception there. The thread stays
  suspended (`parked`) until the client's DAP `stepOut`. Breakpoints java-debug created since `arm`
  are silenced too, right before the invoke, and again at each 500 ms check of a `wait` while it
  runs; all are switched back on when it returns. A breakpoint added between two checks can still be
  hit inside the invoke: java-debug reports the stop, and a DAP `continue` of the thread lets the
  invoke go on (ide-dap does that unseen while the trace runs).
  The outcome is forced into the frame before it is pinned, so the pending return keeps it reachable;
  should it be collected before that, the program gets the cancel exception and the trace fails.
- An exception the terminal threw (the cancel exception of `abort` included) ends the client's
  `stepOut` in the program's catch. Nothing catching it, the thread would die with no stop left to
  `collect` in, so before parking the bundle adds an uncaught-exception request on the thread,
  suspending it: the step-out ends at that throw instead, as a java-debug `exception` stop, and a
  resume lets the exception end the thread as it would have. Skipped when an enabled request of
  java-debug's already reports uncaught throws of that type (one stop, not two). `collect` deletes it;
  after `collect` a release no longer resumes the parked event, since that stop keeps the parked frames.
- `wait` returns as soon as the trace leaves `running`, or after `ms`, at most 30 000. While the
  terminal runs it also checks every 500 ms whether the VM began to shut down
  (`jdk.internal.misc.VM.initLevel`): `System.exit` in a lambda makes the VM wait forever to report
  its death while the bundle's invoke runs, so no disconnect comes. The trace then fails, with the
  breakpoints back on; the debug session has to be stopped.
- `stop` lowers the log's budget to the records so far by a field write: the program keeps running
  untouched. `abort` interrupts the thread, waits 2 s for the terminal to return, then throws the
  cancel exception into it, waits 2 s more, and else lists the suspended threads that own a monitor.
  JDWP holds an interrupt or stop of a thread handling an event until that event's handler exits, and
  the invoke runs inside the handler of the terminal's entry; any event of the thread inside the
  invoke lifts the hold. So the bundle adds a method entry request on the thread, counted once and
  suspending nothing, right before the invoke: it fires on the terminal's own entry. Without it only a
  class first prepared inside the invoke lifted the hold, and a VM that had run those stream classes
  before (an earlier stream or trace) answered `stuck`. Before the terminal started, either takes the trace
  down (`cancelled`, `cancelled before the terminal ran`) and the program runs on untouched.
- `collect` reads the log 16 384 elements per JDWP request and previews every value into the handle
  table of the inspect commands, so the UI can expand them; the log keeps them alive until the trace
  is released. `skippedBreakpoints` counts the line, function and data breakpoint requests silenced (exception breakpoints
  left out: JDI cannot tell whether a silenced request would have been hit).
- Timing, the 1M-element chain of `tests/stream.py` (`real_run_d_million`, Apple M4 Pro, JDT LS
  1.63): 78–138 ms from DAP `continue` to `parked` on JDK 11, 17, 21, 23 and 25; DAP `stepOut` plus
  `collect` of its 50 000 records 4.4–4.7 s.

`classes` and `referrers` can take seconds on a large heap. Eclipse JDI fails a request after
`getRequestTimeout()` (3000 ms by default), and the timeout is per VM: java-debug's own requests
waiting behind the command time out too. These two commands raise it to at least 60 000 ms and,
when done, put back the old value unless something else changed it meanwhile (java-debug applies its
timeout setting to every VM when it changes).

## Exception breakpoints

`openidea.jvm.exceptions.set` takes `target` first, then `{breakpoints: [{id, className, caught,
uncaught, enabled, classFilters, classExclusionFilters}]}`, and replaces the VM's whole list. `ok`
is `[{id, state}]` in the same order, `state` being `armed`, `pending` (the class is not loaded yet),
`disabled` (off, or neither `caught` nor `uncaught`) or `deferred`. A missing `id` or `className` is
an `executeCommand` error; a VM whose session java-debug did not register gives `noSession`.

- Each breakpoint is a JDI exception request on every loaded class of that name, subclasses
  included, plus a class-prepare request that arms classes loaded later or by another class loader.
  java-debug turns every exception event into a stop, whoever made the request, so the stop, the
  stack and `exceptionInfo` are java-debug's own.
- `classFilters` / `classExclusionFilters` are JDI class patterns (`com.acme.*`, `*Test`) matched
  against the class whose code throws.
- java-debug deletes every exception request when it handles `setExceptionBreakpoints`. Send the
  list again after each one, and before `configurationDone` to stop on a throw in `main`'s first line.
- One throw matched by two requests gives two stops. A request leaves out the caught or uncaught
  throws that java-debug's enabled all-exception filters report, or an enabled breakpoint without
  class filters on a superclass, or on the same class when that one comes earlier in the list or this
  one has filters. Two breakpoints that both have class filters can still both stop on one throw.
- No conditions and no catch-location filters: java-debug stops on every exception event it gets,
  and an event-hub subscriber cannot keep it from stopping.
- While a stream trace silences the VM's breakpoints, a new list is `deferred` and applied when the
  trace ends, as is a class prepared meanwhile. Its requests are silenced and restored with the
  rest; a trace that ends at an uncaught throw watches the throw itself only when no java-debug
  request, nor a breakpoint without class filters, already stops there.

## Internals it depends on

java-debug is not pinned: the app installs the latest vscode-java-debug. The bundle reaches the VMs
through these non-API members, by reflection:

- `com.microsoft.java.debug.plugin.internal.JdtVirtualMachineManagerProvider#getVirtualMachineManager()`
- `AdvancedVirtualMachineManager.connectedVMs` (a synchronized list)
- `org.eclipse.jdi.internal.VirtualMachineImpl#packetReceiveManager()`
- `org.eclipse.jdi.internal.connect.PacketManager.fConnection`
- `org.eclipse.jdi.internal.connect.SocketConnection.fSocket`

The stream commands reach java-debug's debug session of a VM, and its events, through:

- `org.eclipse.core.internal.resources.Workspace.notificationManager` →
  `NotificationManager.listeners` → `ResourceChangeListenerList.listeners` (a `CopyOnWriteArrayList`)
  → `ListenerEntry.listener`
- `com.microsoft.java.debug.plugin.internal.JavaHotCodeReplaceProvider.currentDebugSession`, a
  listener registered by each session whose `hotCodeReplace` setting is not `never` (the app sets
  `auto`)
- `IDebugSession#getVM()`, `#getEventHub()`, `IEventHub#events()` and RxJava 2's
  `Observable#subscribe(Consumer, Consumer)` / `Disposable#dispose()`, loaded from the java-debug bundle
- `DebugEvent.event`, `.eventSet` and `.shouldResume`: set to `false` in the listener, it keeps the
  event's thread suspended, as java-debug does for conditional breakpoints

and, in the debuggee, `jdk.internal.misc.VM.initLevel` and `.SYSTEM_SHUTDOWN` (JDK 9 to 25), read as
static fields to see the VM shutting down while the terminal runs; without them that check is off

and, as API of `org.eclipse.jdt.debug`, `org.eclipse.jdi.VirtualMachine#getRequestTimeout` /
`#setRequestTimeout` and `org.eclipse.jdi.TimeoutException`. When any of these is missing or
changes shape, every command answers `unsupported`; nothing throws into java-debug.

Checked with JDT LS 1.63.0.202610191322 (`org.eclipse.jdt.debug` 3.27.0) and java-debug plugin
0.53.2 (vscode-java-debug 0.60.0).

## Rebuild

Build dependency: [JDT LS 1.63.0 build 202610191322](https://download.eclipse.org/jdtls/milestones/1.63.0/jdt-language-server-1.63.0-202610191322.tar.gz),
the same as `java/java-usages`. Check the extracted distribution from its root
(`sha256sum -c /path/to/build-dependencies.sha256`), then with Java 25 on `PATH`:

```sh
python3 build.py /path/to/jdtls             # writes openidea-jvm-inspect.jar
python3 build.py /path/to/jdtls --out x.jar # writes x.jar instead
python3 build.py /path/to/jdtls --test      # compiles tests/SelfTest.java with the sources and runs it
```

The build uses the distribution's ECJ and plugin jars plus the `jdimodel.jar` nested in
`plugins/org.eclipse.jdt.debug_*.jar`, sorted inputs and fixed zip timestamps; bytecode targets
Java 21. The recorder is compiled by the `javac` on `PATH` with `--release 8`, since the debuggee may
run Java 8. Build twice and compare: two builds of the checked-in jar gave

```
5278f1d38325551c5d4ab50b5140551f91c3bf5b9db536aeb276713578e0fd49  openidea-jvm-inspect.jar
```

Change `Bundle-Version` whenever the jar changes: OSGi caches bundles by version.

## Real JDT LS check

`tests/inspect.py` starts JDT LS with java-debug and this jar, debugs a small `Heap` program (a launch
and two attaches to the same program) and prints `OK`/`FAIL`/`SKIP` per check:

```sh
PATH=/path/to/jdk25/bin:$PATH \
OPENIDEA_TEST_JAVA=/path/to/jdk11/bin/java:/path/to/jdk21/bin/java \
python3 -I tests/inspect.py /path/to/jdtls /path/to/com.microsoft.java.debug.plugin-0.53.2.jar --heap 10000000
```

`OPENIDEA_TEST_JAVA` lists debuggee JDKs (`:`-separated; `;` on Windows). The attaches use the
first; `classes` is checked on the JDK 11 one. With `--heap N`, a JDK 21 JVM holds N objects and a
DAP `evaluate` sent 0.5 s after `classes` starts must succeed, with the timeout back to 3000 after.
It stops every process it started.

`tests/stream.py` does the same for the stream commands, once per JDK in `OPENIDEA_TEST_JAVA`, with
a launch and an attach; both scripts share `tests/jdtls_harness.py`. The `real_run_*` cases trace
chains end to end (arm, DAP `continue`, `wait`, DAP `stepOut`, `collect`); one debuggee is compiled
with the distribution's ECJ, as JDT LS builds a project. `--bundle` takes a jar built with `--out` (default: the checked-in one) and
`--case NAME` runs only the cases whose name contains `NAME`:

```sh
PATH=/path/to/jdk25/bin:$PATH \
OPENIDEA_TEST_JAVA=/path/to/jdk11/bin/java:/path/to/jdk21/bin/java \
python3 -I tests/stream.py /path/to/jdtls /path/to/com.microsoft.java.debug.plugin-0.53.2.jar --bundle x.jar
```

`tests/exceptions.py` checks `openidea.jvm.exceptions.set` on the `java` on `PATH`: a throw in
`main`'s first line in a launch and in an attach, a class loaded late, class filters, the re-arm
after `setExceptionBreakpoints`, no double stop with java-debug's filters or a superclass breakpoint,
and a hot swap of the throwing class. It takes `--bundle` too:

```sh
PATH=/path/to/jdk25/bin:$PATH \
python3 -I tests/exceptions.py /path/to/jdtls /path/to/com.microsoft.java.debug.plugin-0.53.2.jar
```
