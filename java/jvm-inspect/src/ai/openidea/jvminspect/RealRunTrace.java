package ai.openidea.jvminspect;

import ai.openidea.jvminspect.JavaDebugSessions.Hub;
import ai.openidea.jvminspect.JavaDebugSessions.HubEvent;
import com.sun.jdi.ClassType;
import com.sun.jdi.Field;
import com.sun.jdi.IntegerValue;
import com.sun.jdi.ObjectReference;
import com.sun.jdi.ThreadReference;
import com.sun.jdi.Value;
import com.sun.jdi.VirtualMachine;
import java.security.SecureRandom;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * One stream trace of a real run, from {@code stream.arm} to {@code stream.release}. Everything it sets
 * up in the VM is undone by {@link #release}, in reverse order.
 *
 * <p>{@link #stateLock} guards the state and is never held across a JDI call, so java-debug's event
 * thread, which takes it, never waits on JDWP traffic.
 */
final class RealRunTrace {
    static final int DEFAULT_BUDGET = 50_000;
    /** The prefix of the message of the exception that cancels the terminal. */
    static final String CANCEL_PREFIX = "oi-cancel:";

    enum State {
        /** Set up; the client has not continued the thread yet. */
        ARMED("running"),
        BUILDING("running"),
        TERMINAL_RUNNING("running"),
        /** The terminal returned or threw; the thread is held until the client steps out. */
        PARKED("parked"),
        FAILED("failed");

        final String wire;

        State(String wire) {
            this.wire = wire;
        }
    }

    final long id;
    final VirtualMachine vm;
    final ThreadReference thread;
    final RealRunPlan plan;
    final int budget;
    private final long armedNanos = System.nanoTime();
    /** Also the lock of {@link #release}. */
    private final Deque<Runnable> undo = new ArrayDeque<>();
    /** Failures nobody could be told about when they happened: listener errors, cleanup that did not work. */
    private final List<String> errors = new CopyOnWriteArrayList<>();
    private final Object stateLock = new Object();
    private State state = State.ARMED;
    private String detail;
    private Silencer silencer;
    private ClassType recorder;
    private ObjectReference log;
    private ObjectReference cancel;

    private RealRunTrace(long id, VirtualMachine vm, ThreadReference thread, RealRunPlan plan, int budget) {
        this.id = id;
        this.vm = vm;
        this.thread = thread;
        this.plan = plan;
        this.budget = budget;
    }

    /**
     * Silences the user's breakpoints, defines the recorder if the VM has none, creates the log and the
     * cancel exception, and starts listening to java-debug's events. {@code thread} must be suspended
     * by an event: this invokes into it. On failure everything done so far is undone.
     */
    static RealRunTrace arm(long id, VirtualMachine vm, ThreadReference thread, RealRunPlan plan, int budget, Hub hub)
            throws Exception {
        RealRunTrace trace = new RealRunTrace(id, vm, thread, plan, budget);
        try {
            trace.setUp(hub);
            return trace;
        } catch (Exception | Error e) {
            trace.release();
            throw e;
        }
    }

    private void setUp(Hub hub) throws Exception {
        // Before the first invoke: a breakpoint hit inside it would hang the session.
        silencer = Silencer.silence(vm.eventRequestManager());
        undo.push(() -> {
            int failures = silencer.restore();
            if (failures > 0) errors.add(failures + " breakpoint requests could not be switched back on");
        });
        recorder = RecorderLoader.classFor(vm, thread);
        int invoke = ObjectReference.INVOKE_SINGLE_THREADED;
        log = RecorderLoader.pin(() -> recorder.newInstance(thread, RecorderLoader.method(recorder, "<init>", "(I)V"),
                List.of(vm.mirrorOf(budget)), invoke));
        undo.push(log::enableCollection);
        ClassType runtimeException = RecorderLoader.classType(vm, "java.lang.RuntimeException");
        byte[] nonce = new byte[8];
        new SecureRandom().nextBytes(nonce);
        String message = CANCEL_PREFIX + HexFormat.of().formatHex(nonce);
        cancel = RecorderLoader.pin(() -> runtimeException.newInstance(thread,
                RecorderLoader.method(runtimeException, "<init>", "(Ljava/lang/String;)V"), List.of(vm.mirrorOf(message)), invoke));
        undo.push(cancel::enableCollection);
        JavaDebugSessions.Subscription subscription = hub.subscribe(this::onEvent, e -> errors.add("event listener: " + e));
        undo.push(subscription::close);
    }

    /**
     * On java-debug's event thread, for every event of the VM: never block or invoke here. The trace's
     * own requests carry {@link Silencer#OWN_PROPERTY} = {@link #id}; any other event is java-debug's.
     */
    private void onEvent(HubEvent hubEvent) {
        // TODO: match the events of this trace's requests to wrap the steps and run the terminal.
    }

    State state() {
        synchronized (stateLock) {
            return state;
        }
    }

    /** {@code {state, records, dropped, elapsedMs, detail?}} once the trace leaves the running states or after {@code ms}. */
    Map<String, Object> await(long ms) throws InterruptedException {
        State seen;
        String why;
        synchronized (stateLock) {
            long end = System.nanoTime() + ms * 1_000_000;
            for (long left = ms; state.wire.equals("running") && left > 0; left = (end - System.nanoTime()) / 1_000_000) {
                stateLock.wait(left);
            }
            seen = state;
            why = detail;
        }
        if (why == null && !errors.isEmpty()) why = String.join("; ", errors);
        Map<Field, Value> counts = log.getValues(List.of(field("size"), field("dropped")));
        Map<String, Object> out = Values.json("state", seen.wire, "records", intOf(counts.get(field("size"))),
                "dropped", intOf(counts.get(field("dropped"))), "elapsedMs", (System.nanoTime() - armedNanos) / 1_000_000);
        if (why != null) out.put("detail", why);
        return out;
    }

    /**
     * Stops recording without touching the program: the budget drops to the records so far, so the
     * recorder only counts from now on. A field write, no invoke, so it works while the terminal runs.
     *
     * @return the records kept
     */
    int stopRecording() throws Exception {
        log.setValue(field("budget"), vm.mirrorOf(intOf(log.getValue(field("size")))));
        // An append that passed the budget check before the write may still land.
        return intOf(log.getValue(field("size")));
    }

    /** Undoes everything {@link #arm} set up; later calls do nothing. Never throws. */
    void release() {
        synchronized (undo) {
            while (!undo.isEmpty()) {
                try {
                    undo.pop().run();
                } catch (RuntimeException e) {
                    errors.add("release: " + e);
                }
            }
        }
        synchronized (stateLock) {
            stateLock.notifyAll();
        }
    }

    private Field field(String name) {
        return recorder.fieldByName(name);
    }

    private static int intOf(Value value) {
        return ((IntegerValue) value).value();
    }
}
