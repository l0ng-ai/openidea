package ai.openidea.jvminspect;

import ai.openidea.jvminspect.InspectCommand.Failure;
import com.sun.jdi.ClassType;
import com.sun.jdi.ReferenceType;
import com.sun.jdi.VMDisconnectedException;
import com.sun.jdi.VirtualMachine;
import com.sun.jdi.event.ClassPrepareEvent;
import com.sun.jdi.event.Event;
import com.sun.jdi.request.ClassPrepareRequest;
import com.sun.jdi.request.EventRequest;
import com.sun.jdi.request.EventRequestManager;
import com.sun.jdi.request.ExceptionRequest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Exception breakpoints on a chosen class, one list per VM, as exception requests of the bundle's own.
 * java-debug turns every exception event into a stop, whoever made its request. It also deletes every
 * exception request whenever it sets its own filters, so the client sends the list again after each
 * {@code setExceptionBreakpoints}. Two requests that match one throw give two stops, so a request
 * leaves out what an enabled java-debug filter or a breakpoint on a superclass already reports.
 */
final class ExceptionBreakpoints {
    /** Marks the bundle's requests; the value is the {@link Spec}. Not {@link Silencer#OWN_PROPERTY}: a trace silences these. */
    static final String PROPERTY = "oi.exc";
    private static final Map<VirtualMachine, ExceptionBreakpoints> VMS = new IdentityHashMap<>();

    record Spec(String id, String className, boolean caught, boolean uncaught, boolean enabled, List<String> classFilters,
            List<String> classExclusionFilters) {
        /** From the Gson JSON of {@code executeCommand}. */
        static Spec of(Object json) {
            Map<?, ?> m = (Map<?, ?>) json;
            return new Spec(text(m, "id"), text(m, "className"), Boolean.TRUE.equals(m.get("caught")), Boolean.TRUE.equals(m.get("uncaught")),
                    !Boolean.FALSE.equals(m.get("enabled")), patterns(m.get("classFilters")), patterns(m.get("classExclusionFilters")));
        }

        boolean hasClassFilters() {
            return !classFilters.isEmpty() || !classExclusionFilters.isEmpty();
        }

        private static String text(Map<?, ?> m, String key) {
            if (!(m.get(key) instanceof String s) || s.isBlank()) throw new IllegalArgumentException("missing " + key);
            return s.trim();
        }

        private static List<String> patterns(Object json) {
            if (!(json instanceof List<?> list)) return List.of();
            return list.stream().filter(String.class::isInstance).map(s -> ((String) s).trim()).filter(s -> !s.isEmpty()).toList();
        }
    }

    record Flags(boolean caught, boolean uncaught) {
        boolean none() {
            return !caught && !uncaught;
        }
    }

    private final VirtualMachine vm;
    private JavaDebugSessions.Subscription subscription;
    private List<Spec> specs = List.of();
    /** The list to apply once the VM's stream trace no longer silences its breakpoints. */
    private List<Spec> deferred;
    private boolean javaDebugCaught;
    private boolean javaDebugUncaught;

    private ExceptionBreakpoints(VirtualMachine vm) {
        this.vm = vm;
    }

    /**
     * Replaces the VM's list. Under the inspect commands' lock, which a stream trace's {@code arm} holds
     * too: a request made while a trace silences breakpoints would be on inside the trace.
     *
     * @return per breakpoint {@code {id, state}}: {@code armed}, {@code pending} (class not loaded yet),
     *     {@code disabled} or {@code deferred} (applied when the VM's stream trace ends)
     */
    static List<Map<String, Object>> set(VirtualMachine vm, List<Spec> specs) throws Failure, ConnectedVms.Unsupported {
        synchronized (InspectCommand.handlesFor(vm)) {
            ExceptionBreakpoints state;
            synchronized (VMS) {
                state = VMS.computeIfAbsent(vm, ExceptionBreakpoints::new);
            }
            return state.replace(specs);
        }
    }

    /** Drops the lists of VMs java-debug no longer has; their requests went with the VM. */
    static void forgetGone(Set<VirtualMachine> live) {
        List<ExceptionBreakpoints> gone = new ArrayList<>();
        synchronized (VMS) {
            VMS.entrySet().removeIf(e -> !live.contains(e.getKey()) && gone.add(e.getValue()));
        }
        for (ExceptionBreakpoints state : gone) state.close();
    }

    /**
     * After a stream trace switched the breakpoints back on: applies a list deferred meanwhile, before
     * the trace decides whether it must watch an uncaught throw itself. Without the inspect commands'
     * lock, which one of them can hold for seconds while the caller is java-debug's event thread or
     * the trace's worker; the trace has stopped silencing, so no arm can be silencing meanwhile.
     */
    static void traceEnded(VirtualMachine vm) {
        ExceptionBreakpoints state;
        synchronized (VMS) {
            state = VMS.get(vm);
        }
        if (state != null) state.applyDeferred();
    }

    /** Whether {@code r} reports every throw of its type, for a trace deciding if it must watch one itself. */
    static boolean coversWholeType(EventRequest r) {
        return !(r.getProperty(PROPERTY) instanceof Spec spec) || !spec.hasClassFilters();
    }

    /**
     * What a request for {@code spec} on a type with the superclasses {@code supers} must still report:
     * not what java-debug's own all-exception filters report, nor what an enabled breakpoint without
     * class filters reports already: one on a superclass, or on the same class when it comes earlier or
     * {@code spec} has filters. Two breakpoints with class filters can still both report one throw.
     */
    static Flags uncovered(Spec spec, List<String> supers, boolean javaDebugCaught, boolean javaDebugUncaught, List<Spec> all) {
        boolean caught = spec.caught() && !javaDebugCaught;
        boolean uncaught = spec.uncaught() && !javaDebugUncaught;
        boolean earlier = true;
        for (Spec other : all) {
            if (other == spec) {
                earlier = false;
                continue;
            }
            if (!other.enabled() || other.hasClassFilters()) continue;
            boolean twin = other.className().equals(spec.className()) && (earlier || spec.hasClassFilters());
            if (twin || supers.contains(other.className())) {
                caught &= !other.caught();
                uncaught &= !other.uncaught();
            }
        }
        return new Flags(caught, uncaught);
    }

    private synchronized List<Map<String, Object>> replace(List<Spec> next) throws Failure, ConnectedVms.Unsupported {
        subscribe();
        if (StreamCommand.silencing(vm)) {
            deferred = next;
            return states(next, "deferred");
        }
        deferred = null;
        return apply(next);
    }

    private synchronized void applyDeferred() {
        List<Spec> next = deferred;
        if (next == null || StreamCommand.silencing(vm)) return;
        deferred = null;
        try {
            apply(next);
        } catch (VMDisconnectedException e) {
            // nothing left to arm
        }
    }

    private void subscribe() throws Failure, ConnectedVms.Unsupported {
        if (subscription != null) return;
        JavaDebugSessions.Hub hub = JavaDebugSessions.of(vm)
                .orElseThrow(() -> new Failure("noSession", "java-debug registered no session for this VM (hotCodeReplace is never?)"));
        subscription = hub.subscribe(this::onEvent, e -> {
            // A failing listener only costs later class loads their requests.
        });
    }

    private List<Map<String, Object>> apply(List<Spec> next) {
        EventRequestManager erm = vm.eventRequestManager();
        List<EventRequest> own = new ArrayList<>();
        for (EventRequest r : erm.exceptionRequests()) if (r.getProperty(PROPERTY) != null) own.add(r);
        for (EventRequest r : erm.classPrepareRequests()) if (r.getProperty(PROPERTY) != null) own.add(r);
        erm.deleteEventRequests(own);
        specs = next;
        javaDebugCaught = false;
        javaDebugUncaught = false;
        for (ExceptionRequest r : erm.exceptionRequests()) {
            if (r.isEnabled() && r.exception() == null && r.getProperty(Silencer.OWN_PROPERTY) == null) {
                javaDebugCaught |= r.notifyCaught();
                javaDebugUncaught |= r.notifyUncaught();
            }
        }
        List<Map<String, Object>> out = new ArrayList<>();
        for (Spec spec : next) {
            if (!spec.enabled() || (!spec.caught() && !spec.uncaught())) {
                out.add(state(spec, "disabled"));
                continue;
            }
            // A class loaded later, or by another class loader, gets its request when it is prepared.
            ClassPrepareRequest prepare = erm.createClassPrepareRequest();
            prepare.addClassFilter(spec.className());
            prepare.putProperty(PROPERTY, spec);
            prepare.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
            prepare.enable();
            List<ReferenceType> loaded = vm.classesByName(spec.className());
            for (ReferenceType type : loaded) arm(spec, type);
            out.add(state(spec, loaded.isEmpty() ? "pending" : "armed"));
        }
        return out;
    }

    private void arm(Spec spec, ReferenceType type) {
        Flags flags = uncovered(spec, superclasses(type), javaDebugCaught, javaDebugUncaught, specs);
        if (flags.none()) return;
        ExceptionRequest r = vm.eventRequestManager().createExceptionRequest(type, flags.caught(), flags.uncaught());
        for (String pattern : spec.classFilters()) r.addClassFilter(pattern);
        for (String pattern : spec.classExclusionFilters()) r.addClassExclusionFilter(pattern);
        r.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
        r.putProperty(PROPERTY, spec);
        r.enable();
    }

    /** java-debug's event thread: the class-loading thread waits until this returns. */
    private synchronized void onEvent(JavaDebugSessions.HubEvent e) throws IllegalAccessException {
        Event event = e.event();
        if (!(event instanceof ClassPrepareEvent prepared) || !(event.request() instanceof ClassPrepareRequest request)) return;
        if (!(request.getProperty(PROPERTY) instanceof Spec spec) || !specs.contains(spec)) return;
        // A request made now would be on inside the trace: the whole list is applied again after it.
        if (StreamCommand.silencing(vm)) {
            if (deferred == null) deferred = specs;
            return;
        }
        arm(spec, prepared.referenceType());
    }

    private static List<String> superclasses(ReferenceType type) {
        List<String> out = new ArrayList<>();
        for (ClassType t = type instanceof ClassType c ? c.superclass() : null; t != null; t = t.superclass()) out.add(t.name());
        return out;
    }

    private synchronized void close() {
        if (subscription != null) subscription.close();
        subscription = null;
    }

    private static List<Map<String, Object>> states(List<Spec> specs, String state) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Spec spec : specs) out.add(state(spec, spec.enabled() ? state : "disabled"));
        return Collections.unmodifiableList(out);
    }

    private static Map<String, Object> state(Spec spec, String state) {
        return Values.json("id", spec.id(), "state", state);
    }
}
