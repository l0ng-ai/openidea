package ai.openidea.junit;

import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.PrintStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.io.UnsupportedEncodingException;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.platform.engine.DiscoverySelector;
import org.junit.platform.engine.TestExecutionResult;
import org.junit.platform.engine.TestSource;
import org.junit.platform.engine.discovery.DiscoverySelectors;
import org.junit.platform.engine.reporting.ReportEntry;
import org.junit.platform.engine.support.descriptor.ClassSource;
import org.junit.platform.engine.support.descriptor.MethodSource;
import org.junit.platform.launcher.Launcher;
import org.junit.platform.launcher.TestExecutionListener;
import org.junit.platform.launcher.TestIdentifier;
import org.junit.platform.launcher.TestPlan;
import org.junit.platform.launcher.core.LauncherDiscoveryRequestBuilder;
import org.junit.platform.launcher.core.LauncherFactory;

/**
 * Runs the JUnit Platform tests given as arguments ({@code com.acme.OrderTest} or
 * {@code com.acme.OrderTest#method}) and reports each test as the TeamCity service messages
 * OpenIDEA's Gradle test init script prints ({@code gradleTests.gradle}). Exits with 1 when a
 * test failed.
 */
public final class Runner implements TestExecutionListener {
    private final PrintStream out;
    private final Map<String, Long> started = new HashMap<>();
    private TestPlan plan;
    private int tests;
    private int failed;
    private int skipped;

    private Runner(PrintStream out) {
        this.out = out;
    }

    public static void main(String[] args) throws UnsupportedEncodingException {
        // The original stdout: JUnit replaces System.out while it captures a test's output.
        PrintStream out = new PrintStream(new FileOutputStream(FileDescriptor.out), true, "UTF-8");
        List<DiscoverySelector> selectors = new ArrayList<>();
        for (String arg : args) selectors.addAll(selectors(arg));
        Runner runner = new Runner(out);
        Launcher launcher = LauncherFactory.create();
        launcher.execute(
                LauncherDiscoveryRequestBuilder.request()
                        .selectors(selectors)
                        .configurationParameter("junit.platform.output.capture.stdout", "true")
                        .configurationParameter("junit.platform.output.capture.stderr", "true")
                        .build(),
                runner);
        StringBuilder summary = new StringBuilder().append(runner.tests).append(runner.tests == 1 ? " test" : " tests");
        summary.append(" completed");
        if (runner.failed > 0) summary.append(", ").append(runner.failed).append(" failed");
        if (runner.skipped > 0) summary.append(", ").append(runner.skipped).append(" skipped");
        out.println(summary);
        out.flush();
        System.exit(runner.failed > 0 || runner.tests == 0 ? 1 : 0);
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
        if (!id.isTest()) return;
        started.put(id.getUniqueId(), System.currentTimeMillis());
        message("testStarted", id(id));
    }

    @Override
    public void executionSkipped(TestIdentifier id, String reason) {
        List<TestIdentifier> skippedTests = new ArrayList<>();
        if (id.isTest()) skippedTests.add(id);
        else for (TestIdentifier d : plan.getDescendants(id)) if (d.isTest()) skippedTests.add(d);
        for (TestIdentifier test : skippedTests) {
            tests++;
            skipped++;
            message("testStarted", id(test));
            message("testIgnored", id(test) + attr("message", reason));
            message("testFinished", id(test) + attr("duration", "0"));
        }
    }

    @Override
    public void executionFinished(TestIdentifier id, TestExecutionResult result) {
        TestExecutionResult.Status status = result.getStatus();
        if (!id.isTest()) {
            // A class whose set-up failed (`@BeforeAll`): reported as a test, like JUnit 4's initializationError.
            Optional<String> className = className(id);
            if (status != TestExecutionResult.Status.FAILED || !className.isPresent()) return;
            String own = attr("name", "initializationError") + attr("className", className.get());
            message("testStarted", own);
            failed(own, result);
            message("testFinished", own + attr("duration", "0"));
            tests++;
            return;
        }
        tests++;
        String own = id(id);
        if (status == TestExecutionResult.Status.FAILED) failed(own, result);
        else if (status == TestExecutionResult.Status.ABORTED) {
            skipped++;
            message("testIgnored", own);
        }
        Long start = started.remove(id.getUniqueId());
        long duration = start == null ? 0 : System.currentTimeMillis() - start;
        message("testFinished", own + attr("duration", Long.toString(duration)));
    }

    @Override
    public void reportingEntryPublished(TestIdentifier id, ReportEntry entry) {
        for (Map.Entry<String, String> e : entry.getKeyValuePairs().entrySet()) {
            String kind = e.getKey().equals("stdout") ? "testStdOut" : e.getKey().equals("stderr") ? "testStdErr" : null;
            if (kind == null) continue;
            // A class's own output (`@BeforeAll`, `@AfterAll`) carries no test name.
            String own = id.isTest() ? id(id) : className(id).map(c -> attr("className", c)).orElse(null);
            if (own != null) message(kind, own + attr("out", e.getValue()));
        }
    }

    private void failed(String own, TestExecutionResult result) {
        failed++;
        Throwable error = result.getThrowable().orElse(null);
        StringWriter trace = new StringWriter();
        if (error != null) error.printStackTrace(new PrintWriter(trace));
        message("testFailed", own + attr("message", error == null ? "" : error.toString()) + attr("details", trace.toString()));
    }

    /** `name='method' className='a.B$Nested'`, the method and class of the test or its closest source. */
    private String id(TestIdentifier id) {
        for (TestIdentifier at = id; at != null; at = plan.getParent(at).orElse(null)) {
            TestSource source = at.getSource().orElse(null);
            if (source instanceof MethodSource) {
                MethodSource m = (MethodSource) source;
                return attr("name", m.getMethodName()) + attr("className", m.getClassName());
            }
            if (source instanceof ClassSource)
                return attr("name", id.getLegacyReportingName()) + attr("className", ((ClassSource) source).getClassName());
        }
        return attr("name", id.getLegacyReportingName()) + attr("className", id.getDisplayName());
    }

    private Optional<String> className(TestIdentifier id) {
        TestSource source = id.getSource().orElse(null);
        return source instanceof ClassSource ? Optional.of(((ClassSource) source).getClassName()) : Optional.empty();
    }

    private void message(String kind, String attrs) {
        out.println("##teamcity[" + kind + attrs + "]");
    }

    private static String attr(String name, String value) {
        return " " + name + "='" + escape(value) + "'";
    }

    static String escape(String s) {
        if (s == null) return "";
        return s.replace("|", "||").replace("'", "|'").replace("\n", "|n").replace("\r", "|r")
                .replace("[", "|[").replace("]", "|]");
    }
}
