package ai.openidea.junit;

import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.io.PrintStream;
import java.io.UnsupportedEncodingException;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.platform.engine.DiscoverySelector;
import org.junit.platform.engine.TestExecutionResult;
import org.junit.platform.engine.TestSource;
import org.junit.platform.engine.discovery.DiscoverySelectors;
import org.junit.platform.engine.support.descriptor.ClassSource;
import org.junit.platform.engine.support.descriptor.MethodSource;
import org.junit.platform.launcher.Launcher;
import org.junit.platform.launcher.TestExecutionListener;
import org.junit.platform.launcher.TestIdentifier;
import org.junit.platform.launcher.TestPlan;
import org.junit.platform.launcher.core.LauncherDiscoveryRequestBuilder;
import org.junit.platform.launcher.core.LauncherFactory;

/**
 * Runs JUnit Platform tests (Jupiter, and JUnit 4 through the Vintage engine when it is on the classpath).
 * A thread's stdout and stderr while it runs a test (or a class's set-up) are reported with it, line by
 * line; any other output is printed as is.
 */
final class PlatformRunner implements TestExecutionListener {
    private final Reporter report;
    private final Map<String, Long> started = new HashMap<>();
    /** The tests and classes each thread is running, innermost first: its output belongs to the first. */
    private final ThreadLocal<Deque<String>> owners = ThreadLocal.withInitial(ArrayDeque::new);
    private final List<Output> outputs = new ArrayList<>();
    private TestPlan plan;

    private PlatformRunner(Reporter report) {
        this.report = report;
    }

    static void run(Reporter report, String[] args) throws UnsupportedEncodingException {
        List<DiscoverySelector> selectors = new ArrayList<>();
        for (String arg : args) selectors.addAll(selectors(arg));
        Launcher launcher = LauncherFactory.create();
        PlatformRunner listener = new PlatformRunner(report);
        PrintStream stdout = System.out;
        PrintStream stderr = System.err;
        System.setOut(new PrintStream(listener.new Output("testStdOut", null), true, "UTF-8"));
        System.setErr(new PrintStream(listener.new Output("testStdErr", stderr), true, "UTF-8"));
        try {
            // JUnit's own capture also writes everything to the original stream: each line would show twice.
            launcher.execute(
                    LauncherDiscoveryRequestBuilder.request()
                            .selectors(selectors)
                            .configurationParameter("junit.platform.output.capture.stdout", "false")
                            .configurationParameter("junit.platform.output.capture.stderr", "false")
                            .build(),
                    listener);
        } finally {
            System.out.flush();
            System.err.flush();
            System.setOut(stdout);
            System.setErr(stderr);
        }
    }

    /** Every method named {@code method} (parameterized ones too); the class when there is none. */
    static List<DiscoverySelector> selectors(String arg) {
        int hash = arg.indexOf('#');
        List<DiscoverySelector> out = new ArrayList<>();
        if (hash < 0) {
            out.add(DiscoverySelectors.selectClass(arg));
            return out;
        }
        String className = arg.substring(0, hash);
        String name = arg.substring(hash + 1);
        try {
            Class<?> type = Class.forName(className, false, Thread.currentThread().getContextClassLoader());
            for (Class<?> c = type; c != null && c != Object.class; c = c.getSuperclass()) {
                for (Method m : c.getDeclaredMethods()) {
                    if (m.getName().equals(name) && !m.isSynthetic()) out.add(DiscoverySelectors.selectMethod(type, m));
                }
                if (!out.isEmpty()) break;
            }
        } catch (ClassNotFoundException | LinkageError e) {
            // Discovery reports the missing class.
        }
        if (out.isEmpty()) out.add(DiscoverySelectors.selectClass(className));
        return out;
    }

    @Override
    public void testPlanExecutionStarted(TestPlan testPlan) {
        plan = testPlan;
    }

    @Override
    public void executionStarted(TestIdentifier id) {
        String owner = owner(id);
        if (owner != null) {
            flushOutput();
            owners.get().push(owner);
        }
        if (!id.isTest()) return;
        started.put(id.getUniqueId(), System.currentTimeMillis());
        report.message("testStarted", id(id));
    }

    @Override
    public void executionSkipped(TestIdentifier id, String reason) {
        List<TestIdentifier> skippedTests = new ArrayList<>();
        if (id.isTest()) skippedTests.add(id);
        else for (TestIdentifier d : plan.getDescendants(id)) if (d.isTest()) skippedTests.add(d);
        for (TestIdentifier test : skippedTests) report.ignored(id(test), reason);
    }

    @Override
    public void executionFinished(TestIdentifier id, TestExecutionResult result) {
        if (owner(id) != null) {
            flushOutput();
            owners.get().pop();
        }
        TestExecutionResult.Status status = result.getStatus();
        if (!id.isTest()) {
            // A class whose set-up failed (`@BeforeAll`): reported as a test, like JUnit 4's initializationError.
            Optional<String> className = className(id);
            if (status != TestExecutionResult.Status.FAILED || !className.isPresent()) return;
            String own = Reporter.attr("name", "initializationError") + Reporter.attr("className", className.get());
            report.message("testStarted", own);
            report.failed(own, result.getThrowable().orElse(null));
            report.finished(own, 0);
            return;
        }
        String own = id(id);
        if (status == TestExecutionResult.Status.FAILED) report.failed(own, result.getThrowable().orElse(null));
        else if (status == TestExecutionResult.Status.ABORTED) report.skipped(own, null);
        Long start = started.remove(id.getUniqueId());
        report.finished(own, start == null ? 0 : System.currentTimeMillis() - start);
    }

    /** Whose output a thread's is while it runs {@code id}: the test, or a class (`@BeforeAll`, `@AfterAll`) with no test name. */
    private String owner(TestIdentifier id) {
        return id.isTest() ? id(id) : className(id).map(c -> Reporter.attr("className", c)).orElse(null);
    }

    private void flushOutput() {
        for (Output o : outputs) o.flushLines(true);
    }

    /** `name='method' className='a.B$Nested'`, the method and class of the test or its closest source. */
    private String id(TestIdentifier id) {
        for (TestIdentifier at = id; at != null; at = plan.getParent(at).orElse(null)) {
            TestSource source = at.getSource().orElse(null);
            if (source instanceof MethodSource) {
                MethodSource m = (MethodSource) source;
                return Reporter.attr("name", m.getMethodName()) + Reporter.attr("className", m.getClassName());
            }
            if (source instanceof ClassSource)
                return Reporter.attr("name", id.getLegacyReportingName()) + Reporter.attr("className", ((ClassSource) source).getClassName());
        }
        return Reporter.attr("name", id.getLegacyReportingName()) + Reporter.attr("className", id.getDisplayName());
    }

    private Optional<String> className(TestIdentifier id) {
        TestSource source = id.getSource().orElse(null);
        return source instanceof ClassSource ? Optional.of(((ClassSource) source).getClassName()) : Optional.empty();
    }

    /** System.out or System.err: reported with the thread's test, else passed through ({@code null}: the reporter's stdout). */
    private final class Output extends OutputStream {
        private final String kind;
        private final PrintStream passThrough;
        private final ThreadLocal<ByteArrayOutputStream> pending = ThreadLocal.withInitial(ByteArrayOutputStream::new);

        Output(String kind, PrintStream passThrough) {
            this.kind = kind;
            this.passThrough = passThrough;
            outputs.add(this);
        }

        @Override
        public void write(int b) {
            write(new byte[] {(byte) b}, 0, 1);
        }

        @Override
        public void write(byte[] b, int off, int len) {
            if (owners.get().isEmpty()) {
                if (passThrough == null) report.write(b, off, len);
                else {
                    passThrough.write(b, off, len);
                    passThrough.flush();
                }
                return;
            }
            pending.get().write(b, off, len);
            for (int i = off; i < off + len; i++) {
                if (b[i] == '\n') {
                    flushLines(false);
                    return;
                }
            }
        }

        /** The thread's complete lines, or with {@code all} its partial line too, as a message of its test. */
        void flushLines(boolean all) {
            String owner = owners.get().peek();
            ByteArrayOutputStream buffer = pending.get();
            if (owner == null || buffer.size() == 0) return;
            byte[] bytes = buffer.toByteArray();
            int end = bytes.length;
            if (!all) while (end > 0 && bytes[end - 1] != '\n') end--;
            if (end == 0) return;
            buffer.reset();
            buffer.write(bytes, end, bytes.length - end);
            report.message(kind, owner + Reporter.attr("out", new String(bytes, 0, end, StandardCharsets.UTF_8)));
        }
    }
}
