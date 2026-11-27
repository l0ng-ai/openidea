package ai.openidea.jvminspect;

import ai.openidea.jvminspect.VmSelector.Target;
import ai.openidea.jvminspect.VmSelector.VmInfo;
import com.sun.jdi.ObjectCollectedException;
import com.sun.jdi.ObjectReference;
import com.sun.jdi.VMDisconnectedException;
import com.sun.jdi.request.BreakpointRequest;
import com.sun.jdi.request.EventRequest;
import com.sun.jdi.request.ExceptionRequest;
import java.io.ByteArrayInputStream;
import java.io.DataInputStream;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;
import java.util.function.DoubleConsumer;
import java.util.function.IntConsumer;
import java.util.function.LongConsumer;

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
        silencer_switches_off_only_enabled_foreign_requests();
        silencer_skips_requests_java_debug_deleted();
        silencer_restore_fails_loudly_unless_disconnected();
        chain_start_by_javac_and_ecj_line_tables();
        pin_retries_only_a_call_that_did_not_run();
        recorder_resource_is_a_java_8_class();
        recorder_counts_past_the_budget_and_never_throws();
        plan_parsed_from_gson_json();
        sessions_found_by_vm();
        sessions_missing_field_is_unsupported();
        hub_listener_parks_and_failures_are_swallowed();
        exception_spec_parsed_from_gson_json();
        exception_flags_leave_out_what_another_request_reports();
        exception_request_with_class_filters_covers_no_whole_type();
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

    static void silencer_switches_off_only_enabled_foreign_requests() {
        EventRequest breakpoint = request(BreakpointRequest.class, true, false);
        EventRequest exception = request(ExceptionRequest.class, true, false);
        EventRequest disabled = request(BreakpointRequest.class, false, false);
        EventRequest own = request(BreakpointRequest.class, true, true);
        List<EventRequest> requests = List.of(breakpoint, exception, disabled, own);
        Silencer silencer = Silencer.silence(() -> requests);
        check(!breakpoint.isEnabled() && !exception.isEnabled(), "enabled foreign requests are switched off");
        check(own.isEnabled(), "a request marked \"oi\" is left alone");
        check(silencer.size() == 2 && silencer.silencedBreakpoints() == 1, "2 silenced, 1 of them a breakpoint: " + silencer.size());
        check(silencer.restore() == 0, "nothing fails to restore");
        check(breakpoint.isEnabled() && exception.isEnabled(), "the silenced requests are on again");
        check(!disabled.isEnabled(), "a request that was off stays off");
        check(silencer.restore() == 0 && silencer.size() == 0, "a second restore does nothing");
        pass("silencer_switches_off_only_enabled_foreign_requests");
    }

    static void silencer_skips_requests_java_debug_deleted() {
        // As Eclipse JDI does it: a deleted request is only gone from the manager's lists, and enable() still works on it.
        EventRequest deleted = request(BreakpointRequest.class, true, false);
        EventRequest kept = request(BreakpointRequest.class, true, false);
        List<EventRequest> requests = new ArrayList<>(List.of(deleted, kept));
        Silencer silencer = Silencer.silence(() -> List.copyOf(requests));
        requests.remove(deleted);
        requests.add(request(BreakpointRequest.class, true, false)); // java-debug's replacement
        check(silencer.restore() == 1, "the deleted request counts as one restore failure");
        check(!deleted.isEnabled(), "a deleted request is not switched back on");
        check(kept.isEnabled(), "the request after the deleted one is still restored");
        pass("silencer_skips_requests_java_debug_deleted");
    }

    static void pin_retries_only_a_call_that_did_not_run() throws Exception {
        int[] calls = {0};
        ObjectReference pinned = object(false);
        ObjectReference got = RecorderLoader.pin(() -> {
            if (++calls[0] == 1) throw new ObjectCollectedException("an argument");
            return pinned;
        });
        check(got == pinned && calls[0] == 2, "a call refused for a collected argument is made again");

        calls[0] = 0;
        try {
            RecorderLoader.pin(() -> {
                calls[0]++;
                return object(true);
            });
            throw new AssertionError("an object collected after the call must not pass for pinned");
        } catch (ObjectCollectedException expected) {
            check(calls[0] == 1, "a call that ran is not made a second time");
        }
        pass("pin_retries_only_a_call_that_did_not_run");
    }

    /** An {@link ObjectReference} whose {@code disableCollection} throws when {@code collected}. */
    private static ObjectReference object(boolean collected) {
        return (ObjectReference) Proxy.newProxyInstance(SelfTest.class.getClassLoader(), new Class<?>[] {ObjectReference.class},
                (proxy, method, args) -> switch (method.getName()) {
                    case "disableCollection" -> {
                        if (collected) throw new ObjectCollectedException();
                        yield null;
                    }
                    case "hashCode" -> System.identityHashCode(proxy);
                    case "equals" -> proxy == args[0];
                    case "toString" -> "object";
                    default -> throw new UnsupportedOperationException(method.getName());
                });
    }

    static void silencer_restore_fails_loudly_unless_disconnected() {
        EventRequest breakpoint = request(BreakpointRequest.class, true, false);
        RuntimeException[] listing = {null};
        Silencer silencer = Silencer.silence(() -> {
            if (listing[0] != null) throw listing[0];
            return List.of(breakpoint);
        });
        listing[0] = new IllegalStateException("listing broke");
        try {
            silencer.restore();
            throw new AssertionError("an unexpected listing failure must not pass for \"nothing left\"");
        } catch (IllegalStateException expected) {
            check(silencer.size() == 1, "the request stays silenced for a later restore");
        }
        listing[0] = null;
        check(silencer.restore() == 0 && breakpoint.isEnabled(), "a later restore switches it back on");

        EventRequest other = request(BreakpointRequest.class, true, false);
        Silencer gone = Silencer.silence(() -> {
            if (listing[0] != null) throw listing[0];
            return List.of(other);
        });
        listing[0] = new VMDisconnectedException();
        check(gone.restore() == 1 && gone.size() == 0, "a disconnected VM: every silenced request counts as not restored");
        pass("silencer_restore_fails_loudly_unless_disconnected");
    }

    static void chain_start_by_javac_and_ecj_line_tables() {
        // Measured line tables (1-based line, start pc) of one method holding
        //   9  List<String> out =        10  nums.stream() ... 12  .collect(...);
        //   14 n =                       15  nums.stream().count();
        //   18 System.out.println(       19  nums.stream().count());
        //   20 List<String> one = nums.stream().map(String::valueOf).collect(...);
        List<RealRunTrace.LineEntry> javac = table(9, 0, 10, 3, 11, 13, 12, 18, 14, 30, 15, 33, 16, 44, 17, 47, 18, 60, 19, 66, 18, 76,
                20, 79, 21, 109);
        List<RealRunTrace.LineEntry> ecj = table(10, 0, 11, 8, 12, 18, 15, 30, 14, 43, 17, 44, 16, 57, 18, 60, 19, 63, 18, 76, 20, 79,
                21, 109);
        check(RealRunTrace.atChainStart(entry(9, 0), 8, javac), "javac: the declaration head holds the first instruction");
        check(!RealRunTrace.atChainStart(entry(10, 3), 8, javac), "javac: the receiver was loaded on the head line already");
        check(RealRunTrace.atChainStart(entry(10, 0), 8, ecj), "ECJ: no code on the head line, the first instruction is on the next");
        check(RealRunTrace.atChainStart(entry(14, 30), 13, javac), "javac: an assignment head starts the statement");
        check(!RealRunTrace.atChainStart(entry(14, 43), 13, ecj), "ECJ: the assignment head's only code runs after the chain");
        check(RealRunTrace.atChainStart(entry(18, 60), 17, javac) && RealRunTrace.atChainStart(entry(18, 60), 17, ecj),
                "a call head starts the statement for both");
        check(!RealRunTrace.atChainStart(entry(20, 85), 19, javac), "mid-line, after the first call returned");
        check(!RealRunTrace.atChainStart(entry(18, 60), 19, javac), "a stop before the statement's first line");
        check(!RealRunTrace.atChainStart(entry(21, 109), 19, javac), "a stop after the statement ran");
        pass("chain_start_by_javac_and_ecj_line_tables");
    }

    static void recorder_resource_is_a_java_8_class() throws Exception {
        byte[] bytes = RecorderLoader.bytes();
        DataInputStream in = new DataInputStream(new ByteArrayInputStream(bytes));
        check(in.readInt() == 0xCAFEBABE, "class file magic");
        in.readUnsignedShort();
        check(in.readUnsignedShort() == 52, "major version 52 (Java 8)");
        pass("recorder_resource_is_a_java_8_class");
    }

    @SuppressWarnings("unchecked")
    static void recorder_counts_past_the_budget_and_never_throws() throws Exception {
        byte[] bytes = RecorderLoader.bytes();
        Class<?> type = new ClassLoader(null) {
            Class<?> define() {
                return defineClass(RecorderLoader.CLASS_NAME, bytes, 0, bytes.length);
            }
        }.define();
        Object log = type.getConstructor(int.class).newInstance(3);
        Object step = type.getConstructor(type, int.class).newInstance(log, 1);
        ((Consumer<Object>) step).accept("a");
        ((IntConsumer) step).accept(7);
        ((LongConsumer) step).accept(8L);
        ((DoubleConsumer) step).accept(9.5);
        check(field(log, "size").equals(3) && field(log, "dropped").equals(1L), "budget 3: 3 kept, 1 dropped");
        Object[] values = (Object[]) field(log, "values");
        int[] steps = (int[]) field(log, "steps");
        check(List.of(values[0], values[1], values[2]).equals(List.of("a", 7, 8L)), "primitives are boxed: " + List.of(values));
        check(steps[0] == 1 && steps[1] == 1 && steps[2] == 1, "every record carries its step");

        Object big = type.getConstructor(int.class).newInstance(1000);
        Object bigStep = type.getConstructor(type, int.class).newInstance(big, 0);
        for (int i = 0; i < 600; i++) ((IntConsumer) bigStep).accept(i);
        check(field(big, "size").equals(600) && field(big, "dropped").equals(0L), "the log grows past its first capacity");
        type.getField("budget").setInt(big, 0); // "stop recording" lowers the budget below the size
        ((IntConsumer) bigStep).accept(1);
        check(field(big, "size").equals(600) && field(big, "dropped").equals(1L), "a budget below the size drops");
        ((Consumer<Object>) big).accept("on the log itself");
        check(field(big, "dropped").equals(2L), "the log accepting a value does not throw");
        // An endless stream drops 2^31 values in about 11 s.
        type.getField("dropped").setLong(big, Integer.MAX_VALUE);
        ((IntConsumer) bigStep).accept(2);
        check(field(big, "dropped").equals(Integer.MAX_VALUE + 1L), "dropped counts past Integer.MAX_VALUE: " + field(big, "dropped"));
        pass("recorder_counts_past_the_budget_and_never_throws");
    }

    static void plan_parsed_from_gson_json() {
        // Gson hands executeCommand arguments over as maps, lists, strings, booleans and doubles.
        Map<String, Object> json = new LinkedHashMap<>();
        json.put("root", Map.of("name", "stream", "args", 0.0, "skip", 1.0));
        json.put("local", null);
        json.put("steps", List.of(Map.of("name", "filter", "args", 1.0, "skip", 0.0), Map.of("name", "map", "args", 1.0, "skip", 0.0)));
        json.put("terminal", Map.of("name", "collect", "args", 1.0, "skip", 0.0));
        json.put("classFilters", List.of("java.util.stream.*", "java.util.Collection"));
        json.put("stepKinds", List.of("sync", "sync"));
        json.put("sequentialize", false);
        json.put("firstLine", 19.0);
        json.put("lastLine", 23.0);
        RealRunPlan plan = RealRunPlan.of(json);
        check(plan.root().equals(new RealRunPlan.StepSpec("stream", 0, 1)) && plan.local() == null, "root: " + plan.root());
        check(plan.steps().equals(List.of(new RealRunPlan.StepSpec("filter", 1, 0), new RealRunPlan.StepSpec("map", 1, 0))), "steps");
        check(plan.terminal().name().equals("collect") && plan.terminal().args() == 1, "terminal: " + plan.terminal());
        check(plan.classFilters().size() == 2 && plan.stepKinds().equals(List.of("sync", "sync")), "filters and kinds");
        check(!plan.sequentialize() && plan.firstLine() == 19 && plan.lastLine() == 23, "sequentialize and lines: " + plan);
        json.remove("terminal");
        try {
            RealRunPlan.of(json);
            throw new AssertionError("a plan without a terminal must be rejected");
        } catch (IllegalArgumentException e) {
            check(e.getMessage().contains("terminal"), "detail names the member: " + e.getMessage());
        }
        pass("plan_parsed_from_gson_json");
    }

    static void exception_spec_parsed_from_gson_json() {
        Map<String, Object> json = new LinkedHashMap<>();
        json.put("id", "b1");
        json.put("className", "java.lang.IllegalStateException");
        json.put("caught", true);
        json.put("uncaught", false);
        json.put("enabled", true);
        json.put("classFilters", List.of("com.acme.*"));
        ExceptionBreakpoints.Spec spec = ExceptionBreakpoints.Spec.of(json);
        check(spec.id().equals("b1") && spec.className().equals("java.lang.IllegalStateException"), "id and class: " + spec);
        check(spec.caught() && !spec.uncaught() && spec.enabled(), "flags: " + spec);
        check(spec.classFilters().equals(List.of("com.acme.*")) && spec.classExclusionFilters().isEmpty(), "filters: " + spec);
        check(spec.hasClassFilters(), "a spec with an include pattern has class filters");
        json.remove("className");
        try {
            ExceptionBreakpoints.Spec.of(json);
            throw new AssertionError("a spec without a class must be rejected");
        } catch (IllegalArgumentException e) {
            check(e.getMessage().contains("className"), "detail names the member: " + e.getMessage());
        }
        pass("exception_spec_parsed_from_gson_json");
    }

    static void exception_flags_leave_out_what_another_request_reports() {
        ExceptionBreakpoints.Spec ise = spec("ise", "java.lang.IllegalStateException", true, true, true, List.of());
        List<String> iseSupers = List.of("java.lang.RuntimeException", "java.lang.Exception", "java.lang.Throwable", "java.lang.Object");
        ExceptionBreakpoints.Flags all = ExceptionBreakpoints.uncovered(ise, iseSupers, false, false, List.of(ise));
        check(all.caught() && all.uncaught(), "nothing else reports it: both flags stay: " + all);
        ExceptionBreakpoints.Flags anyCaught = ExceptionBreakpoints.uncovered(ise, iseSupers, true, false, List.of(ise));
        check(!anyCaught.caught() && anyCaught.uncaught(), "java-debug's caught filter reports every caught throw: " + anyCaught);
        check(ExceptionBreakpoints.uncovered(ise, iseSupers, true, true, List.of(ise)).none(), "both java-debug filters: no request");
        ExceptionBreakpoints.Spec runtime = spec("rte", "java.lang.RuntimeException", true, false, true, List.of());
        ExceptionBreakpoints.Flags bySuper = ExceptionBreakpoints.uncovered(ise, iseSupers, false, false, List.of(runtime, ise));
        check(!bySuper.caught() && bySuper.uncaught(), "a breakpoint on a superclass reports the caught throws: " + bySuper);
        ExceptionBreakpoints.Spec filtered = spec("f", "java.lang.RuntimeException", true, true, true, List.of("com.acme.*"));
        ExceptionBreakpoints.Spec off = spec("off", "java.lang.RuntimeException", true, true, false, List.of());
        ExceptionBreakpoints.Flags narrow = ExceptionBreakpoints.uncovered(ise, iseSupers, false, false, List.of(filtered, off, ise));
        check(narrow.caught() && narrow.uncaught(), "a filtered or disabled superclass breakpoint covers nothing: " + narrow);
        ExceptionBreakpoints.Spec twin = spec("twin", "java.lang.IllegalStateException", true, true, true, List.of());
        check(ExceptionBreakpoints.uncovered(twin, iseSupers, false, false, List.of(ise, twin)).none(), "the later of two equal breakpoints adds nothing");
        ExceptionBreakpoints.Flags first = ExceptionBreakpoints.uncovered(ise, iseSupers, false, false, List.of(ise, twin));
        check(first.caught() && first.uncaught(), "the earlier of two equal breakpoints keeps its flags: " + first);
        ExceptionBreakpoints.Spec filteredIse = spec("fi", "java.lang.IllegalStateException", true, true, true, List.of("com.acme.*"));
        check(ExceptionBreakpoints.uncovered(filteredIse, iseSupers, false, false, List.of(filteredIse, twin)).none(),
                "an unfiltered breakpoint on the same class covers a filtered one before it");
        pass("exception_flags_leave_out_what_another_request_reports");
    }

    static void exception_request_with_class_filters_covers_no_whole_type() {
        EventRequest plain = request(ExceptionRequest.class, true, false);
        plain.putProperty(ExceptionBreakpoints.PROPERTY, spec("a", "java.lang.RuntimeException", true, true, true, List.of()));
        EventRequest filtered = request(ExceptionRequest.class, true, false);
        filtered.putProperty(ExceptionBreakpoints.PROPERTY, spec("b", "java.lang.RuntimeException", true, true, true, List.of("com.acme.*")));
        EventRequest javaDebugs = request(ExceptionRequest.class, true, false);
        check(ExceptionBreakpoints.coversWholeType(plain), "an exception breakpoint without filters covers its type");
        check(!ExceptionBreakpoints.coversWholeType(filtered), "one with class filters may miss a throw");
        check(ExceptionBreakpoints.coversWholeType(javaDebugs), "java-debug's own requests have no filters the app sets");
        pass("exception_request_with_class_filters_covers_no_whole_type");
    }

    private static ExceptionBreakpoints.Spec spec(String id, String type, boolean caught, boolean uncaught, boolean enabled, List<String> include) {
        return new ExceptionBreakpoints.Spec(id, type, caught, uncaught, enabled, include, List.of());
    }

    static void sessions_found_by_vm() throws Exception {
        Object vmA = new Object();
        Object vmB = new Object();
        FakeWorkspace workspace = workspace(new FakeSession(vmA), null, new FakeSession(vmB));
        JavaDebugSessions.Hub hub = JavaDebugSessions.find(workspace, vmB, SelfTest::fakeJavaDebug).orElseThrow();
        check(hub != null, "the session of vm B is found");
        check(JavaDebugSessions.find(workspace, new Object(), SelfTest::fakeJavaDebug).isEmpty(), "no session for another VM");
        pass("sessions_found_by_vm");
    }

    static void sessions_missing_field_is_unsupported() {
        try {
            JavaDebugSessions.find(new Object(), new Object(), SelfTest::fakeJavaDebug);
            throw new AssertionError("a workspace without notificationManager must be unsupported");
        } catch (ConnectedVms.Unsupported e) {
            check(e.getMessage().contains("notificationManager"), "detail names the field: " + e.getMessage());
        }
        try {
            JavaDebugSessions.find(workspace(new FakeSession(new Object())), new Object(), name -> null);
            throw new AssertionError("a missing java-debug must be unsupported");
        } catch (ConnectedVms.Unsupported e) {
            check(e.getMessage().contains(JavaDebugSessions.HCR_PROVIDER), "detail names the class: " + e.getMessage());
        }
        pass("sessions_missing_field_is_unsupported");
    }

    static void hub_listener_parks_and_failures_are_swallowed() throws Exception {
        Object vm = new Object();
        FakeSession session = new FakeSession(vm);
        JavaDebugSessions.Hub hub = JavaDebugSessions.find(workspace(session), vm, SelfTest::fakeJavaDebug).orElseThrow();
        List<Throwable> failures = new ArrayList<>();
        int[] seen = {0};
        JavaDebugSessions.Subscription subscription = hub.subscribe(e -> {
            seen[0]++;
            if (seen[0] == 2) throw new IllegalStateException("listener bug");
            e.park();
        }, failures::add);
        FakeObservable events = session.hub.events;
        FakeDebugEvent first = new FakeDebugEvent();
        events.next.accept(first);
        check(!first.shouldResume, "park() keeps java-debug from resuming the event set");
        events.next.accept(new FakeDebugEvent()); // must not throw: RxJava would drop the subscription
        check(failures.size() == 1 && failures.get(0).getMessage().equals("listener bug"), "a listener failure is reported: " + failures);
        events.error.accept(new RuntimeException("hub failed"));
        check(failures.size() == 2, "a hub error is reported: " + failures);
        subscription.close();
        check(events.disposed, "closing disposes the subscription");
        pass("hub_listener_parks_and_failures_are_swallowed");
    }

    /** Stand-ins for java-debug and RxJava, found by {@link #fakeJavaDebug} under their real names. */
    public interface FakeConsumer {
        void accept(Object value) throws Exception;
    }

    public interface FakeDisposable {
        void dispose();
    }

    public static final class FakeObservable {
        FakeConsumer next;
        FakeConsumer error;
        boolean disposed;

        public FakeDisposable subscribe(FakeConsumer next, FakeConsumer error) {
            this.next = next;
            this.error = error;
            return () -> disposed = true;
        }
    }

    public interface FakeEventHubApi {
        FakeObservable events();
    }

    public static final class FakeEventHub implements FakeEventHubApi {
        final FakeObservable events = new FakeObservable();

        @Override
        public FakeObservable events() {
            return events;
        }
    }

    public interface FakeSessionApi {
        Object getVM();

        FakeEventHubApi getEventHub();
    }

    public static final class FakeSession implements FakeSessionApi {
        final Object vm;
        final FakeEventHub hub = new FakeEventHub();

        FakeSession(Object vm) {
            this.vm = vm;
        }

        @Override
        public Object getVM() {
            return vm;
        }

        @Override
        public FakeEventHubApi getEventHub() {
            return hub;
        }
    }

    public static final class FakeDebugEvent {
        public Object event;
        public Object eventSet;
        public boolean shouldResume = true;
    }

    static final class FakeHcrProvider {
        final Object currentDebugSession;

        FakeHcrProvider(Object session) {
            this.currentDebugSession = session;
        }
    }

    static final class FakeEntry {
        final Object listener;

        FakeEntry(Object listener) {
            this.listener = listener;
        }
    }

    static final class FakeListenerList {
        final CopyOnWriteArrayList<FakeEntry> listeners = new CopyOnWriteArrayList<>();
    }

    static final class FakeNotifications {
        final FakeListenerList listeners = new FakeListenerList();
    }

    static final class FakeWorkspace {
        final FakeNotifications notificationManager = new FakeNotifications();
    }

    /** A workspace whose listeners are one unrelated listener and one HCR provider per session (null: a provider with no session). */
    private static FakeWorkspace workspace(FakeSession... sessions) {
        FakeWorkspace workspace = new FakeWorkspace();
        workspace.notificationManager.listeners.listeners.add(new FakeEntry(new Object()));
        for (FakeSession s : sessions) workspace.notificationManager.listeners.listeners.add(new FakeEntry(new FakeHcrProvider(s)));
        return workspace;
    }

    private static Class<?> fakeJavaDebug(String name) {
        return switch (name) {
            case JavaDebugSessions.HCR_PROVIDER -> FakeHcrProvider.class;
            case JavaDebugSessions.SESSION -> FakeSessionApi.class;
            case JavaDebugSessions.EVENT_HUB -> FakeEventHubApi.class;
            case JavaDebugSessions.OBSERVABLE -> FakeObservable.class;
            case JavaDebugSessions.CONSUMER -> FakeConsumer.class;
            case JavaDebugSessions.DISPOSABLE -> FakeDisposable.class;
            default -> null;
        };
    }

    /** An {@link EventRequest} of {@code type} that only knows enabling and properties. */
    private static EventRequest request(Class<? extends EventRequest> type, boolean enabled, boolean own) {
        boolean[] on = {enabled};
        Map<Object, Object> properties = new HashMap<>();
        if (own) properties.put(Silencer.OWN_PROPERTY, 1L);
        return (EventRequest) Proxy.newProxyInstance(SelfTest.class.getClassLoader(), new Class<?>[] {type}, (proxy, method, args) -> {
            switch (method.getName()) {
                case "isEnabled":
                    return on[0];
                case "enable":
                case "disable":
                case "setEnabled":
                    on[0] = method.getName().equals("enable") || (method.getName().equals("setEnabled") && (Boolean) args[0]);
                    return null;
                case "getProperty":
                    return properties.get(args[0]);
                case "putProperty":
                    properties.put(args[0], args[1]);
                    return null;
                case "hashCode":
                    return System.identityHashCode(proxy);
                case "equals":
                    return proxy == args[0];
                case "toString":
                    return type.getSimpleName() + (on[0] ? " on" : " off");
                default:
                    throw new UnsupportedOperationException(method.getName());
            }
        });
    }

    /** Pairs of (1-based line, start pc). */
    private static List<RealRunTrace.LineEntry> table(int... linesAndPcs) {
        List<RealRunTrace.LineEntry> out = new ArrayList<>();
        for (int i = 0; i < linesAndPcs.length; i += 2) out.add(entry(linesAndPcs[i], linesAndPcs[i + 1]));
        return out;
    }

    private static RealRunTrace.LineEntry entry(int line, long codeIndex) {
        return new RealRunTrace.LineEntry(line, codeIndex);
    }

    private static Object field(Object object, String name) throws ReflectiveOperationException {
        return object.getClass().getField(name).get(object);
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
