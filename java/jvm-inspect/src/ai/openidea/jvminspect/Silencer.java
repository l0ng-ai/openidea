package ai.openidea.jvminspect;

import com.sun.jdi.request.BreakpointRequest;
import com.sun.jdi.request.EventRequest;
import com.sun.jdi.request.EventRequestManager;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;

/**
 * Switches off the user's breakpoints and exception breakpoints for a trace, and back on after it. A
 * breakpoint hit while the bundle invokes into the thread makes java-debug report a stop the invoke
 * then waits on forever.
 */
final class Silencer {
    /** The property that marks the bundle's own requests; its value is the trace id. */
    static final String OWN_PROPERTY = "oi";

    private final List<EventRequest> silenced;
    private final int breakpoints;

    private Silencer(List<EventRequest> silenced) {
        this.silenced = silenced;
        this.breakpoints = (int) silenced.stream().filter(BreakpointRequest.class::isInstance).count();
    }

    static Silencer silence(EventRequestManager erm) {
        List<EventRequest> requests = new ArrayList<>(erm.breakpointRequests());
        requests.addAll(erm.exceptionRequests());
        return silence(requests);
    }

    /** Switches off the enabled requests not marked {@link #OWN_PROPERTY}. */
    static Silencer silence(Collection<? extends EventRequest> requests) {
        List<EventRequest> silenced = new ArrayList<>();
        for (EventRequest r : requests) {
            if (r.isEnabled() && r.getProperty(OWN_PROPERTY) == null) {
                r.disable();
                silenced.add(r);
            }
        }
        return new Silencer(silenced);
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
     * Switches the silenced requests back on; later calls do nothing.
     *
     * @return requests that could not be switched on: java-debug deletes a request when the user edits
     *     its breakpoint and makes a new one, which is already in the right state
     */
    synchronized int restore() {
        int failures = 0;
        for (EventRequest r : silenced) {
            try {
                r.enable();
            } catch (RuntimeException e) {
                // InvalidRequestStateException for a deleted request, VMDisconnectedException once the VM is gone;
                // either way the rest must still be restored.
                failures++;
            }
        }
        silenced.clear();
        return failures;
    }
}
