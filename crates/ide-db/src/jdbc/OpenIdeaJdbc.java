// The JDBC driver lives in this process only. The parent owns its lifetime and sends
// credentials over stdin. Driver console output must never enter the reply stream.
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.*;
import java.util.*;

class OpenIdeaJdbc {
    static final int LIMIT = 16 * 1024 * 1024;
    final DataInputStream input = new DataInputStream(new BufferedInputStream(System.in));
    final DataOutputStream output = new DataOutputStream(new BufferedOutputStream(System.out));
    Connection connection;
    boolean catalogs;
    boolean namespaceKnown;

    static String read(DataInputStream in) throws IOException {
        int n = in.readInt();
        if (n < 0 || n > LIMIT) throw new IOException("Invalid JDBC request length");
        byte[] b = in.readNBytes(n);
        if (b.length != n) throw new EOFException();
        return new String(b, StandardCharsets.UTF_8);
    }

    static void text(DataOutputStream out, String value) throws IOException {
        if (out.size() > LIMIT - 16) throw new IOException("JDBC result exceeds 16 MiB; select fewer or smaller values");
        if (value == null) { out.writeInt(-1); return; }
        byte[] data = value.getBytes(StandardCharsets.UTF_8);
        if (data.length > LIMIT - 4 - out.size()) throw new IOException("JDBC result exceeds 16 MiB; select fewer or smaller values");
        out.writeInt(data.length);
        out.write(data);
    }

    static void header(DataOutputStream out, String... names) throws IOException {
        out.writeInt(names.length);
        for (String name : names) { text(out, name); text(out, "VARCHAR"); }
    }

    static void row(DataOutputStream out, String... cells) throws IOException {
        out.writeBoolean(true);
        for (String cell : cells) text(out, cell);
    }

    static void end(DataOutputStream out, boolean more, long affected) throws IOException {
        out.writeBoolean(false);
        out.writeBoolean(more);
        out.writeLong(affected);
    }

    private static class UnsupportedUrl extends SQLException {}

    void open(List<String> a, DataOutputStream out) throws Exception {
        String className = a.get(0), url = a.get(1);
        int n = Integer.parseInt(a.get(4));
        URL[] jars = new URL[n];
        for (int i = 0; i < n; i++) jars[i] = Path.of(a.get(5+i)).toUri().toURL();
        var loader = new URLClassLoader(jars, ClassLoader.getPlatformClassLoader());
        Thread.currentThread().setContextClassLoader(loader);
        Driver driver = Class.forName(className, false, loader).asSubclass(Driver.class).getConstructor().newInstance();
        var props = new Properties();
        for (int i = 5+n; i < a.size(); i += 2) props.setProperty(a.get(i), a.get(i+1));
        if (!a.get(2).isEmpty()) props.setProperty("user", a.get(2));
        if (!a.get(3).isEmpty()) props.setProperty("password", a.get(3));
        connection = driver.connect(url, props);
        if (connection == null) throw new UnsupportedUrl();
        var m = connection.getMetaData();
        header(out, "version", "quote");
        row(out, m.getDatabaseProductName() + " " + m.getDatabaseProductVersion(), m.getIdentifierQuoteString());
    }

    static String pattern(DatabaseMetaData m, String literal) throws SQLException {
        String escape = m.getSearchStringEscape();
        if (escape == null || escape.isEmpty()) return literal;
        return literal.replace(escape, escape + escape).replace("%", escape + "%").replace("_", escape + "_");
    }

    void schemas(DataOutputStream out) throws Exception {
        var m = connection.getMetaData();
        header(out, "schema");
        Set<String> names = new TreeSet<>();
        try (ResultSet rs = m.getSchemas()) {
            while (rs.next() && names.size() < 20000) {
                String s = rs.getString("TABLE_SCHEM");
                if (s != null && !s.isEmpty()) names.add(s);
            }
        } catch (SQLFeatureNotSupportedException ignored) {}
        catalogs = names.isEmpty();
        namespaceKnown = true;
        if (catalogs) {
            try (ResultSet rs = m.getCatalogs()) {
                while (rs.next() && names.size() < 20000) {
                    String s = rs.getString(1);
                    if (s != null && !s.isEmpty()) names.add(s);
                }
            } catch (SQLFeatureNotSupportedException ignored) {}
        }
        if (names.isEmpty()) names.add("");
        for (String s : names) row(out, s);
    }

    void discoverNamespace() throws Exception {
        if (!namespaceKnown) schemas(new DataOutputStream(OutputStream.nullOutputStream()));
    }

    void metadata(String op, List<String> a, DataOutputStream out) throws Exception {
        discoverNamespace();
        var m = connection.getMetaData();
        String name = a.get(0);
        String catalog = catalogs && !name.isEmpty() ? name : connection.getCatalog();
        String schema = catalogs || name.isEmpty() ? null : pattern(m, name);
        if (op.equals("tables")) {
            header(out, "name", "kind");
            try (ResultSet rs = m.getTables(catalog, schema, "%", null)) {
                int n = 0;
                while (rs.next() && n < 20000) {
                    String type = rs.getString("TABLE_TYPE").toLowerCase(Locale.ROOT);
                    if (!Set.of("table","base table","view","materialized view","system table","local temporary","foreign table").contains(type)) continue;
                    row(out, rs.getString("TABLE_NAME"), type);
                    n++;
                }
            }
        } else {
            header(out, "name", "type", "nullable", "default", "primary");
            String table = a.get(1);
            Set<String> keys = new HashSet<>();
            try (ResultSet rs = m.getPrimaryKeys(catalog, catalogs || name.isEmpty() ? null : name, table)) {
                while (rs.next()) keys.add(rs.getString("COLUMN_NAME"));
            } catch (SQLFeatureNotSupportedException ignored) {}
            try (ResultSet rs = m.getColumns(catalog, schema, pattern(m, table), "%")) {
                int n = 0;
                while (rs.next() && n < 20000) {
                    if (!table.equals(rs.getString("TABLE_NAME"))) continue;
                    String col = rs.getString("COLUMN_NAME");
                    row(out, col, rs.getString("TYPE_NAME"), rs.getInt("NULLABLE") == 0 ? "0" : "1",
                        rs.getString("COLUMN_DEF"), keys.contains(col) ? "1" : "0");
                    n++;
                }
            }
        }
    }

    void execute(List<String> a, DataOutputStream out, boolean tablePage) throws Exception {
        long skip = Long.parseLong(a.get(1));
        int limit = Integer.parseInt(a.get(2));
        try (Statement st = connection.createStatement()) {
            long window = skip + limit + 1;
            if (tablePage && window > 0 && window <= Integer.MAX_VALUE) {
                try { st.setMaxRows((int)window); } catch (SQLException | UnsupportedOperationException ignored) {}
            }
            if (!st.execute(a.get(0))) {
                header(out);
                end(out, false, st.getUpdateCount());
                return;
            }
            try (ResultSet rs = st.getResultSet()) {
                var m = rs.getMetaData();
                int cols = m.getColumnCount();
                out.writeInt(cols);
                for (int c = 1; c <= cols; c++) { text(out, m.getColumnLabel(c)); text(out, m.getColumnTypeName(c)); }
                while (skip > 0) {
                    if (!rs.next()) { end(out, false, -1); return; }
                    skip--;
                }
                int n = 0;
                while (n < limit && rs.next()) {
                    out.writeBoolean(true);
                    for (int c = 1; c <= cols; c++) {
                        int t = m.getColumnType(c);
                        if (t == Types.BINARY || t == Types.VARBINARY || t == Types.LONGVARBINARY || t == Types.BLOB) {
                            byte[] b = rs.getBytes(c);
                            if (b != null && b.length > (LIMIT - out.size()) / 2) throw new IOException("JDBC binary value exceeds the result limit");
                            text(out, b == null ? null : "0x" + HexFormat.of().formatHex(b));
                        } else {
                            text(out, rs.getString(c));
                        }
                    }
                    n++;
                }
                end(out, n == limit && rs.next(), -1);
            }
        }
    }

    void run() throws IOException {
        System.setOut(System.err);
        for (;;) {
            int count;
            try { count = input.readInt(); } catch (EOFException eof) { return; }
            if (count < 1 || count > 8192) throw new IOException("Invalid JDBC request");
            List<String> a = new ArrayList<>();
            for (int i = 0; i < count; i++) a.add(read(input));
            var buffer = new ByteArrayOutputStream();
            var reply = new DataOutputStream(buffer);
            String op = a.remove(0);
            try {
                reply.writeBoolean(true);
                switch (op) {
                    case "open" -> open(a, reply);
                    case "schemas" -> schemas(reply);
                    case "tables", "columns" -> metadata(op, a, reply);
                    case "namespace" -> {
                        header(reply, "namespace");
                        String name = null;
                        try {
                            discoverNamespace();
                            name = catalogs ? connection.getCatalog() : connection.getSchema();
                        } catch (SQLException | AbstractMethodError ignored) {}
                        row(reply, name);
                    }
                    case "page" -> execute(a, reply, true);
                    case "query" -> {
                        if (a.size() == 3 || a.get(3).isEmpty()) {
                            execute(a, reply, false);
                        } else {
                            discoverNamespace();
                            String previous = catalogs ? connection.getCatalog() : connection.getSchema();
                            String wanted = a.get(3);
                            if (Objects.equals(previous, wanted)) {
                                execute(a, reply, false);
                            } else {
                                try {
                                    if (catalogs) connection.setCatalog(wanted); else connection.setSchema(wanted);
                                    if (!Objects.equals(wanted, catalogs ? connection.getCatalog() : connection.getSchema()))
                                        throw new SQLException("The JDBC driver cannot switch to the selected schema");
                                    execute(a, reply, false);
                                } finally {
                                    try {
                                        if (catalogs) connection.setCatalog(previous); else connection.setSchema(previous);
                                    } catch (SQLException restoreError) {
                                        connection.close();
                                        throw restoreError;
                                    }
                                }
                            }
                        }
                    }
                    default -> throw new IOException("Unknown JDBC operation");
                }
                if (!op.equals("query") && !op.equals("page")) end(reply, false, -1);
            } catch (Exception | LinkageError e) {
                buffer = new ByteArrayOutputStream();
                reply = new DataOutputStream(buffer);
                reply.writeBoolean(false);
                if ((e instanceof ClassNotFoundException || e instanceof NoClassDefFoundError)
                        && e.getMessage() != null && e.getMessage().matches("[A-Za-z0-9_.$/]+")) {
                    text(reply, "JDBC class " + e.getMessage() + " was not found. Check the driver class and include its dependency JARs.");
                } else if (e instanceof UnsupportedUrl) {
                    text(reply, "The selected JDBC driver does not accept this URL");
                } else if (op.equals("open")) {
                    // Login exceptions may contain properties or credentials embedded in a vendor URL.
                    String state = e instanceof SQLException ? ((SQLException)e).getSQLState() : null;
                    text(reply, "JDBC connection failed (" + e.getClass().getSimpleName()
                        + (state == null ? "" : ", SQLState " + state) + "). Check driver files, class, URL and credentials.");
                } else {
                    text(reply, e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
                }
            }
            output.writeInt(buffer.size());
            buffer.writeTo(output);
            output.flush();
        }
    }

    public static void main(String[] args) throws Exception {
        var bridge = new OpenIdeaJdbc();
        try { bridge.run(); }
        finally { if (bridge.connection != null) bridge.connection.close(); }
    }
}
