package ai.openidea.jvminspect;

import ai.openidea.jvminspect.InspectCommand.Failure;
import ai.openidea.jvminspect.JavaDebugSessions.Hub;
import ai.openidea.jvminspect.JavaDebugSessions.HubEvent;
import ai.openidea.jvminspect.RealRunPlan.StepSpec;
import com.sun.jdi.AbsentInformationException;
import com.sun.jdi.ArrayReference;
import com.sun.jdi.ClassType;
import com.sun.jdi.Field;
import com.sun.jdi.IncompatibleThreadStateException;
import com.sun.jdi.IntegerValue;
import com.sun.jdi.InvocationException;
import com.sun.jdi.LocalVariable;
import com.sun.jdi.LongValue;
import com.sun.jdi.Location;
import com.sun.jdi.Method;
import com.sun.jdi.ObjectCollectedException;
import com.sun.jdi.ObjectReference;
import com.sun.jdi.ReferenceType;
import com.sun.jdi.StackFrame;
import com.sun.jdi.ThreadReference;
import com.sun.jdi.VMDisconnectedException;
import com.sun.jdi.Value;
import com.sun.jdi.VirtualMachine;
import com.sun.jdi.event.Event;
import com.sun.jdi.event.EventSet;
import com.sun.jdi.event.MethodEntryEvent;
import com.sun.jdi.event.MethodExitEvent;
import com.sun.jdi.event.VMDeathEvent;
import com.sun.jdi.event.VMDisconnectEvent;
import com.sun.jdi.request.EventRequest;
import com.sun.jdi.request.MethodEntryRequest;
import com.sun.jdi.request.MethodExitRequest;
import com.sun.jdi.request.StepRequest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.ToLongFunction;

/**
 * One stream trace of a real run, from {@code stream.arm} to {@code stream.release} (spec §5.1).
 *
 * <p>After {@code arm} the client continues the thread. Each build-phase {@code MethodExit} of the
 * chain's next op is held, and the op's stream comes back as {@code stream.peek(recorder_k)} through
 * {@code forceEarlyReturn}. At the terminal's {@code MethodEntry}, with no method request left on, the
 * bundle runs the terminal once by {@code invokeMethod}, forces its outcome as the entered frame's, and
 * keeps the thread held ({@link State#PARKED}) for the client's DAP {@code stepOut}.
 *
 * <p>java-debug's event thread only filters, parks and hands events to {@link #worker}; it takes no
 * lock but {@link #stateLock}, which is never held across a JDI call. Everything that touches the
 * traced thread runs on the worker, one task at a time; the fields marked "worker" are touched
 * nowhere else once {@code arm} returns. Commands wait on the worker, never the other way round.
 */
final class RealRunTrace {
    static final int DEFAULT_BUDGET = 50_000;
    /** The prefix of the message of the exception that cancels the terminal. */
    static final String CANCEL_PREFIX = "oi-cancel:";
    static final String CANCELLED = "cancelled before the terminal ran";
    static final String EXITED = "the program began to exit while the terminal ran, and the VM cannot finish exiting while"
            + " the debugger runs code in it: stop the debug session";
    private static final Set<String> STREAM_TYPES = Set.of("java.util.stream.Stream", "java.util.stream.IntStream",
            "java.util.stream.LongStream", "java.util.stream.DoubleStream");
    /** Ops that change how the stream runs, not its elements: matched like steps, never wrapped. */
    private static final Set<String> MODIFIERS = Set.of("parallel", "sequential", "unordered", "onClose");
    /** Elements per JDWP {@code ArrayReference.GetValues} (spec v2 §7). */
    private static final int CHUNK = 16_384;
    private static final long ABORT_STEP_MS = 2_000;
    private static final long LIVENESS_POLL_MS = 500;
    /** How long a command waits for the worker to take the trace down before answering anyway. */
    private static final long WORKER_WAIT_MS = 10_000;
    private static final int INVOKE = ObjectReference.INVOKE_SINGLE_THREADED;

    enum State {
        /** Set up; the client has not continued the thread yet. */
        ARMED("running"),
        BUILDING("running"),
        TERMINAL_RUNNING("running"),
        /** The terminal returned or threw; the thread is held until the client steps out. */
        PARKED("parked"),
        FAILED("failed"),
        /** Stopped or aborted before the terminal ran: taken down, the program untouched. */
        CANCELLED("cancelled");

        final String wire;

        State(String wire) {
            this.wire = wire;
        }
    }

    /** One entry of a method's line table. */
    record LineEntry(int line, long codeIndex) {}

    final long id;
    final VirtualMachine vm;
    final ThreadReference thread;
    final RealRunPlan plan;
    final int budget;
    /** The stop {@code arm} ran in; {@code collect} needs a later one. */
    private final long generation;
    private final long armedNanos = System.nanoTime();
    /** Failures nobody could be told about when they happened: listener errors, cleanup that did not work. */
    private final List<String> errors = new CopyOnWriteArrayList<>();
    private final ThreadPoolExecutor worker;

    private final Object stateLock = new Object();
    private State state = State.ARMED;
    private String detail;
    private boolean released;
    private String terminalKind;
    private Value terminalValue;

    // Set by arm before any event can arrive, then only read.
    private Method userMethod;
    private int depth;
    private ClassType recorder;
    private Method stepRecorder;
    private ObjectReference log;
    private ObjectReference cancel;
    private JavaDebugSessions.Subscription subscription;
    private final List<Silencer> silencers = new CopyOnWriteArrayList<>();
    private final List<ObjectReference> pinned = new CopyOnWriteArrayList<>();
    /** The log's counts last read, answered once the VM is gone. */
    private volatile int size;
    private volatile long dropped;
    /** The worker is inside the terminal's invoke, which may never return. Cleared under {@link #silenceLock}. */
    private volatile boolean invoking;
    /** Fires once inside the terminal's invoke; see {@link #wakeInsideInvoke}. Its event is not the trace's. */
    private volatile EventRequest wake;
    /**
     * Orders {@link #resilence} before the restore that follows the invoke: a silence that lands after
     * it would leave the user's breakpoints off for good. Held across JDI calls, unlike {@code stateLock}.
     */
    private final Object silenceLock = new Object();

    // Worker.
    private final List<EventRequest> requests = new ArrayList<>();
    /** Exits of the user's class: only there to notice the statement ending before the terminal. */
    private EventRequest userExits;
    /**
     * Steps out of the user's frame, which JDWP reports for a frame an exception pops, unlike its
     * method exit. Never switched off for the build's invokes: enabled again, it would step out of the
     * op's frame instead.
     */
    private StepRequest frameExit;
    private int rootSkip;
    /** Index of the next op in {@code plan.steps()}. */
    private int nextOp;
    /** Recorder number of the next wrapped op; modifiers take none. */
    private int nextStep;
    private ObjectReference lastWrapped;
    /** {@code forceEarlyReturn} at a method exit makes that frame exit once more, returning the forced value. */
    private Method echoMethod;
    private Value echoValue;
    private EventSet parked;
    private Method terminalMethod;

    private RealRunTrace(long id, VirtualMachine vm, ThreadReference thread, RealRunPlan plan, int budget, long generation) {
        this.id = id;
        this.vm = vm;
        this.thread = thread;
        this.plan = plan;
        this.budget = budget;
        this.generation = generation;
        worker = new ThreadPoolExecutor(1, 1, 30, TimeUnit.SECONDS, new LinkedBlockingQueue<>(), task -> {
            Thread t = new Thread(task, "openidea stream trace " + id);
            t.setDaemon(true);
            return t;
        });
        worker.allowCoreThreadTimeOut(true);
    }

    /**
     * Checks that the chain has not started, silences the user's breakpoints, defines the recorder if
     * the VM has none, creates the log and the cancel exception, listens to java-debug's events and
     * watches the chain's construction. {@code thread} must be suspended by an event: this invokes
     * into it. On failure everything done so far is undone.
     *
     * @param generation the client's stop this runs in
     */
    static RealRunTrace arm(long id, VirtualMachine vm, ThreadReference thread, RealRunPlan plan, int budget, long generation, Hub hub)
            throws Exception {
        RealRunTrace trace = new RealRunTrace(id, vm, thread, plan, budget, generation);
        try {
            trace.setUp(hub);
            return trace;
        } catch (Exception | Error e) {
            trace.release();
            throw e;
        }
    }

    private void setUp(Hub hub) throws Exception {
        StackFrame frame = thread.frame(0);
        Location at = frame.location();
        userMethod = at.method();
        depth = thread.frameCount();
        // A stop inside one of the chain's own lambdas passes the line check (the lambda's code starts
        // on a chain line), but the root call is made by the frame running the chain, never from here.
        // A chain written inside a lambda body has its lines in the lambda alone, and stays traceable.
        if (isLambda(userMethod) && chainRunsBelow(at.lineNumber())) {
            throw new Failure("notAtChainStart", "line " + at.lineNumber() + " is inside " + userMethod.name()
                    + ", a lambda of the chain on line " + (plan.firstLine() + 1) + ", which a caller runs");
        }
        if (!atChainStart(new LineEntry(at.lineNumber(), at.codeIndex()), plan.firstLine(), lineTable(userMethod))) {
            throw new Failure("notAtChainStart", "line " + at.lineNumber() + ", code index " + at.codeIndex()
                    + ", is not where the statement on line " + (plan.firstLine() + 1) + " starts");
        }
        LocalVariable local = plan.root() == null ? streamLocal(frame) : null;
        ObjectReference held = null;
        if (local != null) {
            if (!(frame.getValue(local) instanceof ObjectReference stream)) throw new Failure("unsupported", plan.local() + " is null");
            held = stream;
        }
        // Before the first invoke: a breakpoint hit inside it would hang the session.
        silencers.add(Silencer.silence(vm.eventRequestManager()));
        recorder = RecorderLoader.classFor(vm, thread);
        stepRecorder = RecorderLoader.method(recorder, "<init>", "(LOiRecorder;I)V");
        log = keep(RecorderLoader.pin(() -> recorder.newInstance(thread, RecorderLoader.method(recorder, "<init>", "(I)V"),
                List.of(vm.mirrorOf(budget)), INVOKE)));
        ClassType runtimeException = RecorderLoader.classType(vm, "java.lang.RuntimeException");
        byte[] nonce = new byte[8];
        new SecureRandom().nextBytes(nonce);
        String message = CANCEL_PREFIX + HexFormat.of().formatHex(nonce);
        cancel = keep(RecorderLoader.pin(() -> runtimeException.newInstance(thread,
                RecorderLoader.method(runtimeException, "<init>", "(Ljava/lang/String;)V"), List.of(vm.mirrorOf(message)), INVOKE)));
        subscription = hub.subscribe(this::onEvent, e -> errors.add("event listener: " + e));
        if (held != null) {
            // Not put back: the program consumes the stream right after.
            lastWrapped = wrap(held, nextStep++, plan.sequentialize());
            // The invokes resumed the thread, which invalidated the frame read before them.
            thread.frame(0).setValue(local, lastWrapped);
        } else {
            rootSkip = plan.root().skip();
        }
        // Last: with these on, an invoke into the thread would raise the trace's own events inside it.
        // The step out of the frame never fires inside an invoke, which runs above it.
        frameExit = vm.eventRequestManager().createStepRequest(thread, StepRequest.STEP_MIN, StepRequest.STEP_OUT);
        own(frameExit);
        if (held != null && plan.steps().isEmpty()) {
            watchTerminal();
        } else {
            watchBuild();
        }
        synchronized (stateLock) {
            // Publishes the fields above to the worker, whose tasks start under this lock.
        }
    }

    /**
     * Whether a stop is where the chain's statement starts: on or after its first line, with no code
     * of those lines before it. javac puts a statement's first instruction on its first line. ECJ, the
     * compiler JDT LS builds with, gives a head like {@code List<String> out =} no code, so the first
     * instruction is on a later line, and an assignment head's line may hold only the store after the
     * chain.
     *
     * @param stop 1-based line
     * @param firstLine 0-based, as in the plan
     * @param table the method's line table, 1-based lines
     */
    static boolean atChainStart(LineEntry stop, int firstLine, List<LineEntry> table) {
        if (stop.line() - 1 < firstLine) return false;
        for (LineEntry e : table) {
            if (e.line() - 1 >= firstLine && e.codeIndex() < stop.codeIndex()) return false;
        }
        return true;
    }

    /** javac names a lambda's body {@code lambda$m$0}, ECJ {@code lambda$0}; both mark it synthetic. */
    private static boolean isLambda(Method method) {
        return method.isSynthetic() || method.name().startsWith("lambda$");
    }

    /**
     * Whether a deeper frame of the stopped method's class has code on the chain's lines up to the
     * stop's (1-based {@code stopLine}): that frame runs the chain, and the stop is in a lambda of it.
     */
    private boolean chainRunsBelow(int stopLine) throws Exception {
        ReferenceType type = userMethod.declaringType();
        List<StackFrame> frames = thread.frames();
        for (StackFrame f : frames.subList(1, frames.size())) {
            Method m = f.location().method();
            if (!m.declaringType().equals(type) || m.isNative()) continue;
            for (LineEntry e : lineTable(m)) {
                if (e.line() - 1 >= plan.firstLine() && e.line() <= stopLine) return true;
            }
        }
        return false;
    }

    private static List<LineEntry> lineTable(Method method) throws Failure {
        try {
            List<LineEntry> out = new ArrayList<>();
            for (Location l : method.allLineLocations()) out.add(new LineEntry(l.lineNumber(), l.codeIndex()));
            return out;
        } catch (AbsentInformationException e) {
            throw new Failure("unsupported", method + " was compiled without line numbers");
        }
    }

    private LocalVariable streamLocal(StackFrame frame) throws Failure {
        if (plan.local() == null) throw new Failure("badArgument", "the plan has neither a root call nor a local");
        LocalVariable local;
        try {
            local = frame.visibleVariableByName(plan.local());
        } catch (AbsentInformationException e) {
            throw new Failure("unsupported", "the method was compiled without local variable names");
        }
        if (local == null) throw new Failure("unsupported", "no local " + plan.local() + " is visible here");
        if (!STREAM_TYPES.contains(local.typeName())) {
            throw new Failure("unsupported", plan.local() + " is declared as " + local.typeName() + ", not as a java.util.stream stream");
        }
        return local;
    }

    /** On java-debug's event thread, for every event of the VM: never blocks or calls into the VM. */
    private void onEvent(HubEvent hubEvent) throws Exception {
        Event event = hubEvent.event();
        if (event instanceof VMDeathEvent || event instanceof VMDisconnectEvent) {
            if (fail("the VM disconnected")) worker.execute(this::teardown);
            return;
        }
        EventRequest request = event.request();
        if (request == null || request == wake || !Long.valueOf(id).equals(request.getProperty(Silencer.OWN_PROPERTY))) return;
        EventSet set = hubEvent.eventSet();
        hubEvent.park();
        worker.execute(() -> handle(event, set));
    }

    /** Worker: one held event of this trace's requests. The set is resumed unless the terminal parked it. */
    private void handle(Event event, EventSet set) {
        boolean hold = false;
        try {
            if (!building()) return;
            if (leftStatement()) {
                if (fail("the chain did not run: its statement ended before " + plan.terminal().name() + " was called")) teardown();
                return;
            }
            if (event.request() == userExits || event.request() == frameExit) return;
            if (event instanceof MethodExitEvent exit) {
                onExit(exit);
            } else if (event instanceof MethodEntryEvent entry) {
                hold = onTerminalEntry(entry, set);
            }
        } catch (VMDisconnectedException e) {
            fail("the VM disconnected");
        } catch (Exception | Error e) {
            if (fail(e.toString())) teardown();
        } finally {
            if (!hold) resume(set);
            // A release that came while the terminal ran was left to the worker.
            if (released()) dispose();
        }
    }

    private boolean released() {
        synchronized (stateLock) {
            return released;
        }
    }

    private boolean building() {
        synchronized (stateLock) {
            if (released) return false;
            if (state == State.ARMED) state = State.BUILDING;
            return state == State.BUILDING;
        }
    }

    /**
     * Worker. The root is matched by name, JVM arity, return type and caller, after {@code skip} such
     * exits; every later op by receiver: a call on the last wrapped stream from the user's method is
     * the chain's next op, so a different one means the plan does not fit the run.
     */
    private void onExit(MethodExitEvent exit) throws Exception {
        Method method = exit.method();
        if (echoMethod != null) {
            boolean echo = method.equals(echoMethod) && Objects.equals(exit.returnValue(), echoValue);
            echoMethod = null;
            echoValue = null;
            if (echo) return;
        }
        if (lastWrapped == null) {
            StepSpec root = plan.root();
            if (!matches(method, root) || !STREAM_TYPES.contains(method.returnTypeName()) || !calledByUser()) return;
            if (rootSkip > 0) {
                rootSkip--;
                return;
            }
            ObjectReference stream = returned(exit, root);
            setEnabled(false);
            replace(exit, wrap(stream, nextStep++, plan.sequentialize()));
            return;
        }
        if (method.isStatic() || method.isConstructor() || !calledByUser() || !lastWrapped.equals(thread.frame(0).thisObject())) return;
        StepSpec next = plan.steps().get(nextOp);
        if (!matches(method, next)) {
            if (fail("missed " + next.name())) teardown();
            return;
        }
        nextOp++;
        ObjectReference stream = returned(exit, next);
        if (!MODIFIERS.contains(next.name())) {
            setEnabled(false);
            replace(exit, wrap(stream, nextStep++, false));
        } else if (plan.sequentialize() && next.name().equals("parallel")) {
            setEnabled(false);
            replace(exit, invoke(stream, "sequential"));
        } else {
            advance(stream);
        }
    }

    /** Worker: returns {@code stream} from the exiting op instead of its own result. Requests are off. */
    private void replace(MethodExitEvent exit, ObjectReference stream) throws Exception {
        thread.forceEarlyReturn(stream);
        echoMethod = exit.method();
        echoValue = stream;
        advance(stream);
    }

    private void advance(ObjectReference stream) {
        lastWrapped = stream;
        if (nextOp == plan.steps().size()) {
            watchTerminal();
        } else {
            setEnabled(true);
        }
    }

    /**
     * Worker: at the terminal's entry, with no method request left on (any slows the thread to the
     * interpreter), runs the terminal once by invoke, then makes the entered frame return or throw
     * what it did.
     *
     * @return whether the set stays held: the terminal ran and the client steps out next
     */
    private boolean onTerminalEntry(MethodEntryEvent entry, EventSet set) throws Exception {
        Method method = entry.method();
        // The instance filter lets static methods through.
        if (method.isStatic() || method.isConstructor() || !calledByUser()) return false;
        if (!matches(method, plan.terminal())) {
            if (fail("missed " + plan.terminal().name())) teardown();
            return false;
        }
        synchronized (stateLock) {
            if (released || state != State.BUILDING) return false;
            state = State.TERMINAL_RUNNING;
        }
        stopWatching();
        // For requests java-debug made since arm, when the user added or edited a breakpoint.
        silencers.add(Silencer.silence(vm.eventRequestManager()));
        StackFrame frame = thread.frame(0);
        ObjectReference self = frame.thisObject();
        List<Value> arguments = frame.getArgumentValues();
        String kind;
        Value outcome;
        wakeInsideInvoke();
        invoking = true;
        try (RequestTimeout.Raised raised = RequestTimeout.raise(RequestTimeout.Knob.of(vm), Integer.MAX_VALUE)) {
            outcome = self.invokeMethod(thread, method, arguments, INVOKE | ObjectReference.INVOKE_NONVIRTUAL);
            kind = "void".equals(method.returnTypeName()) ? "void" : "value";
        } catch (InvocationException e) {
            outcome = e.exception();
            kind = "threw";
        } finally {
            synchronized (silenceLock) {
                invoking = false;
            }
            deleteWake();
        }
        try {
            // First: the pending return or exception holds the outcome from then on, so the pin below
            // cannot lose it to a collection. Before it, nothing keeps the object the invoke returned.
            if (kind.equals("threw")) {
                thread.stop((ObjectReference) outcome);
            } else {
                thread.forceEarlyReturn(kind.equals("void") ? vm.mirrorOfVoid() : outcome);
            }
        } catch (Exception e) {
            // Resumed as it is, the thread would run the terminal a second time.
            try {
                thread.stop(cancel);
            } catch (Exception again) {
                errors.add("cancelling the terminal: " + again);
            }
            restoreSilencers();
            String why = e instanceof ObjectCollectedException
                    ? "the terminal ran, but what it " + (kind.equals("threw") ? "threw" : "returned")
                            + " was garbage collected before it could be handed back: the program got the cancel exception instead"
                    : "the terminal ran but its outcome could not be returned: " + e;
            if (fail(why)) teardown();
            return false;
        }
        if (outcome instanceof ObjectReference object) keep(pinned(object));
        restoreSilencers();
        boolean hold;
        synchronized (stateLock) {
            terminalKind = kind;
            terminalValue = outcome;
            hold = !released && state == State.TERMINAL_RUNNING;
            if (hold) {
                state = State.PARKED;
            } else if (state == State.TERMINAL_RUNNING) {
                // Released while it ran: no client collects it, and a new arm on the VM must not be busy.
                state = State.FAILED;
                detail = "released";
            }
            stateLock.notifyAll();
        }
        closeSubscription();
        if (hold) {
            parked = set;
            terminalMethod = method;
        }
        return hold;
    }

    /**
     * Worker, right before the terminal's invoke. JDWP holds an interrupt or stop of a thread that is
     * handling an event until that event's handler exits, and an invoke runs inside the handler of the
     * event the thread stopped at, so {@link #abort} would reach the terminal only once it returned.
     * Any event of the thread inside the invoke ends that hold, since JDWP keeps no nesting: this one
     * comes on the terminal's own entry and then expires, leaving no method request on. Without it
     * only a class first prepared inside the invoke ended the hold, which a VM that had run the same
     * stream classes before never does.
     */
    private void wakeInsideInvoke() {
        MethodEntryRequest r = vm.eventRequestManager().createMethodEntryRequest();
        // Eclipse JDI sends ThreadOnly before Count whatever the call order, so only this thread's entries count.
        r.addThreadFilter(thread);
        r.addCountFilter(1);
        r.setSuspendPolicy(EventRequest.SUSPEND_NONE);
        r.putProperty(Silencer.OWN_PROPERTY, id);
        wake = r;
        r.enable();
    }

    /** JDWP already dropped it once it fired; deleting it again is harmless. */
    private void deleteWake() {
        EventRequest r = wake;
        if (r == null) return;
        try {
            vm.eventRequestManager().deleteEventRequest(r);
        } catch (VMDisconnectedException e) {
            // it went with the VM
        } catch (RuntimeException e) {
            errors.add("deleting the invoke's wake-up request: " + e);
        }
    }

    /**
     * Worker: whether the user's frame is gone or past the chain's lines. An exception thrown before
     * the terminal (by the root's arguments, a step's) skips the rest of the statement: uncaught, the
     * frame exits; caught in the frame, it runs on outside the statement. Either way no event of the
     * chain will come.
     */
    private boolean leftStatement() throws IncompatibleThreadStateException {
        int count = thread.frameCount();
        // At depth itself frame 0 is the user's method, so the event is that method's own exit.
        if (count <= depth) return true;
        Location at = thread.frame(count - depth).location();
        int line = at.lineNumber() - 1;
        return !at.method().equals(userMethod) || line < plan.firstLine() || line > plan.lastLine();
    }

    private boolean calledByUser() throws IncompatibleThreadStateException {
        return thread.frameCount() == depth + 1 && thread.frame(1).location().method().equals(userMethod);
    }

    private static boolean matches(Method method, StepSpec spec) {
        return method.name().equals(spec.name()) && method.argumentTypeNames().size() == spec.args();
    }

    private static ObjectReference returned(MethodExitEvent exit, StepSpec spec) {
        if (!(exit.returnValue() instanceof ObjectReference stream)) throw new IllegalStateException(spec.name() + " returned null");
        return stream;
    }

    /** {@code stream.peek(recorder of step)}, {@code .sequential()} too when asked. Requests must be off. */
    private ObjectReference wrap(ObjectReference stream, int step, boolean sequentialize) throws Exception {
        ObjectReference rec = keep(RecorderLoader.pin(() -> recorder.newInstance(thread, stepRecorder, List.of(log, vm.mirrorOf(step)), INVOKE)));
        ObjectReference wrapped = invoke(stream, "peek", rec);
        return sequentialize ? invoke(wrapped, "sequential") : wrapped;
    }

    private ObjectReference invoke(ObjectReference stream, String name, Value... arguments) throws Exception {
        Method method = streamMethod(stream.referenceType(), name, arguments.length);
        return keep(RecorderLoader.pin(() -> (ObjectReference) stream.invokeMethod(thread, method, List.of(arguments), INVOKE)));
    }

    /** Invoked virtually, so any declaration of the hierarchy does; a concrete one is preferred. */
    private static Method streamMethod(ReferenceType type, String name, int arity) {
        Method found = null;
        for (Method m : type.allMethods()) {
            if (!m.name().equals(name) || m.argumentTypeNames().size() != arity) continue;
            if (!m.isAbstract() && !m.isBridge()) return m;
            if (found == null) found = m;
        }
        if (found == null) throw new IllegalStateException(type.name() + " has no " + name);
        return found;
    }

    /** Worker (or arm): one method-exit request per class filter, since JDI ANDs the filters of one request. */
    private void watchBuild() {
        for (String filter : plan.classFilters()) {
            MethodExitRequest r = vm.eventRequestManager().createMethodExitRequest();
            requests.add(r);
            r.addThreadFilter(thread);
            r.addClassFilter(filter);
            own(r);
        }
        watchUserExits();
    }

    private void watchTerminal() {
        deleteRequests();
        echoMethod = null;
        echoValue = null;
        MethodEntryRequest r = vm.eventRequestManager().createMethodEntryRequest();
        requests.add(r);
        r.addThreadFilter(thread);
        r.addInstanceFilter(lastWrapped);
        // The instance filter lets static methods through: <clinit> and others would arrive by the thousand.
        r.addClassFilter("java.util.stream.*");
        own(r);
        watchUserExits();
    }

    /**
     * The user's method exits through this when the statement throws, and a frame that catches it
     * next calls a method of its own class or exits. The plan's filters name JDK classes only, so no
     * exit comes twice in one event set.
     */
    private void watchUserExits() {
        MethodExitRequest r = vm.eventRequestManager().createMethodExitRequest();
        requests.add(r);
        r.addThreadFilter(thread);
        r.addClassFilter(userMethod.declaringType());
        own(r);
        userExits = r;
    }

    private void own(EventRequest r) {
        r.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
        r.putProperty(Silencer.OWN_PROPERTY, id);
        r.enable();
    }

    private void setEnabled(boolean on) {
        for (EventRequest r : requests) r.setEnabled(on);
    }

    private void deleteRequests() {
        try {
            vm.eventRequestManager().deleteEventRequests(requests);
        } finally {
            requests.clear();
        }
    }

    /** All of the trace's requests; also lets the client's DAP step out, since JDI allows one step request per thread. */
    private void stopWatching() {
        try {
            deleteRequests();
        } finally {
            StepRequest step = frameExit;
            frameExit = null;
            if (step != null) vm.eventRequestManager().deleteEventRequest(step);
        }
    }

    /** Moves a running trace to {@link State#FAILED}; false when it was no longer running. */
    private boolean fail(String why) {
        synchronized (stateLock) {
            if (!state.wire.equals("running")) return false;
            state = State.FAILED;
            detail = why;
            stateLock.notifyAll();
            return true;
        }
    }

    /** Worker: takes the trace's requests out and the user's breakpoints back; the program runs on untouched. */
    private void teardown() {
        try {
            stopWatching();
        } catch (VMDisconnectedException e) {
            // they went with the VM
        } catch (RuntimeException e) {
            errors.add("deleting the trace's requests: " + e);
        }
        restoreSilencers();
        closeSubscription();
    }

    /** A request the user removed meanwhile stays off: java-debug made a new one if needed. */
    private void restoreSilencers() {
        synchronized (silenceLock) {
            for (Silencer s : silencers) {
                try {
                    s.restore();
                } catch (RuntimeException e) {
                    errors.add("switching breakpoints back on: " + e);
                }
            }
        }
    }

    /**
     * While the terminal's invoke runs: switches off breakpoints the user added since the last silence,
     * since one hit inside the invoke hangs the session.
     */
    private void resilence() {
        synchronized (silenceLock) {
            if (!invoking || state() != State.TERMINAL_RUNNING) return;
            try {
                Silencer s = Silencer.silence(vm.eventRequestManager());
                if (s.size() > 0) silencers.add(s);
            } catch (VMDisconnectedException e) {
                // nothing left to silence
            } catch (RuntimeException e) {
                errors.add("switching new breakpoints off: " + e);
            }
        }
    }

    private void closeSubscription() {
        JavaDebugSessions.Subscription s = subscription;
        if (s != null) s.close();
    }

    /** Worker: everything the trace holds, a parked thread the client never stepped out included. */
    private void dispose() {
        if (parked != null) {
            if (stillParked()) resume(parked);
            parked = null;
        }
        teardown();
        for (ObjectReference o : pinned) {
            try {
                o.enableCollection();
            } catch (VMDisconnectedException | ObjectCollectedException e) {
                // nothing left to unpin
            } catch (RuntimeException e) {
                errors.add("unpinning: " + e);
            }
        }
        pinned.clear();
    }

    /** Still in the terminal's frame: a resume now cannot undo the client's step-out stop. */
    private boolean stillParked() {
        try {
            return thread.isSuspended() && thread.frameCount() == depth + 1 && thread.frame(0).location().method().equals(terminalMethod);
        } catch (IncompatibleThreadStateException | RuntimeException e) {
            return false;
        }
    }

    private void resume(EventSet set) {
        try {
            set.resume();
        } catch (VMDisconnectedException e) {
            // nothing to resume
        } catch (RuntimeException e) {
            errors.add("resuming the thread: " + e);
        }
    }

    /** Runs {@code task} on the worker and waits for it, a bounded time. Never from the worker itself. */
    private void onWorker(Runnable task) {
        Future<?> done = worker.submit(task);
        try {
            done.get(WORKER_WAIT_MS, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (ExecutionException | TimeoutException e) {
            errors.add("trace worker: " + e);
        }
    }

    /** Stop or abort before the terminal ran (ARMED, BUILDING) takes the trace down: nothing was changed yet. */
    private boolean cancelBeforeTerminal() {
        synchronized (stateLock) {
            if (state != State.ARMED && state != State.BUILDING) return false;
            state = State.CANCELLED;
            detail = CANCELLED;
            stateLock.notifyAll();
        }
        onWorker(this::teardown);
        return true;
    }

    State state() {
        synchronized (stateLock) {
            return state;
        }
    }

    /** java-debug no longer lists the VM: a trace still running fails, though no disconnect event reached it. */
    void vmGone() {
        fail("the VM disconnected");
    }

    /**
     * {@code {state, records, dropped, elapsedMs, detail?}} once the trace leaves the running states or
     * after {@code ms}. While the terminal runs it also checks, every {@value #LIVENESS_POLL_MS} ms,
     * whether the VM began to exit, and switches off breakpoints added meanwhile: the client keeps a
     * wait open while the terminal runs, so this is the only thread that can.
     */
    Map<String, Object> await(long ms) throws InterruptedException {
        State seen;
        String why;
        long end = System.nanoTime() + ms * 1_000_000;
        while (true) {
            if (state() == State.TERMINAL_RUNNING) {
                if (exiting()) {
                    if (fail(EXITED)) abandonTerminal();
                } else {
                    resilence();
                }
            }
            long left = (end - System.nanoTime()) / 1_000_000;
            synchronized (stateLock) {
                if (state.wire.equals("running") && left > 0) stateLock.wait(Math.min(left, LIVENESS_POLL_MS));
                if (!state.wire.equals("running") || end - System.nanoTime() <= 0) {
                    seen = state;
                    why = detail;
                    break;
                }
            }
        }
        long[] counts = counts();
        return waitReply(seen, why, counts[0], counts[1]);
    }

    /**
     * What {@code wait} answers once the VM is gone, from the counts last read: no JDI call. Call it
     * after {@link #vmGone}.
     */
    Map<String, Object> ended() {
        State seen;
        String why;
        synchronized (stateLock) {
            seen = state;
            why = detail;
        }
        return Collections.unmodifiableMap(waitReply(seen, why, size, dropped));
    }

    private Map<String, Object> waitReply(State seen, String why, long records, long droppedRecords) {
        if (why == null && !errors.isEmpty()) why = String.join("; ", errors);
        Map<String, Object> out = Values.json("state", seen.wire, "records", records, "dropped", droppedRecords,
                "elapsedMs", (System.nanoTime() - armedNanos) / 1_000_000);
        if (why != null) out.put("detail", why);
        return out;
    }

    /**
     * Whether the VM began to shut down, by {@code jdk.internal.misc.VM.initLevel} (JDK 9 and later).
     * The VM never finishes exiting while the trace's invoke runs ({@code System.exit} in a lambda,
     * measured on HotSpot 11 to 25), so no disconnect or VM-death event ever comes.
     */
    private boolean exiting() {
        try {
            List<ReferenceType> types = vm.classesByName("jdk.internal.misc.VM");
            if (types.isEmpty()) return false;
            ReferenceType type = types.get(0);
            Field level = type.fieldByName("initLevel");
            Field shutdown = type.fieldByName("SYSTEM_SHUTDOWN");
            if (level == null || shutdown == null) return false;
            Map<Field, Value> values = type.getValues(List.of(level, shutdown));
            return Objects.equals(values.get(level), values.get(shutdown));
        } catch (VMDisconnectedException e) {
            return false;
        }
    }

    /**
     * The invoke never returns, so the worker never gets to undo the trace: the breakpoints come back
     * from here. No request is left (the terminal's went before the invoke) and restoring is idempotent.
     */
    private void abandonTerminal() {
        restoreSilencers();
        closeSubscription();
    }

    /** The log's {@code {size, dropped}}, by field read; the last ones read once the VM is gone. */
    private long[] counts() {
        try {
            Map<Field, Value> counts = log.getValues(List.of(field("size"), field("dropped")));
            size = intOf(counts.get(field("size")));
            dropped = longOf(counts.get(field("dropped")));
        } catch (VMDisconnectedException | ObjectCollectedException e) {
            // the last counts read
        }
        return new long[] {size, dropped};
    }

    /**
     * Stops recording without touching the program: the budget drops to the records so far, so the
     * recorder only counts from now on. A field write, no invoke, so it works while the terminal runs.
     * Before the terminal started, it takes the trace down instead.
     *
     * @return the records kept
     */
    int stopRecording() throws Exception {
        // The budget field is an int, and size never passes it.
        if (!cancelBeforeTerminal()) log.setValue(field("budget"), vm.mirrorOf((int) counts()[0]));
        // An append that passed the budget check before the write may still land.
        return (int) counts()[0];
    }

    /**
     * Interrupts the thread running the terminal, then throws the cancel exception into it, then names
     * the suspended threads holding monitors, waiting {@value #ABORT_STEP_MS} ms after each of the
     * first two for the invoke to return. Before the terminal started, it takes the trace down instead.
     *
     * @return {@code {state}}: {@code interrupted}, {@code stopped}, {@code stuck} with {@code holders},
     *     {@code cancelled} (before the terminal) or {@code finished} (nothing to abort)
     */
    Map<String, Object> abort() throws Exception {
        if (cancelBeforeTerminal()) return Values.json("state", "cancelled");
        if (state() != State.TERMINAL_RUNNING) return Values.json("state", "finished");
        thread.interrupt();
        if (leftTerminal(ABORT_STEP_MS)) return Values.json("state", "interrupted");
        thread.stop(cancel);
        if (leftTerminal(ABORT_STEP_MS)) return Values.json("state", "stopped");
        return Values.json("state", "stuck", "holders", holders());
    }

    private boolean leftTerminal(long ms) throws InterruptedException {
        synchronized (stateLock) {
            long end = System.nanoTime() + ms * 1_000_000;
            for (long left = ms; state == State.TERMINAL_RUNNING && left > 0; left = (end - System.nanoTime()) / 1_000_000) {
                stateLock.wait(left);
            }
            return state != State.TERMINAL_RUNNING;
        }
    }

    /** Threads the debugger holds that own a monitor: one may be what the terminal waits for. */
    private List<Map<String, Object>> holders() {
        List<Map<String, Object>> out = new ArrayList<>();
        if (!vm.canGetOwnedMonitorInfo()) return out;
        for (ThreadReference t : vm.allThreads()) {
            try {
                if (t.isSuspended() && !t.ownedMonitors().isEmpty()) out.add(Values.json("threadId", t.uniqueID(), "name", t.name()));
            } catch (IncompatibleThreadStateException | ObjectCollectedException e) {
                // it resumed or ended meanwhile
            }
        }
        return out;
    }

    /**
     * The records, in the order the program made them, and the terminal's outcome, previewed into
     * {@code handles}. Only once parked, in a stop after the trace's ({@code generation} newer than
     * arm's). The log keeps its values alive until {@link #release}.
     */
    Map<String, Object> collect(Handles<ObjectReference> handles, long generation) throws Failure {
        String kind;
        Value outcome;
        synchronized (stateLock) {
            if (state == State.FAILED || state == State.CANCELLED) throw new Failure("failed", detail);
            if (state != State.PARKED) throw new Failure("busy", "trace " + id + " is running");
            kind = terminalKind;
            outcome = terminalValue;
        }
        if (generation <= this.generation) {
            throw new Failure("stale", "collect needs a stop after the trace's, not generation " + generation);
        }
        handles.begin(generation);
        ToLongFunction<ObjectReference> handle = o -> {
            long objectId = o.uniqueID();
            handles.put(objectId, o);
            return objectId;
        };
        Map<Field, Value> fields = log.getValues(List.of(field("size"), field("dropped"), field("values"), field("steps")));
        int count = intOf(fields.get(field("size")));
        ArrayReference values = (ArrayReference) fields.get(field("values"));
        ArrayReference steps = (ArrayReference) fields.get(field("steps"));
        List<Map<String, Object>> records = new ArrayList<>(count);
        for (int from = 0; from < count; from += CHUNK) {
            int n = Math.min(CHUNK, count - from);
            List<Value> v = values.getValues(from, n);
            List<Value> s = steps.getValues(from, n);
            for (int i = 0; i < n; i++) records.add(Values.json("step", intOf(s.get(i)), "value", Values.preview(v.get(i), handle)));
        }
        Map<String, Object> terminal = switch (kind) {
            case "void" -> Values.json("kind", "void");
            case "threw" -> Values.json("kind", "threw", "exception", Values.preview(outcome, handle));
            default -> Values.json("kind", "value", "value", Values.preview(outcome, handle));
        };
        int skipped = silencers.stream().mapToInt(Silencer::silencedBreakpoints).sum();
        return Values.json("records", records, "dropped", longOf(fields.get(field("dropped"))), "terminal", terminal,
                "skippedBreakpoints", skipped, "sequentialized", plan.sequentialize());
    }

    /**
     * Undoes everything {@link #arm} set up, resuming a parked thread the client did not step out of;
     * later calls do nothing. While the terminal runs, the worker does it once the terminal returns.
     */
    void release() {
        boolean now;
        synchronized (stateLock) {
            if (released) return;
            released = true;
            if (state == State.ARMED || state == State.BUILDING) {
                state = State.FAILED;
                detail = "released";
            }
            now = state != State.TERMINAL_RUNNING && !invoking;
            stateLock.notifyAll();
        }
        if (now) onWorker(this::dispose);
    }

    private ObjectReference keep(ObjectReference pinnedObject) {
        pinned.add(pinnedObject);
        return pinnedObject;
    }

    private static ObjectReference pinned(ObjectReference object) {
        object.disableCollection();
        return object;
    }

    private Field field(String name) {
        return recorder.fieldByName(name);
    }

    private static int intOf(Value value) {
        return ((IntegerValue) value).value();
    }

    private static long longOf(Value value) {
        return ((LongValue) value).value();
    }
}
