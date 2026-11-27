package ai.openidea.jdbc;

import java.io.*;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.*;
import java.util.*;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.logging.Logger;

/** Drives the bridge over its actual pipes with a deterministic JDBC driver. */
public class SelfTest {
    public static class Fixture implements Driver {
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
                            "TABLE_TYPE", "BASE TABLE"),
                        Map.of("TABLE_CAT", "root", "TABLE_SCHEM", "qa_%", "TABLE_NAME", "outside_catalog",
                            "TABLE_TYPE", "BASE TABLE"),
                        Map.of("TABLE_CAT", "archive.db:1", "TABLE_SCHEM", "qaABC", "TABLE_NAME", "outside_schema",
                            "TABLE_TYPE", "BASE TABLE")))
                    : Arrays.equals(a, new Object[]{"root", "app", "%", null})
                        ? rows(List.of(Map.of("TABLE_NAME", "orders", "TABLE_TYPE", "TABLE")))
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
                case "getMetaData" -> meta;
                case "close" -> null;
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

        Statement statement() {
            var stop = new CountDownLatch(1);
            return proxy(Statement.class, (p, m, a) -> switch (m.getName()) {
                case "execute" -> {
                    String sql = (String) a[0];
                    if (sql.equals("wait") || sql.equals("ignore cancel")) {
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
                case "cancel" -> { stop.countDown(); yield null; }
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
        var child = new ProcessBuilder(java, "-cp", System.getProperty("java.class.path"),
                OpenIdeaJdbc.class.getName()).start();
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
            assert tables.contains("items") && !tables.contains("outside_catalog") && !tables.contains("outside_schema")
                : tables;
            send(out, 13, "schemas");
            var unscoped = new String(reply(in), StandardCharsets.UTF_8);
            assert unscoped.contains("app") && !unscoped.contains("qa_%") : unscoped;
            send(out, 14, "tables", "app");
            var genericTables = new String(reply(in), StandardCharsets.UTF_8);
            assert genericTables.contains("orders") && !genericTables.contains("items") : genericTables;
            send(out, 15, "schemaColumns", "qa_%", "archive.db:1");
            var scopedComments = new String(reply(in), StandardCharsets.UTF_8);
            assert scopedComments.contains("comment") && scopedComments.contains("archive label")
                && !scopedComments.contains("outside label") : scopedComments;
        } finally {
            child.destroyForcibly().waitFor();
        }
    }
}
