package ai.openidea.junit;

import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.PrintStream;
import java.io.UnsupportedEncodingException;

/**
 * Runs the tests given as arguments ({@code com.acme.OrderTest} or {@code com.acme.OrderTest#method})
 * and reports each test as the TeamCity service messages OpenIDEA's Gradle test init script prints
 * ({@code gradleTests.gradle}). Exits with 1 when a test failed or none ran.
 *
 * <p>JUnit Platform tests run on the Platform launcher. JUnit 4 (and 3) tests run on JUnit 4's own
 * {@code JUnitCore} when the classpath has no JUnit Platform, or has one without the Vintage engine,
 * so a JUnit 4 project needs nothing beyond its {@code junit} dependency.
 */
public final class Runner {
    private Runner() {}

    public static void main(String[] args) throws UnsupportedEncodingException {
        // The original stdout: the test frameworks' output capture replaces System.out.
        PrintStream out = new PrintStream(new FileOutputStream(FileDescriptor.out), true, "UTF-8");
        Reporter report = new Reporter(out);
        ClassLoader loader = Thread.currentThread().getContextClassLoader();
        boolean platform = present(loader, "org.junit.platform.launcher.core.LauncherFactory");
        boolean junit4 = present(loader, "org.junit.runner.JUnitCore");
        boolean vintage = present(loader, "org.junit.vintage.engine.VintageTestEngine");
        if (junit4 && (!platform || (!vintage && Junit4Runner.handlesAll(args, loader)))) Junit4Runner.run(report, args, loader);
        else PlatformRunner.run(report, args);
        out.println(report.summary());
        out.flush();
        System.exit(report.failed > 0 || report.tests == 0 ? 1 : 0);
    }

    private static boolean present(ClassLoader loader, String name) {
        try {
            Class.forName(name, false, loader);
            return true;
        } catch (ClassNotFoundException | LinkageError e) {
            return false;
        }
    }
}
