package ai.openidea.jdbc;

import java.io.*;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.sql.*;
import java.util.*;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.logging.Logger;

/** Drives the bridge over its actual pipes with a deterministic JDBC driver. */
public class SelfTest {
    public static class Fixture implements Driver {
        private static final CountDownLatch releaseCancellation = new CountDownLatch(1);
        private static final String LARGE_CELL = "x".repeat(16 * 1024);
        private boolean readonly;
        private boolean dropped;
        private int changes;
        private Path started;

        @SuppressWarnings("unchecked")
        static <T> T proxy(Class<T> type, java.lang.reflect.InvocationHandler handler) {
            return (T) Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, handler);
        }

        public Connection connect(String url, Properties props) {
            String path = url.substring("jdbc:fixture:".length());
            started = path.isEmpty() ? null : Path.of(path);
            var meta = proxy(DatabaseMetaData.class, (p, m, a) -> switch (m.getName()) {
                case "getDatabaseProductName" -> "Fixture";
                case "getDatabaseProductVersion" -> "1";
                case "getIdentifierQuoteString" -> "\"";
                case "getSearchStringEscape" -> "\\";
                case "getCatalogs" -> rows(List.of(
                    Map.of("TABLE_CAT", "root"), Map.of("TABLE_CAT", "archive.db:1")));
                case "getSchemas" -> a == null
                    ? rows(List.of(Map.of("TABLE_SCHEM", "app")))
                    : Arrays.equals(a, new Object[]{"archive.db:1", "%"})
                        ? rows(List.of(
                            Map.of("TABLE_CATALOG", "archive.db:1", "TABLE_SCHEM", "qa_%"),
                            Map.of("TABLE_CATALOG", "root", "TABLE_SCHEM", "outside_catalog")))
                        : rows(List.of());
                case "getTables" -> Arrays.equals(a, new Object[]{"archive.db:1", "qa\\_\\%", "%", null})
                    ? rows(List.of(
                        Map.of("TABLE_CAT", "archive.db:1", "TABLE_SCHEM", "qa_%", "TABLE_NAME", "items",
                            "TABLE_TYPE", "BASE TABLE", "REMARKS", "Archived items"),
                        Map.of("TABLE_CAT", "root", "TABLE_SCHEM", "qa_%", "TABLE_NAME", "outside_catalog",
                            "TABLE_TYPE", "BASE TABLE", "REMARKS", "Wrong catalog comment"),
                        Map.of("TABLE_CAT", "archive.db:1", "TABLE_SCHEM", "qaABC", "TABLE_NAME", "outside_schema",
                            "TABLE_TYPE", "BASE TABLE", "REMARKS", "Wrong schema comment")))
                    : Arrays.equals(a, new Object[]{"root", "app", "%", null})
                        ? rows(List.of(Map.of("TABLE_NAME", "orders", "TABLE_TYPE", "TABLE", "REMARKS", "Orders table")))
                        : rows(List.of());
                case "getColumns" -> Arrays.equals(a, new Object[]{"archive.db:1", "qa\\_\\%", "%", "%"})
                    ? rows(List.of(
                        Map.of("TABLE_CAT", "archive.db:1", "TABLE_SCHEM", "qa_%", "TABLE_NAME", "items",
                            "COLUMN_NAME", "note", "TYPE_NAME", "VARCHAR", "NULLABLE", 1, "REMARKS", "archive label"),
                        Map.of("TABLE_CAT", "root", "TABLE_SCHEM", "qa_%", "TABLE_NAME", "outside_catalog",
                            "COLUMN_NAME", "note", "TYPE_NAME", "VARCHAR", "NULLABLE", 1, "REMARKS", "outside label")))
                    : "app".equals(a[1]) && "%".equals(a[2]) ? rows(List.of(
                        Map.of("TABLE_NAME", "orders", "COLUMN_NAME", "id", "TYPE_NAME", "INT", "NULLABLE", 0),
                        Map.of("TABLE_NAME", "orders", "COLUMN_NAME", "note", "TYPE_NAME", "VARCHAR", "NULLABLE", 1,
                            "COLUMN_DEF", "'none'", "REMARKS", "free text"))) : rows(List.of());
                default -> throw new SQLFeatureNotSupportedException();
            });
            return proxy(Connection.class, (p, m, a) -> switch (m.getName()) {
                case "setReadOnly" -> { readonly = (boolean) a[0]; yield null; }
                case "getMetaData" -> {
                    if (path.equals("fail-metadata")) throw new SQLException("private bootstrap detail");
                    yield meta;
                }
                case "close" -> { System.err.println("connection closed"); yield null; }
                case "createStatement" -> statement();
                case "isClosed" -> false;
                case "isValid" -> !dropped;
                case "getCatalog" -> "root";
                default -> throw new SQLFeatureNotSupportedException();
            });
        }

        /** A forward-only result set over `data`, read by column label. */
        static ResultSet rows(List<Map<String, Object>> data) {
            int[] at = {-1};
            return proxy(ResultSet.class, (p, m, a) -> switch (m.getName()) {
                case "next" -> ++at[0] < data.size();
                case "getString" -> (String) data.get(at[0]).get((String) a[0]);
                case "getInt" -> (Integer) data.get(at[0]).getOrDefault((String) a[0], 0);
                case "close" -> null;
                default -> throw new SQLFeatureNotSupportedException();
            });
        }

        static ResultSet largeRows(boolean fail) {
            int[] rows = {0};
            var metadata = proxy(ResultSetMetaData.class, (p, m, a) -> switch (m.getName()) {
                case "getColumnCount" -> 1;
                case "getColumnLabel" -> "payload";
                case "getColumnTypeName" -> "VARCHAR";
                case "getColumnType" -> Types.VARCHAR;
                default -> throw new SQLFeatureNotSupportedException();
            });
            return proxy(ResultSet.class, (p, m, a) -> switch (m.getName()) {
                case "next" -> {
                    if (++rows[0] == 6 && fail) throw new SQLException("large result failed while reading");
                    yield rows[0] <= 990;
                }
                case "getMetaData" -> metadata;
                case "getString" -> LARGE_CELL;
                case "close" -> null;
                default -> throw new SQLFeatureNotSupportedException();
            });
        }

        Statement statement() {
            var stop = new CountDownLatch(1);
            var slowCancel = new AtomicBoolean();
            boolean[] failLargeRows = {false};
            return proxy(Statement.class, (p, m, a) -> switch (m.getName()) {
                case "execute" -> {
                    String sql = (String) a[0];
                    if (sql.equals("large rows") || sql.equals("large error")) {
                        failLargeRows[0] = sql.equals("large error");
                        System.err.println("large query started");
                        yield true;
                    }
                    if (sql.equals("write marker")) Files.writeString(started, "once\n", StandardOpenOption.APPEND);
                    if (sql.equals("release cancel gate")) releaseCancellation.countDown();
                    if (sql.equals("wait for cancel gate")) slowCancel.set(true);
                    if (sql.equals("wait") || sql.equals("ignore cancel") || slowCancel.get()) {
                        if (started != null) java.nio.file.Files.writeString(started, "started");
                        System.err.println("statement started");
                        if (sql.equals("ignore cancel")) Thread.sleep(60_000);
                        if (!stop.await(20, TimeUnit.SECONDS)) throw new SQLException("test timed out");
                        throw new SQLException("statement cancelled");
                    }
                    if (sql.equals("write") && readonly) throw new SQLException("read-only");
                    if (sql.equals("drop")) { dropped = true; throw new SQLException("connection reset"); }
                    changes++;
                    yield false;
                }
                case "cancel" -> {
                    if (slowCancel.get()) {
                        System.err.println("cancel entered");
                        if (!releaseCancellation.await(15, TimeUnit.SECONDS))
                            throw new SQLException("cancel gate timed out");
                    }
                    stop.countDown();
                    yield null;
                }
                case "getResultSet" -> largeRows(failLargeRows[0]);
                case "getUpdateCount" -> changes;
                case "close" -> null;
                default -> throw new SQLFeatureNotSupportedException();
            });
        }
        public boolean acceptsURL(String url) { return true; }
        public DriverPropertyInfo[] getPropertyInfo(String url, Properties p) { return new DriverPropertyInfo[0]; }
        public int getMajorVersion() { return 1; }
        public int getMinorVersion() { return 0; }
        public boolean jdbcCompliant() { return false; }
        public Logger getParentLogger() { return Logger.getGlobal(); }
    }

    static void send(DataOutputStream out, long id, String... fields) throws IOException {
        out.writeLong(id);
        out.writeInt(fields.length);
        for (String s : fields) {
            byte[] b = s.getBytes(StandardCharsets.UTF_8);
            out.writeInt(b.length);
            out.write(b);
        }
        out.flush();
    }

    static byte[] reply(DataInputStream in) throws IOException {
        int size = in.readInt();
        assert size >= 0 && size <= OpenIdeaJdbc.LIMIT;
        byte[] bytes = new byte[size];
        in.readFully(bytes);
        return bytes;
    }

    static void sendOn(DataOutputStream out, long id, int connection, String... fields) throws IOException {
        out.writeLong(id);
        out.writeInt(connection);
        out.writeInt(fields.length);
        for (String field : fields) {
            byte[] data = field.getBytes(StandardCharsets.UTF_8);
            out.writeInt(data.length);
            out.write(data);
        }
        out.flush();
    }

    record Tagged(long id, byte[] data) {
        int status() { return data.length == 0 ? -1 : data[0]; }
    }

    static Tagged tagged(DataInputStream in) throws IOException {
        return new Tagged(in.readLong(), reply(in));
    }

    static Tagged expect(DataInputStream in, long id, int status) throws IOException {
        var message = tagged(in);
        assert message.id() == id && message.status() == status
            : "Expected reply " + id + "/" + status + ", got " + message.id() + "/" + message.status();
        return message;
    }

    static Process start(String java, boolean multiplex, String... jvmOptions) throws IOException {
        var command = new ArrayList<String>();
        command.add(java);
        command.addAll(List.of(jvmOptions));
        command.addAll(List.of("--enable-native-access=ALL-UNNAMED", "-cp", System.getProperty("java.class.path"),
            OpenIdeaJdbc.class.getName()));
        if (multiplex) command.add("--multiplex");
        return new ProcessBuilder(command).start();
    }

    static void multiplex(String java) throws Exception {
        var child = start(java, true);
        try (var out = new DataOutputStream(child.getOutputStream());
             var in = new DataInputStream(child.getInputStream());
             var log = child.errorReader()) {
            sendOn(out, 100, 0, "open", Fixture.class.getName(), "jdbc:fixture:", "", "", "false");
            try {
                expect(in, 100, 1);
            } catch (IOException e) {
                throw new AssertionError("The bridge did not accept the multiplex bootstrap frame", e);
            }
            sendOn(out, 101, 1, "open");
            expect(in, 101, 1);
            sendOn(out, 102, 2, "open");
            expect(in, 102, 1);
            sendOn(out, 103, 1, "query", "wait for cancel gate", "0", "2");
            assert log.lines().anyMatch("statement started"::equals);
            sendOn(out, 104, 1, "query", "overlap", "0", "2");
            expect(in, 104, 0);

            sendOn(out, 103, 2); // Wrong connection must not cancel the active request.
            expect(in, 103, -1);
            sendOn(out, 105, 2, "query", "independent console", "0", "2");
            expect(in, 105, 1);
            sendOn(out, 103, 1);
            expect(in, 103, -1);
            assert log.lines().anyMatch("cancel entered"::equals);
            sendOn(out, 106, 0, "schemaColumns", "app");
            expect(in, 106, 1); // The driver is still withholding the cancellation response.
            sendOn(out, 107, 1, "close");
            expect(in, 107, 1);
            sendOn(out, 108, 1, "query", "retired", "0", "2");
            expect(in, 108, 0);
            sendOn(out, 109, 2, "query", "release cancel gate", "0", "2");
            var first = tagged(in);
            var second = tagged(in);
            var statuses = Map.of(first.id(), first.status(), second.id(), second.status());
            assert statuses.equals(Map.of(103L, 0, 109L, 1)) : statuses;
            assert log.lines().anyMatch("connection closed"::equals);

            sendOn(out, 110, 2, "query", "after sibling close", "0", "2");
            expect(in, 110, 1);
            sendOn(out, 111, 0, "valid");
            assert new String(expect(in, 111, 1).data(), StandardCharsets.UTF_8).contains("true");
        } finally {
            child.destroyForcibly().waitFor();
        }
    }

    static void capacity(String java) throws Exception {
        var child = start(java, true);
        try (var out = new DataOutputStream(child.getOutputStream());
             var in = new DataInputStream(child.getInputStream());
             var log = child.errorReader()) {
            sendOn(out, 200, 0, "open", Fixture.class.getName(), "jdbc:fixture:fail-metadata", "", "", "false");
            var failure = new String(expect(in, 200, 0).data(), StandardCharsets.UTF_8);
            assert failure.contains("JDBC connection failed") && !failure.contains("private bootstrap detail");
            assert log.lines().anyMatch("connection closed"::equals);
            sendOn(out, 201, 0, "open", Fixture.class.getName(), "jdbc:fixture:", "", "", "false");
            expect(in, 201, 1);

            for (int i = 1; i <= 31; i++) {
                sendOn(out, 201 + i, i, "open");
                expect(in, 201 + i, 1);
            }
            sendOn(out, 300, 32, "open");
            var full = new String(expect(in, 300, 0).data(), StandardCharsets.UTF_8);
            assert full.contains("Close") && full.contains("try again") : full;
            sendOn(out, 301, 31, "query", "survives admission failure", "0", "2");
            expect(in, 301, 1);

            sendOn(out, 302, 1, "close");
            expect(in, 302, 1);
            sendOn(out, 303, 1, "query", "retired", "0", "2");
            expect(in, 303, 0);
            assert log.lines().anyMatch("connection closed"::equals);
            boolean reopened = false;
            for (int attempt = 0; attempt < 20; attempt++) {
                int id = 33 + attempt;
                sendOn(out, 304 + attempt, id, "open");
                var response = tagged(in);
                assert response.id() == 304 + attempt;
                if (response.status() == 1) {
                    reopened = true;
                    break;
                }
                assert response.status() == 0;
                Thread.sleep(5);
            }
            assert reopened : "A closed console did not release its connection slot";
            sendOn(out, 330, 0, "valid");
            expect(in, 330, 1);
        } finally {
            child.destroyForcibly().waitFor();
        }
    }

    static void brokenStreams(String java) throws Exception {
        var marker = Files.createTempFile("openidea-jdbc-write-", ".txt");
        try {
            for (boolean breakOutput : new boolean[]{false, true}) {
                Files.writeString(marker, "");
                var child = start(java, true);
                try (var out = new DataOutputStream(child.getOutputStream());
                     var in = new DataInputStream(child.getInputStream());
                     var log = child.errorReader()) {
                    sendOn(out, 400, 0, "open", Fixture.class.getName(), "jdbc:fixture:" + marker, "", "", "false");
                    expect(in, 400, 1);
                    sendOn(out, 401, 1, "open");
                    expect(in, 401, 1);
                    if (breakOutput) in.close();
                    sendOn(out, 402, 1, "query", "write marker", "0", "2");
                    if (!breakOutput) {
                        expect(in, 402, 1);
                        out.writeLong(403);
                        out.writeInt(1);
                        out.writeInt(1);
                        out.writeInt(8);
                        out.writeByte(0); // A truncated field, not a clean EOF between frames.
                        out.close();
                    }
                    assert child.waitFor(5, TimeUnit.SECONDS) : "Broken JDBC pipe did not terminate (stdout=" + breakOutput + ")";
                    assert child.exitValue() != 0;
                    long closed = log.lines().filter("connection closed"::equals).count();
                    assert closed == 2 : "Broken stdout=" + breakOutput + " closed " + closed + " connections";
                    assert Files.readAllLines(marker).equals(List.of("once")) : "JDBC write was replayed";
                } finally {
                    child.destroyForcibly().waitFor();
                }
            }
        } finally {
            Files.delete(marker);
        }
    }

    static void boundedReplies(String java) throws Exception {
        var child = start(java, true, "-Xmx192m");
        try (var out = new DataOutputStream(child.getOutputStream());
             var in = new DataInputStream(child.getInputStream());
             var log = child.errorReader()) {
            sendOn(out, 500, 0, "open", Fixture.class.getName(), "jdbc:fixture:", "", "", "false");
            expect(in, 500, 1);
            int largeQueries = 16;
            for (int i = 1; i <= largeQueries + 1; i++) {
                sendOn(out, 500 + i, i, "open");
                expect(in, 500 + i, 1);
            }
            for (int i = 1; i <= largeQueries; i++)
                sendOn(out, 600 + i, i, "query", "large rows", "0", "1000");
            for (int i = 0; i < largeQueries; i++)
                assert log.lines().anyMatch("large query started"::equals);
            sendOn(out, 700, largeQueries + 1, "query", "small reply", "0", "1");
            sendOn(out, 701, largeQueries + 1); // Stale cancel still produces its tagged acknowledgement.
            // Back up stdout while the workers assemble their responses. The parent
            // drains the payloads in place rather than retaining the test data.
            Thread.sleep(300);
            Set<Long> replies = new HashSet<>();
            int smallAt = -1, ackAt = -1;
            for (int i = 0; i < largeQueries + 2; i++) {
                long id = in.readLong();
                int length = in.readInt();
                assert replies.add(id);
                if (id == 701) {
                    assert length == 0;
                    ackAt = i;
                    continue;
                }
                assert length > 0 && length <= OpenIdeaJdbc.LIMIT;
                assert in.readBoolean() : "JDBC result did not finish: " + id;
                in.skipNBytes(length - 1);
                if (id == 700) {
                    assert length < 1024;
                    smallAt = i;
                } else {
                    assert id > 600 && id <= 600 + largeQueries && length > 15 * 1024 * 1024;
                }
            }
            assert smallAt >= 0 && smallAt < largeQueries + 1;
            assert ackAt >= 0 && ackAt < largeQueries + 1;
            sendOn(out, 702, 0, "valid");
            expect(in, 702, 1);
            sendOn(out, 703, 1, "query", "large error", "0", "1000");
            expect(in, 703, 0);
            sendOn(out, 704, 2, "query", "large rows", "0", "1000");
            assert in.readLong() == 704;
            int length = in.readInt();
            assert length > 15 * 1024 * 1024 && in.readBoolean();
            in.skipNBytes(length - 1); // The failed encoding released its reply reservation.
        } finally {
            child.destroyForcibly().waitFor();
        }
    }

    public static void main(String[] args) throws Exception {
        var boundary = new DataOutputStream(OutputStream.nullOutputStream());
        OpenIdeaJdbc.text(boundary, "x".repeat(OpenIdeaJdbc.LIMIT - 14));
        OpenIdeaJdbc.end(boundary, false, -1);
        assert boundary.size() == OpenIdeaJdbc.LIMIT;
        try {
            OpenIdeaJdbc.text(boundary, "");
            throw new AssertionError("Oversized reply accepted");
        } catch (IOException expected) {}
        var java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        var child = start(java, false);
        try (var out = new DataOutputStream(child.getOutputStream());
             var in = new DataInputStream(child.getInputStream());
             var log = child.errorReader()) {
            send(out, 1, "open", Fixture.class.getName(), "jdbc:fixture:", "", "", "true");
            assert reply(in)[0] == 1;
            send(out, 2, "query", "write", "0", "2");
            assert reply(in)[0] == 0;
            send(out, 3, "query", "first", "0", "2");
            assert reply(in)[0] == 1;
            send(out, 4, "query", "wait", "0", "2");
            assert log.lines().anyMatch("statement started"::equals);
            send(out, 3); // A late Cancel for the previous request cannot stop this one.
            assert reply(in).length == 0;
            send(out, 4);
            var first = reply(in);
            var second = reply(in);
            assert (first.length == 0) != (second.length == 0);
            assert (first.length == 0 ? second : first)[0] == 0;
            send(out, 5, "query", "after cancel", "0", "2");
            var result = reply(in);
            assert result[0] == 1 && result[result.length - 1] == 2;
            send(out, 6, "valid");
            assert new String(reply(in), StandardCharsets.UTF_8).contains("true");
            send(out, 7, "query", "drop", "0", "2");
            assert reply(in)[0] == 0;
            send(out, 8, "valid");
            assert new String(reply(in), StandardCharsets.UTF_8).contains("false");
            send(out, 9, "schemaColumns", "app");
            var columns = new String(reply(in), StandardCharsets.UTF_8);
            assert columns.contains("orders") && columns.contains("note") && columns.contains("'none'") : columns;
            assert columns.contains("comment") && columns.contains("free text") : columns;
            send(out, 10, "catalogs");
            var catalogs = reply(in);
            assert catalogs[0] == 1 : new String(catalogs, StandardCharsets.UTF_8);
            var catalogRows = new String(catalogs, StandardCharsets.UTF_8);
            assert catalogRows.contains("archive.db:1") && catalogRows.contains("root") : catalogRows;
            send(out, 11, "schemas", "archive.db:1");
            var scoped = new String(reply(in), StandardCharsets.UTF_8);
            assert scoped.contains("qa_%") && !scoped.contains("outside_catalog") : scoped;
            send(out, 12, "tables", "qa_%", "archive.db:1");
            var tables = new String(reply(in), StandardCharsets.UTF_8);
            assert tables.contains("items") && tables.contains("Archived items")
                && !tables.contains("outside_catalog") && !tables.contains("outside_schema")
                && !tables.contains("Wrong catalog comment") && !tables.contains("Wrong schema comment") : tables;
            send(out, 13, "schemas");
            var unscoped = new String(reply(in), StandardCharsets.UTF_8);
            assert unscoped.contains("app") && !unscoped.contains("qa_%") : unscoped;
            send(out, 14, "tables", "app");
            var genericTables = new String(reply(in), StandardCharsets.UTF_8);
            assert genericTables.contains("orders") && genericTables.contains("Orders table")
                && !genericTables.contains("items") : genericTables;
            send(out, 15, "schemaColumns", "qa_%", "archive.db:1");
            var scopedComments = new String(reply(in), StandardCharsets.UTF_8);
            assert scopedComments.contains("comment") && scopedComments.contains("archive label")
                && !scopedComments.contains("outside label") : scopedComments;
        } finally {
            child.destroyForcibly().waitFor();
        }
        multiplex(java);
        capacity(java);
        brokenStreams(java);
        boundedReplies(java);
    }
}
