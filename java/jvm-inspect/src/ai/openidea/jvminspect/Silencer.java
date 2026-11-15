package ai.openidea.jvminspect;

import com.sun.jdi.request.BreakpointRequest;
import com.sun.jdi.request.EventRequest;
import com.sun.jdi.request.EventRequestManager;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Set;
import java.util.function.Supplier;

/**
 * Switches off the user's breakpoints and exception breakpoints for a trace, and back on after it. A
 * breakpoint hit while the bundle invokes into the thread makes java-debug report a stop the invoke
 * then waits on forever.
 */
final class Silencer {
    /** The property that marks the bundle's own requests; its value is the trace id. */
    static final String OWN_PROPERTY = "oi";

    private final Supplier<List<EventRequest>> current;
    private final List<EventRequest> silenced;
    private final int breakpoints;

    private Silencer(Supplier<List<EventRequest>> current, List<EventRequest> silenced) {
        this.current = current;
        this.silenced = silenced;
        this.breakpoints = (int) silenced.stream().filter(BreakpointRequest.class::isInstance).count();
    }

    static Silencer silence(EventRequestManager erm) {
        return silence(() -> {
            List<EventRequest> requests = new ArrayList<>(erm.breakpointRequests());
            requests.addAll(erm.exceptionRequests());
            return requests;
        });
    }

    /**
     * Switches off the enabled requests not marked {@link #OWN_PROPERTY}.
     *
     * @param current the breakpoint and exception requests the VM has now; asked again by {@link #restore}
     */
    static Silencer silence(Supplier<List<EventRequest>> current) {
        List<EventRequest> silenced = new ArrayList<>();
        for (EventRequest r : current.get()) {
            if (r.isEnabled() && r.getProperty(OWN_PROPERTY) == null) {
                r.disable();
                silenced.add(r);
            }
        }
        return new Silencer(current, silenced);
    }

    /** Requests switched off and not yet restored. */
    synchronized int size() {
        return silenced.size();
    }

    /** {@link BreakpointRequest}s among the silenced ones, counted when silenced. */
    int silencedBreakpoints() {
        return breakpoints;
    }

    /**
     * Switches back on the silenced requests the VM still has; later calls do nothing.
     *
     * @return silenced requests not switched back on. java-debug deletes a request when the user edits
     *     or removes its breakpoint; a new one is already in the right state.
     */
    synchronized int restore() {
        int failures = 0;
        Set<EventRequest> present = Collections.newSetFromMap(new IdentityHashMap<>());
        try {
            present.addAll(current.get());
        } catch (RuntimeException e) {
            // VMDisconnectedException: nothing is left to restore.
        }
        for (EventRequest r : silenced) {
            // Eclipse JDI enables a deleted request without complaint, re-installing a breakpoint that
            // java-debug no longer lists and so never removes: only requests still listed are enabled.
            if (!present.contains(r)) {
                failures++;
                continue;
            }
            try {
                r.enable();
            } catch (RuntimeException e) {
                failures++;
            }
        }
        silenced.clear();
        return failures;
    }
}
