package ai.openidea.jvminspect;

import ai.openidea.jvminspect.InspectCommand.Failure;
import ai.openidea.jvminspect.VmSelector.Target;
import ai.openidea.jvminspect.VmSelector.VmInfo;
import com.sun.jdi.AbsentInformationException;
import com.sun.jdi.ClassNotLoadedException;
import com.sun.jdi.IncompatibleThreadStateException;
import com.sun.jdi.InternalException;
import com.sun.jdi.InvalidStackFrameException;
import com.sun.jdi.InvalidTypeException;
import com.sun.jdi.InvocationException;
import com.sun.jdi.ObjectCollectedException;
import com.sun.jdi.ObjectReference;
import com.sun.jdi.ThreadReference;
import com.sun.jdi.VMDisconnectedException;
import com.sun.jdi.VirtualMachine;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.jdt.ls.core.internal.IDelegateCommandHandler;

/**
 * The {@code openidea.jvm.stream.*} commands: trace a stream chain while the program runs it, one
 * trace per VM. Replies have the shape of {@link InspectCommand}'s; the codes are matched by the Rust
 * client.
 */
public final class StreamCommand implements IDelegateCommandHandler {
    private static final String PREFIX = "openidea.jvm.stream.";
    /** {@code stream.wait} holds a JDT LS request thread at most this long. */
    private static final long MAX_WAIT_MS = 30_000;
    /** How many traces of VMs that disconnected keep their last {@code wait} answer. */
    private static final int GONE_KEPT = 16;
    private static final AtomicLong IDS = new AtomicLong();
    private static final Map<VirtualMachine, RealRunTrace> TRACES = new IdentityHashMap<>();
    /** The {@code token} each trace was armed with: a client whose {@code arm} timed out releases by it. */
    private static final Map<RealRunTrace, String> TOKENS = new IdentityHashMap<>();
    /** By trace id, the answer {@link RealRunTrace#ended} gave: the trace itself would keep its dead VM's mirrors. */
    private static final Map<Long, Map<String, Object>> GONE = new LinkedHashMap<>() {
        private static final long serialVersionUID = 1L;

        @Override
        protected boolean removeEldestEntry(Map.Entry<Long, Map<String, Object>> eldest) {
            return size() > GONE_KEPT;
        }
    };

    @Override
    public Object executeCommand(String command, List<Object> arguments, IProgressMonitor monitor) throws Exception {
        try {
            List<VmInfo> vms = InspectCommand.connected();
            forgetGone(vms);
            Target target = Target.of(arguments.get(0));
            Map<?, ?> args = (Map<?, ?>) arguments.get(1);
            String name = command.substring(PREFIX.length());
            VirtualMachine vm;
            try {
                vm = InspectCommand.select(vms, target);
            } catch (Failure e) {
                Map<String, Object> gone = name.equals("arm") ? null : gone(args);
                if (gone == null) throw e;
                if (name.equals("release") && args.get("token") instanceof String) return InspectCommand.ok(Map.of());
                return InspectCommand.ok(switch (name) {
                    case "wait" -> gone;
                    case "release" -> Map.of();
                    default -> throw e;
                });
            }
            return InspectCommand.ok(switch (name) {
                case "arm" -> Values.json("traceId", arm(vm, target, args));
                case "wait" -> trace(vm, args).await(Math.min(Math.max(0, number(args, "ms").longValue()), MAX_WAIT_MS));
                case "stop" -> Values.json("records", trace(vm, args).stopRecording());
                case "abort" -> trace(vm, args).abort();
                case "collect" -> collect(vm, target, trace(vm, args));
                case "release" -> args.get("token") instanceof String token && !(args.get("traceId") instanceof Number)
                        ? releaseArmed(vm, token)
                        : release(vm, trace(vm, args));
                default -> throw new IllegalArgumentException("unknown command " + command);
            });
        } catch (Failure e) {
            return InspectCommand.error(e.code, e.getMessage());
        } catch (ConnectedVms.Unsupported e) {
            return InspectCommand.error("unsupported", e.getMessage());
        } catch (Handles.Stale e) {
            return InspectCommand.error("stale", e.getMessage());
        } catch (IncompatibleThreadStateException e) {
            return InspectCommand.error("notSuspended", "the thread is not stopped at an event: " + e.getMessage());
        } catch (AbsentInformationException e) {
            return InspectCommand.error("unsupported", "compiled without debug information: " + e.getMessage());
        } catch (ObjectCollectedException e) {
            return InspectCommand.error("collected", String.valueOf(e.getMessage()));
        } catch (org.eclipse.jdi.TimeoutException e) {
            return InspectCommand.error("timedOut", String.valueOf(e.getMessage()));
        } catch (VMDisconnectedException e) {
            return InspectCommand.error("vmNotFound", "the VM disconnected");
        } catch (InvocationException | ClassNotLoadedException | InvalidTypeException | InvalidStackFrameException | InternalException
                | IllegalStateException | ClassCastException e) {
            // Failures the commands do not expect, from JDI or from a VM unlike the plan (a stream
            // method missing, a value of another kind): still a reply the client can decode.
            return InspectCommand.error("failed", e.toString());
        }
    }

    /**
     * A trace that is still running answers {@code busy}; one that finished (parked or failed) is
     * released first, since the client never releases a finished trace itself.
     */
    private static long arm(VirtualMachine vm, Target target, Map<?, ?> args) throws Exception {
        long threadId = number(args, "threadId").longValue();
        RealRunPlan plan = RealRunPlan.of(args.get("plan"));
        int budget = budget(args.get("budget"));
        if (!vm.canForceEarlyReturn() || !vm.canGetMethodReturnValues()) {
            throw new Failure("unsupported", "the VM cannot force early returns or report method return values");
        }
        ThreadReference thread = vm.allThreads().stream().filter(t -> t.uniqueID() == threadId).findFirst()
                .orElseThrow(() -> new Failure("stale", "no thread " + threadId));
        if (!thread.isSuspended()) throw new Failure("notSuspended", "thread " + threadId + " is running");
        JavaDebugSessions.Hub hub = JavaDebugSessions.of(vm)
                .orElseThrow(() -> new Failure("noSession", "java-debug registered no session for this VM (hotCodeReplace is never?)"));
        // The inspect commands' per-VM lock: it also keeps two arms of one VM apart, and the set-up
        // invokes into the thread those commands read from.
        synchronized (InspectCommand.handlesFor(vm)) {
            RealRunTrace current;
            synchronized (TRACES) {
                current = TRACES.get(vm);
            }
            if (current != null && current.state().wire.equals("running")) throw new Failure("busy", "trace " + current.id + " is running");
            if (current != null) release(vm, current);
            RealRunTrace trace = RealRunTrace.arm(IDS.incrementAndGet(), vm, thread, plan, budget, target.generation(), hub);
            synchronized (TRACES) {
                TRACES.put(vm, trace);
                if (args.get("token") instanceof String token) TOKENS.put(trace, token);
            }
            return trace.id;
        }
    }

    /** Under the inspect commands' lock: the previews go into their handle table, so the UI can expand them. */
    private static Map<String, Object> collect(VirtualMachine vm, Target target, RealRunTrace trace) throws Failure {
        Handles<ObjectReference> handles = InspectCommand.handlesFor(vm);
        synchronized (handles) {
            return trace.collect(handles, target.generation());
        }
    }

    /** The VM's trace has the user's breakpoints switched off. */
    static boolean silencing(VirtualMachine vm) {
        RealRunTrace trace;
        synchronized (TRACES) {
            trace = TRACES.get(vm);
        }
        return trace != null && trace.silencing();
    }

    private static RealRunTrace trace(VirtualMachine vm, Map<?, ?> args) throws Failure {
        long id = number(args, "traceId").longValue();
        synchronized (TRACES) {
            RealRunTrace trace = TRACES.get(vm);
            if (trace == null || trace.id != id) throw new Failure("noTrace", "no trace " + id + " on this VM");
            return trace;
        }
    }

    private static Map<String, Object> gone(Map<?, ?> args) {
        if (!(args.get("traceId") instanceof Number id)) return null;
        synchronized (TRACES) {
            return GONE.get(id.longValue());
        }
    }

    /** A trace whose terminal still runs stays the VM's trace, so no arm starts beside it. */
    private static Map<String, Object> release(VirtualMachine vm, RealRunTrace trace) {
        trace.release();
        if (!trace.state().wire.equals("running")) {
            synchronized (TRACES) {
                TRACES.remove(vm, trace);
                TOKENS.remove(trace);
            }
        }
        return Map.of();
    }

    /**
     * The trace armed with {@code token}, whose {@code arm} reply the client gave up on: released,
     * so its breakpoints come back on. Under the arm lock, so an arm still setting up finishes first.
     */
    private static Map<String, Object> releaseArmed(VirtualMachine vm, String token) {
        synchronized (InspectCommand.handlesFor(vm)) {
            RealRunTrace current;
            synchronized (TRACES) {
                current = TRACES.get(vm);
                if (current == null || !token.equals(TOKENS.get(current))) return Map.of();
            }
            return release(vm, current);
        }
    }

    /** Releases the traces of VMs java-debug no longer has; their requests and objects went with the VM. */
    private static void forgetGone(List<VmInfo> vms) {
        Set<VirtualMachine> live = Collections.newSetFromMap(new IdentityHashMap<>());
        for (VmInfo v : vms) live.add(v.vm());
        List<RealRunTrace> gone = new ArrayList<>();
        synchronized (TRACES) {
            for (Iterator<Map.Entry<VirtualMachine, RealRunTrace>> i = TRACES.entrySet().iterator(); i.hasNext(); ) {
                Map.Entry<VirtualMachine, RealRunTrace> e = i.next();
                if (live.contains(e.getKey())) continue;
                RealRunTrace trace = e.getValue();
                trace.vmGone();
                TOKENS.remove(trace);
                GONE.put(trace.id, trace.ended());
                gone.add(trace);
                i.remove();
            }
        }
        // Outside the lock: release waits on the trace's worker, which may still be talking to the VM.
        for (RealRunTrace trace : gone) trace.release();
        RecorderLoader.retain(live);
    }

    /** {@link RealRunTrace#DEFAULT_BUDGET} when absent; otherwise a whole number from 1 to {@link Integer#MAX_VALUE}. */
    private static int budget(Object json) throws Failure {
        if (json == null) return RealRunTrace.DEFAULT_BUDGET;
        if (json instanceof Number n) {
            double v = n.doubleValue();
            if (v >= 1 && v <= Integer.MAX_VALUE && v == Math.rint(v)) return n.intValue();
        }
        throw new Failure("badArgument", "budget must be a whole number from 1 to " + Integer.MAX_VALUE + ", not " + json);
    }

    private static Number number(Map<?, ?> args, String name) {
        Object value = args.get(name);
        if (!(value instanceof Number n)) throw new IllegalArgumentException(name + " is not a number: " + value);
        return n;
    }
}
