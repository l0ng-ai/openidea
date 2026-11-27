package ai.openidea.junit;

import java.io.PrintStream;
import java.io.PrintWriter;
import java.io.StringWriter;

/**
 * Prints tests as the TeamCity service messages of OpenIDEA's Gradle test init script
 * ({@code gradleTests.gradle}) and counts them for the summary line. Parallel tests report from
 * several threads at once.
 */
final class Reporter {
    private final PrintStream out;
    int tests;
    int failed;
    int skipped;

    Reporter(PrintStream out) {
        this.out = out;
    }

    void message(String kind, String attrs) {
        synchronized (out) {
            out.println("##teamcity[" + kind + attrs + "]");
        }
    }

    /** Output written outside any test, as it was written. */
    void write(byte[] bytes, int off, int len) {
        synchronized (out) {
            out.write(bytes, off, len);
            out.flush();
        }
    }

    /** Output written outside any test. */
    void print(String text) {
        synchronized (out) {
            out.print(text);
            out.flush();
        }
    }

    synchronized void failed(String own, Throwable error) {
        failed++;
        StringWriter trace = new StringWriter();
        if (error != null) error.printStackTrace(new PrintWriter(trace));
        message("testFailed", own + attr("message", error == null ? "" : error.toString()) + attr("details", withoutRunner(trace.toString())));
    }

    synchronized void skipped(String own, String reason) {
        skipped++;
        message("testIgnored", own + (reason == null ? "" : attr("message", reason)));
    }

    synchronized void finished(String own, long duration) {
        tests++;
        message("testFinished", own + attr("duration", Long.toString(duration)));
    }

    /** A test that was skipped without starting (`@Disabled`, `@Ignore`). */
    void ignored(String own, String reason) {
        message("testStarted", own);
        skipped(own, reason);
        finished(own, 0);
    }

    synchronized String summary() {
        StringBuilder summary = new StringBuilder().append(tests).append(tests == 1 ? " test" : " tests");
        summary.append(" completed");
        if (failed > 0) summary.append(", ").append(failed).append(" failed");
        if (skipped > 0) summary.append(", ").append(skipped).append(" skipped");
        return summary.toString();
    }

    /** The stack trace without the runner's own frames (they end every test's trace). */
    static String withoutRunner(String trace) {
        StringBuilder out = new StringBuilder(trace.length());
        for (String line : trace.split("\n", -1)) {
            if (line.trim().startsWith("at ai.openidea.junit.")) continue;
            if (out.length() > 0) out.append('\n');
            out.append(line);
        }
        return out.toString();
    }

    static String attr(String name, String value) {
        return " " + name + "='" + escape(value) + "'";
    }

    static String escape(String s) {
        if (s == null) return "";
        return s.replace("|", "||").replace("'", "|'").replace("\n", "|n").replace("\r", "|r")
                .replace("[", "|[").replace("]", "|]");
    }
}
