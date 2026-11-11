package ai.openidea.jvminspect;

import ai.openidea.jvminspect.VmSelector.Target;
import ai.openidea.jvminspect.VmSelector.VmInfo;
import java.util.List;

/** The JDI-free logic of the bundle; run with {@code build.py <jdtls> --test}. */
public final class SelfTest {
    public static void main(String[] args) throws Exception {
        selector_matches_launch_pid();
        selector_matches_attach_port_not_threads();
        selector_filters_same_port_by_host();
        selector_reports_vm_not_found();
        connected_vms_missing_field_is_unsupported();
        request_timeout_raised_and_restored();
        handles_cleared_on_new_generation();
        handles_cleared_when_full();
        string_preview_rule();
    }

    /** Stands in for java-debug's provider: its manager has no {@code connectedVMs}. */
    public static final class FakeProvider {
        public Object getVirtualMachineManager() {
            return new Object();
        }
    }

    static void selector_matches_launch_pid() {
        List<VmInfo> vms = List.of(vm(10L, "127.0.0.1", 50001), vm(11L, "127.0.0.1", 50002));
        check(VmSelector.select(vms, launch(11)).orElseThrow() == vms.get(1), "pid 11 selects the second VM");
        pass("selector_matches_launch_pid");
    }

    static void selector_matches_attach_port_not_threads() {
        // G1: two JVMs running the same program have identical thread lists; only the port tells them apart.
        List<VmInfo> vms = List.of(vm(null, "127.0.0.1", 59246), vm(null, "127.0.0.1", 59247));
        check(VmSelector.select(vms, attach("127.0.0.1", 59247)).orElseThrow() == vms.get(1), "port 59247 selects the second VM");
        pass("selector_matches_attach_port_not_threads");
    }

    static void selector_filters_same_port_by_host() {
        List<VmInfo> vms = List.of(vm(null, "127.0.0.1", 5005), vm(null, "10.0.0.5", 5005));
        check(VmSelector.select(vms, attach("localhost", 5005)).orElseThrow() == vms.get(0), "localhost selects 127.0.0.1");
        pass("selector_filters_same_port_by_host");
    }

    static void selector_reports_vm_not_found() {
        List<VmInfo> distinct = List.of(vm(10L, "127.0.0.1", 5005), vm(null, "127.0.0.1", 5006));
        check(VmSelector.select(distinct, launch(12)).isEmpty(), "unknown pid");
        check(VmSelector.select(distinct, attach("127.0.0.1", 5007)).isEmpty(), "unknown port");
        check(VmSelector.select(distinct, new Target(null, null, null, 1)).isEmpty(), "no pid and no port");
        List<VmInfo> twins = List.of(vm(null, "127.0.0.1", 5005), vm(null, "127.0.0.1", 5005));
        check(VmSelector.select(twins, attach("localhost", 5005)).isEmpty(), "same port and host is ambiguous");
        pass("selector_reports_vm_not_found");
    }

    static void connected_vms_missing_field_is_unsupported() {
        try {
            ConnectedVms.read(name -> FakeProvider.class);
            throw new AssertionError("a manager without connectedVMs must be unsupported");
        } catch (ConnectedVms.Unsupported e) {
            check(e.getMessage().contains("connectedVMs"), "detail names the field: " + e.getMessage());
        }
        try {
            ConnectedVms.read(name -> null);
            throw new AssertionError("a missing java-debug must be unsupported");
        } catch (ConnectedVms.Unsupported e) {
            check(e.getMessage().contains(ConnectedVms.PROVIDER), "detail names the class: " + e.getMessage());
        }
        pass("connected_vms_missing_field_is_unsupported");
    }

    static void request_timeout_raised_and_restored() {
        int[] value = {3000};
        RequestTimeout.Knob knob = new RequestTimeout.Knob() {
            @Override
            public int get() {
                return value[0];
            }

            @Override
            public void set(int ms) {
                value[0] = ms;
            }
        };
        try (RequestTimeout.Raised raised = RequestTimeout.raise(knob, 60_000)) {
            check(value[0] == 60_000, "raised to 60000, was " + value[0]);
        }
        check(value[0] == 3000, "restored to 3000, was " + value[0]);
        try (RequestTimeout.Raised raised = RequestTimeout.raise(knob, 60_000)) {
            value[0] = 5000; // java-debug applied a changed setting meanwhile
        }
        check(value[0] == 5000, "a value changed meanwhile is kept, was " + value[0]);
        value[0] = 90_000;
        try (RequestTimeout.Raised raised = RequestTimeout.raise(knob, 60_000)) {
            check(value[0] == 90_000, "a larger timeout is not lowered, was " + value[0]);
        }
        check(value[0] == 90_000, "a larger timeout stays, was " + value[0]);
        pass("request_timeout_raised_and_restored");
    }

    static void handles_cleared_on_new_generation() throws Handles.Stale {
        Handles<String> handles = new Handles<>();
        handles.begin(1);
        handles.put(7, "seven");
        check("seven".equals(handles.get(7)), "id 7 is known in generation 1");
        handles.begin(2);
        expectStale(handles, 7, "id 7 from generation 1 in generation 2");
        pass("handles_cleared_on_new_generation");
    }

    static void handles_cleared_when_full() throws Handles.Stale {
        Handles<String> handles = new Handles<>();
        handles.begin(1);
        for (long id = 0; id <= Handles.MAX; id++) handles.put(id, "o");
        check("o".equals(handles.get(0)), "a command's own objects stay known while it runs");
        handles.begin(1);
        expectStale(handles, 0, "a table over the limit is cleared at the next command");
        pass("handles_cleared_when_full");
    }

    static void string_preview_rule() {
        Values.StringPreview shortText = Values.stringPreview(2000, 1, () -> "text");
        check(shortText.length() == 1000 && "text".equals(shortText.text()), "2000 UTF-16 bytes: 1000 chars, read: " + shortText);
        Values.StringPreview longText = Values.stringPreview(2002, 1, () -> {
            throw new AssertionError("the text of a long string must not be read");
        });
        check(longText.length() == 1001 && longText.text() == null, "2002 UTF-16 bytes: 1001 chars, not read: " + longText);
        Values.StringPreview latin1 = Values.stringPreview(1000, 0, () -> "latin");
        check(latin1.length() == 1000 && "latin".equals(latin1.text()), "Latin-1: one byte per char: " + latin1);
        Values.StringPreview jdk8 = Values.stringPreview(5, null, () -> "chars");
        check(jdk8.length() == 5 && "chars".equals(jdk8.text()), "no coder (JDK 8): one char per element: " + jdk8);
        pass("string_preview_rule");
    }

    private static VmInfo vm(Long pid, String host, Integer port) {
        return new VmInfo(null, pid, host, port, null);
    }

    private static Target launch(long pid) {
        return new Target(pid, null, null, 1);
    }

    private static Target attach(String host, int port) {
        return new Target(null, host, port, 1);
    }

    private static void expectStale(Handles<String> handles, long id, String what) {
        try {
            handles.get(id);
            throw new AssertionError(what + ": expected stale");
        } catch (Handles.Stale expected) {
            // the id belongs to an earlier table
        }
    }

    private static void check(boolean ok, String what) {
        if (!ok) throw new AssertionError(what);
    }

    private static void pass(String name) {
        System.out.println("PASS " + name);
    }
}
