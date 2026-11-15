package ai.openidea.jvminspect;

import ai.openidea.jvminspect.VmSelector.Target;
import ai.openidea.jvminspect.VmSelector.VmInfo;
import com.sun.jdi.request.BreakpointRequest;
import com.sun.jdi.request.EventRequest;
import com.sun.jdi.request.ExceptionRequest;
import com.sun.jdi.request.InvalidRequestStateException;
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
        recorder_resource_is_a_java_8_class();
        recorder_counts_past_the_budget_and_never_throws();
        plan_parsed_from_gson_json();
        sessions_found_by_vm();
        sessions_missing_field_is_unsupported();
        hub_listener_parks_and_failures_are_swallowed();
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
        EventRequest breakpoint = request(BreakpointRequest.class, true, false, false);
        EventRequest exception = request(ExceptionRequest.class, true, false, false);
        EventRequest disabled = request(BreakpointRequest.class, false, false, false);
        EventRequest own = request(BreakpointRequest.class, true, true, false);
        Silencer silencer = Silencer.silence(List.of(breakpoint, exception, disabled, own));
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
        EventRequest deleted = request(BreakpointRequest.class, true, false, true);
        EventRequest kept = request(BreakpointRequest.class, true, false, false);
        Silencer silencer = Silencer.silence(List.of(deleted, kept));
        check(silencer.restore() == 1, "the deleted request counts as one restore failure");
        check(kept.isEnabled(), "the request after the deleted one is still restored");
        pass("silencer_skips_requests_java_debug_deleted");
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
        check(field(log, "size").equals(3) && field(log, "dropped").equals(1), "budget 3: 3 kept, 1 dropped");
        Object[] values = (Object[]) field(log, "values");
        int[] steps = (int[]) field(log, "steps");
        check(List.of(values[0], values[1], values[2]).equals(List.of("a", 7, 8L)), "primitives are boxed: " + List.of(values));
        check(steps[0] == 1 && steps[1] == 1 && steps[2] == 1, "every record carries its step");

        Object big = type.getConstructor(int.class).newInstance(1000);
        Object bigStep = type.getConstructor(type, int.class).newInstance(big, 0);
        for (int i = 0; i < 600; i++) ((IntConsumer) bigStep).accept(i);
        check(field(big, "size").equals(600) && field(big, "dropped").equals(0), "the log grows past its first capacity");
        type.getField("budget").setInt(big, 0); // "stop recording" lowers the budget below the size
        ((IntConsumer) bigStep).accept(1);
        check(field(big, "size").equals(600) && field(big, "dropped").equals(1), "a budget below the size drops");
        ((Consumer<Object>) big).accept("on the log itself");
        check(field(big, "dropped").equals(2), "the log accepting a value does not throw");
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
        RealRunPlan plan = RealRunPlan.of(json);
        check(plan.root().equals(new RealRunPlan.StepSpec("stream", 0, 1)) && plan.local() == null, "root: " + plan.root());
        check(plan.steps().equals(List.of(new RealRunPlan.StepSpec("filter", 1, 0), new RealRunPlan.StepSpec("map", 1, 0))), "steps");
        check(plan.terminal().name().equals("collect") && plan.terminal().args() == 1, "terminal: " + plan.terminal());
        check(plan.classFilters().size() == 2 && plan.stepKinds().equals(List.of("sync", "sync")), "filters and kinds");
        check(!plan.sequentialize() && plan.firstLine() == 19, "sequentialize and firstLine: " + plan);
        json.remove("terminal");
        try {
            RealRunPlan.of(json);
            throw new AssertionError("a plan without a terminal must be rejected");
        } catch (IllegalArgumentException e) {
            check(e.getMessage().contains("terminal"), "detail names the member: " + e.getMessage());
        }
        pass("plan_parsed_from_gson_json");
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

    /** An {@link EventRequest} of {@code type} that only knows enabling and properties; a deleted one refuses {@code enable}. */
    private static EventRequest request(Class<? extends EventRequest> type, boolean enabled, boolean own, boolean deleted) {
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
                    boolean value = method.getName().equals("enable") || (method.getName().equals("setEnabled") && (Boolean) args[0]);
                    if (value && deleted) throw new InvalidRequestStateException("deleted");
                    on[0] = value;
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
