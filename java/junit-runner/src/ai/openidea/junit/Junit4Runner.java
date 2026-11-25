package ai.openidea.junit;

import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.io.PrintStream;
import java.io.UnsupportedEncodingException;
import java.lang.annotation.Annotation;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.runner.Description;
import org.junit.runner.JUnitCore;
import org.junit.runner.Request;
import org.junit.runner.manipulation.Filter;
import org.junit.runner.notification.Failure;
import org.junit.runner.notification.RunListener;

/**
 * Runs JUnit 4 (and JUnit 3) tests on {@code JUnitCore}, as IDEA's JUnit 4 runner does. Each test's
 * stdout and stderr are reported with the test; output outside a test is printed as is.
 */
final class Junit4Runner extends RunListener {
    private final Reporter report;
    private final Map<Description, Long> started = new HashMap<>();
    private final List<Capture> captures = new ArrayList<>();
    /** The running test, whose output the captured System.out / System.err belong to. */
    private volatile Description current;

    private Junit4Runner(Reporter report) {
        this.report = report;
    }

    /** Whether every argument names a JUnit 4 or JUnit 3 test class. */
    static boolean handlesAll(String[] args, ClassLoader loader) {
        if (args.length == 0) return false;
        for (String arg : args) {
            try {
                if (!isJunit4(Class.forName(className(arg), false, loader))) return false;
            } catch (ClassNotFoundException | LinkageError e) {
                return false;
            }
        }
        return true;
    }

    private static boolean isJunit4(Class<?> type) {
        for (Annotation a : type.getAnnotations()) {
            if (a.annotationType().getName().equals("org.junit.runner.RunWith")) return true;
        }
        for (Class<?> c = type; c != null && c != Object.class; c = c.getSuperclass()) {
            if (c.getName().equals("junit.framework.TestCase")) return true;
            for (Method m : c.getDeclaredMethods()) {
                for (Annotation a : m.getAnnotations()) {
                    if (a.annotationType().getName().equals("org.junit.Test")) return true;
                }
            }
        }
        return false;
    }

    static void run(Reporter report, String[] args, ClassLoader loader) throws UnsupportedEncodingException {
        Junit4Runner listener = new Junit4Runner(report);
        JUnitCore core = new JUnitCore();
        core.addListener(listener);
        PrintStream stdout = System.out;
        PrintStream stderr = System.err;
        Capture out = listener.new Capture("testStdOut");
        Capture err = listener.new Capture("testStdErr");
        System.setOut(new PrintStream(out, true, "UTF-8"));
        System.setErr(new PrintStream(err, true, "UTF-8"));
        try {
            for (String arg : args) core.run(request(arg, loader));
        } finally {
            System.out.flush();
            System.err.flush();
            System.setOut(stdout);
            System.setErr(stderr);
        }
    }

    private static String className(String arg) {
        int hash = arg.indexOf('#');
        return hash < 0 ? arg : arg.substring(0, hash);
    }

    /** The class, or only the methods named after {@code #} (a parameterized method's runs are {@code name[0]}…). */
    static Request request(String arg, ClassLoader loader) {
        Class<?> type;
        try {
            type = Class.forName(className(arg), false, loader);
        } catch (ClassNotFoundException | LinkageError e) {
            return Request.errorReport(Junit4Runner.class, e);
        }
        Request request = Request.aClass(type);
        int hash = arg.indexOf('#');
        if (hash < 0) return request;
        final String name = arg.substring(hash + 1);
        return request.filterWith(new Filter() {
            @Override
            public boolean shouldRun(Description d) {
                if (d.isTest()) {
                    String method = d.getMethodName();
                    return method != null && (method.equals(name) || method.startsWith(name + "["));
                }
                for (Description child : d.getChildren()) if (shouldRun(child)) return true;
                return false;
            }

            @Override
            public String describe() {
                return "method " + name;
            }
        });
    }

    private static String id(Description d) {
        String method = d.getMethodName();
        return Reporter.attr("name", method != null ? method : "initializationError")
                + Reporter.attr("className", d.getClassName());
    }

    @Override
    public void testStarted(Description d) {
        flushCaptured();
        started.put(d, System.currentTimeMillis());
        current = d;
        report.message("testStarted", id(d));
    }

    @Override
    public void testFinished(Description d) {
        flushCaptured();
        current = null;
        Long start = started.remove(d);
        report.finished(id(d), start == null ? 0 : System.currentTimeMillis() - start);
    }

    @Override
    public void testFailure(Failure failure) {
        Description d = failure.getDescription();
        if (started.containsKey(d)) {
            report.failed(id(d), failure.getException());
            return;
        }
        // A class whose set-up failed (`@BeforeClass`), or a failure outside any started test.
        flushCaptured();
        String own = id(d);
        report.message("testStarted", own);
        report.failed(own, failure.getException());
        report.finished(own, 0);
    }

    @Override
    public void testAssumptionFailure(Failure failure) {
        Description d = failure.getDescription();
        if (started.containsKey(d)) report.skipped(id(d), failure.getMessage());
        else for (Description test : tests(d)) report.ignored(id(test), failure.getMessage());
    }

    @Override
    public void testIgnored(Description d) {
        for (Description test : tests(d)) report.ignored(id(test), reason(d));
    }

    private static String reason(Description d) {
        for (Annotation a : d.getAnnotations()) {
            if (!a.annotationType().getName().equals("org.junit.Ignore")) continue;
            try {
                Object value = a.annotationType().getMethod("value").invoke(a);
                return value == null || value.toString().isEmpty() ? null : value.toString();
            } catch (ReflectiveOperationException e) {
                return null;
            }
        }
        return null;
    }

    private static List<Description> tests(Description d) {
        List<Description> out = new ArrayList<>();
        if (d.isTest()) out.add(d);
        else for (Description child : d.getChildren()) out.addAll(tests(child));
        return out;
    }

    private void flushCaptured() {
        for (Capture c : captures) c.drain();
    }

    /** System.out / System.err: buffered, then reported with the running test or printed outside one. */
    final class Capture extends OutputStream {
        private final String kind;
        private final ByteArrayOutputStream buffer = new ByteArrayOutputStream();

        Capture(String kind) {
            this.kind = kind;
            captures.add(this);
        }

        @Override
        public synchronized void write(int b) {
            buffer.write(b);
        }

        @Override
        public synchronized void write(byte[] b, int off, int len) {
            buffer.write(b, off, len);
        }

        @Override
        public void flush() {
            if (current == null) drain();
        }

        synchronized void drain() {
            if (buffer.size() == 0) return;
            String text = new String(buffer.toByteArray(), StandardCharsets.UTF_8);
            buffer.reset();
            Description test = current;
            if (test != null) report.message(kind, id(test) + Reporter.attr("out", text));
            else report.print(text);
        }
    }
}
