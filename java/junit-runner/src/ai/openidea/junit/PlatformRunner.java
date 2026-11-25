package ai.openidea.junit;

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

/** Runs JUnit Platform tests (Jupiter, and JUnit 4 through the Vintage engine when it is on the classpath). */
final class PlatformRunner implements TestExecutionListener {
    private final Reporter report;
    private final Map<String, Long> started = new HashMap<>();
    private TestPlan plan;

    private PlatformRunner(Reporter report) {
        this.report = report;
    }

    static void run(Reporter report, String[] args) {
        List<DiscoverySelector> selectors = new ArrayList<>();
        for (String arg : args) selectors.addAll(selectors(arg));
        Launcher launcher = LauncherFactory.create();
        launcher.execute(
                LauncherDiscoveryRequestBuilder.request()
                        .selectors(selectors)
                        .configurationParameter("junit.platform.output.capture.stdout", "true")
                        .configurationParameter("junit.platform.output.capture.stderr", "true")
                        .build(),
                new PlatformRunner(report));
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

    @Override
    public void reportingEntryPublished(TestIdentifier id, ReportEntry entry) {
        for (Map.Entry<String, String> e : entry.getKeyValuePairs().entrySet()) {
            String kind = e.getKey().equals("stdout") ? "testStdOut" : e.getKey().equals("stderr") ? "testStdErr" : null;
            if (kind == null) continue;
            // A class's own output (`@BeforeAll`, `@AfterAll`) carries no test name.
            String own = id.isTest() ? id(id) : className(id).map(c -> Reporter.attr("className", c)).orElse(null);
            if (own != null) report.message(kind, own + Reporter.attr("out", e.getValue()));
        }
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
}
