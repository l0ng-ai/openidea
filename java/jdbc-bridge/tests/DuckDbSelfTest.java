package ai.openidea.jdbc;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.concurrent.TimeUnit;

/** Exercises the production frames with a supplied DuckDB JDBC distribution. */
public final class DuckDbSelfTest {
    private static final class Bridge implements AutoCloseable {
        private final Process child;
        private final DataInputStream in;
        private final DataOutputStream out;
        private long id = 1;

        Bridge(String java) throws IOException {
            child = SelfTest.start(java, true);
            in = new DataInputStream(child.getInputStream());
            out = new DataOutputStream(child.getOutputStream());
        }

        SelfTest.Tagged request(int connection, int status, String... fields) throws IOException {
            long current = id++;
            SelfTest.sendOn(out, current, connection, fields);
            return SelfTest.expect(in, current, status);
        }

        void open(String url) throws IOException {
            request(0, 1, "open", "org.duckdb.DuckDBDriver", url, "", "", "false");
        }

        void execute(int connection, String sql) throws IOException {
            request(connection, 1, "query", sql, "0", "2");
        }

        String value(int connection, String sql) throws IOException {
            var message = request(connection, 1, "query", sql, "0", "2");
            try (var value = new DataInputStream(new ByteArrayInputStream(message.data()))) {
                assert value.readBoolean();
                assert value.readInt() == 1;
                text(value); // Column label.
                text(value); // JDBC type.
                assert value.readBoolean();
                return text(value);
            }
        }

        @Override public void close() throws Exception {
            try {
                out.close();
                if (!child.waitFor(5, TimeUnit.SECONDS))
                    throw new AssertionError("JDBC process did not close its connections on EOF");
                assert child.exitValue() == 0 : new String(child.getErrorStream().readAllBytes(), StandardCharsets.UTF_8);
            } finally {
                if (child.isAlive()) child.destroyForcibly().waitFor();
                in.close();
            }
        }
    }

    private static String text(DataInputStream in) throws IOException {
        int size = in.readInt();
        return size == -1 ? null : new String(in.readNBytes(size), StandardCharsets.UTF_8);
    }

    public static void main(String[] args) throws Exception {
        var java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        try (var bridge = new Bridge(java)) {
            bridge.open("jdbc:duckdb:");
            bridge.request(1, 1, "open");
            bridge.request(2, 1, "open");
            bridge.execute(1, "CREATE TABLE durable(i INTEGER)");
            bridge.execute(1, "INSERT INTO durable VALUES (41)");
            assert bridge.value(2, "SELECT i FROM durable").equals("41");
            bridge.execute(1, "CREATE TEMP TABLE private_table(i INTEGER)");
            bridge.execute(1, "INSERT INTO private_table VALUES (7)");
            assert bridge.value(1, "SELECT i FROM private_table").equals("7");
            bridge.request(2, 0, "query", "SELECT i FROM private_table", "0", "2");

            bridge.execute(1, "ATTACH ':memory:' AS attached_catalog");
            bridge.execute(1, "USE attached_catalog");
            assert bridge.value(1, "SELECT current_database()").equals("attached_catalog");
            assert !bridge.value(2, "SELECT current_database()").equals("attached_catalog");
            bridge.execute(1, "CREATE TABLE shared_catalog(i INTEGER)");
            bridge.execute(1, "INSERT INTO shared_catalog VALUES (9)");
            assert bridge.value(2, "SELECT i FROM attached_catalog.main.shared_catalog").equals("9");

            bridge.request(1, 1, "close");
            assert bridge.value(2, "SELECT i FROM durable").equals("41");
            bridge.request(3, 1, "open");
            assert bridge.value(3, "SELECT i FROM attached_catalog.main.shared_catalog").equals("9");
        }

        var fixture = Files.createTempDirectory("openidea-jdbc-duckdb-");
        var url = "jdbc:duckdb:" + fixture.resolve("fixture.duckdb");
        try {
            try (var bridge = new Bridge(java)) {
                bridge.open(url);
                bridge.request(1, 1, "open");
                bridge.request(2, 1, "open");
                bridge.execute(1, "CREATE TABLE durable(i INTEGER)");
                bridge.execute(1, "INSERT INTO durable VALUES (42)");
                assert bridge.value(2, "SELECT i FROM durable").equals("42");
                bridge.request(1, 1, "close");
            }
            try (var reopened = new Bridge(java)) {
                reopened.open(url);
                assert reopened.value(0, "SELECT i FROM durable").equals("42");
            }
        } finally {
            try (var paths = Files.walk(fixture)) {
                for (var path : paths.sorted(Comparator.reverseOrder()).toList()) Files.delete(path);
            }
        }
    }
}
