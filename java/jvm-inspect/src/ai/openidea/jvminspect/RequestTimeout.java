package ai.openidea.jvminspect;

import com.sun.jdi.VirtualMachine;

/**
 * Raises Eclipse JDI's reply timeout for a slow command. The timeout is per VM, so java-debug's own
 * requests that wait behind the command get it too, and do not fail either.
 */
final class RequestTimeout {
    interface Knob {
        int get();

        void set(int ms);

        static Knob of(VirtualMachine vm) throws ConnectedVms.Unsupported {
            if (!(vm instanceof org.eclipse.jdi.VirtualMachine eclipse)) {
                throw new ConnectedVms.Unsupported(vm.getClass().getName() + " is not an Eclipse JDI VM");
            }
            return new Knob() {
                @Override
                public int get() {
                    return eclipse.getRequestTimeout();
                }

                @Override
                public void set(int ms) {
                    eclipse.setRequestTimeout(ms);
                }
            };
        }
    }

    interface Raised extends AutoCloseable {
        @Override
        void close();
    }

    private RequestTimeout() {}

    /**
     * Sets {@code max(current, ms)}. Closing restores the old value only if the timeout is still the
     * raised one: java-debug sets it on every VM when its timeout setting changes.
     */
    static Raised raise(Knob knob, int ms) {
        int old = knob.get();
        int raised = Math.max(old, ms);
        if (raised == old) return () -> {};
        knob.set(raised);
        return () -> {
            if (knob.get() == raised) knob.set(old);
        };
    }
}
