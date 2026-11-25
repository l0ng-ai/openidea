package ai.openidea.javac;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.net.URI;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import javax.tools.Diagnostic;
import javax.tools.DiagnosticListener;
import javax.tools.FileObject;
import javax.tools.ForwardingJavaFileManager;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileManager;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.StandardLocation;
import javax.tools.ToolProvider;

/**
 * A resident javac for the IDE's Java build: one JVM per JDK, compiling requests one at a
 * time with the JDK's own compiler, in process, annotation processors included.
 *
 * <p>Protocol: one JSON object per line. Requests on stdin:
 * {@code {"id":1,"op":"compile","options":[...],"sources":[...],"encoding":"UTF-8"}},
 * {@code {"op":"cancel","id":1}}, {@code {"op":"exit"}}. Replies on stdout, all carrying the
 * request {@code id}: {@code diagnostic} (severity, path, 1-based line, UTF-16 column and end,
 * code, message), {@code output} (a class or resource file written, with the source it came
 * from), {@code generated} (a source an annotation processor wrote), {@code output-text}
 * (javac's own printed text), then one {@code done} (success, cancelled).
 */
public final class Server {
    private static final Object OUT_LOCK = new Object();
    private static PrintWriter out;

    public static void main(String[] args) throws IOException {
        out = new PrintWriter(new OutputStreamWriter(System.out, StandardCharsets.UTF_8), false);
        // Anything else printing to stdout would break the protocol.
        System.setOut(System.err);
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        if (compiler == null) {
            send("{\"kind\":\"fatal\",\"message\":" + Json.quote("This Java runtime has no compiler (a JRE, not a JDK)") + "}");
            System.exit(2);
        }
        send("{\"kind\":\"ready\",\"version\":" + Json.quote(System.getProperty("java.version")) + "}");
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        final AtomicReference<Request> running = new AtomicReference<>();
        final java.util.concurrent.BlockingQueue<Request> queue = new java.util.concurrent.LinkedBlockingQueue<>();
        Thread worker = new Thread(() -> {
            while (true) {
                Request request;
                try {
                    request = queue.take();
                } catch (InterruptedException e) {
                    return;
                }
                if (request.exit) return;
                running.set(request);
                try {
                    compile(compiler, request);
                } catch (Throwable t) {
                    StringWriter trace = new StringWriter();
                    t.printStackTrace(new PrintWriter(trace));
                    send("{\"id\":" + request.id + ",\"kind\":\"diagnostic\",\"severity\":\"error\",\"message\":"
                        + Json.quote("javac crashed: " + trace) + "}");
                    send("{\"id\":" + request.id + ",\"kind\":\"done\",\"success\":false,\"cancelled\":false}");
                } finally {
                    running.set(null);
                }
            }
        }, "javac");
        worker.start();
        String line;
        while ((line = in.readLine()) != null) {
            if (line.trim().isEmpty()) continue;
            Map<String, Object> message;
            try {
                message = Json.parseObject(line);
            } catch (RuntimeException e) {
                send("{\"kind\":\"fatal\",\"message\":" + Json.quote("Bad request: " + e.getMessage()) + "}");
                continue;
            }
            String op = (String) message.get("op");
            if ("cancel".equals(op)) {
                Request current = running.get();
                long id = ((Number) message.get("id")).longValue();
                if (current != null && current.id == id) current.cancelled = true;
                for (Request queued : queue) if (queued.id == id) queued.cancelled = true;
            } else if ("exit".equals(op)) {
                break;
            } else if ("compile".equals(op)) {
                queue.add(Request.of(message));
            }
        }
        Request exit = new Request();
        exit.exit = true;
        // Requests already sent finish first; the host cancels the ones it no longer wants.
        queue.add(exit);
        try {
            worker.join();
        } catch (InterruptedException ignored) {
        }
        System.exit(0);
    }

    static void send(String json) {
        synchronized (OUT_LOCK) {
            out.print(json);
            out.print('\n');
            out.flush();
        }
    }

    static final class Request {
        long id;
        List<String> options = new ArrayList<>();
        List<String> sources = new ArrayList<>();
        String encoding;
        volatile boolean cancelled;
        boolean exit;

        @SuppressWarnings("unchecked")
        static Request of(Map<String, Object> message) {
            Request r = new Request();
            r.id = ((Number) message.get("id")).longValue();
            Object options = message.get("options");
            if (options != null) for (Object o : (List<Object>) options) r.options.add((String) o);
            Object sources = message.get("sources");
            if (sources != null) for (Object o : (List<Object>) sources) r.sources.add((String) o);
            r.encoding = (String) message.get("encoding");
            return r;
        }
    }

    /** Thrown from the task listener to stop a cancelled compilation. */
    static final class Cancelled extends RuntimeException {
        private static final long serialVersionUID = 1L;

        Cancelled() {
            super("cancelled", null, false, false);
        }
    }

    private static void compile(JavaCompiler compiler, final Request request) throws IOException {
        final long id = request.id;
        if (request.cancelled) {
            send("{\"id\":" + id + ",\"kind\":\"done\",\"success\":false,\"cancelled\":true}");
            return;
        }
        Charset charset = request.encoding == null ? StandardCharsets.UTF_8 : Charset.forName(request.encoding);
        final int[] errors = {0};
        DiagnosticListener<JavaFileObject> diagnostics = d -> {
            if (d.getKind() == Diagnostic.Kind.ERROR) errors[0]++;
            send(diagnostic(id, d));
        };
        StandardJavaFileManager standard = compiler.getStandardFileManager(diagnostics, Locale.ROOT, charset);
        JavaFileManager manager = new Recording(standard, id);
        List<File> files = new ArrayList<>();
        for (String source : request.sources) files.add(new File(source));
        Iterable<? extends JavaFileObject> units = standard.getJavaFileObjectsFromFiles(files);
        StringWriter printed = new StringWriter();
        boolean success = false;
        boolean cancelled = false;
        try {
            JavaCompiler.CompilationTask task =
                compiler.getTask(printed, manager, diagnostics, request.options, null, units);
            stopWhenCancelled(task, request);
            success = Boolean.TRUE.equals(task.call()) && errors[0] == 0;
        } catch (RuntimeException e) {
            if (isCancelled(e)) {
                cancelled = true;
            } else if (e instanceof IllegalArgumentException) {
                // An option javac doesn't know (a newer --release than this JDK has).
                send("{\"id\":" + id + ",\"kind\":\"diagnostic\",\"severity\":\"error\",\"message\":"
                    + Json.quote(e.getMessage()) + "}");
            } else {
                throw e;
            }
        } finally {
            try {
                manager.close();
            } catch (IOException ignored) {
            }
        }
        String text = printed.toString();
        if (!text.isEmpty()) send("{\"id\":" + id + ",\"kind\":\"output-text\",\"text\":" + Json.quote(text) + "}");
        send("{\"id\":" + id + ",\"kind\":\"done\",\"success\":" + success + ",\"cancelled\":" + cancelled + "}");
    }

    /**
     * Stops the compilation at its next phase once {@code request} is cancelled, through
     * {@code com.sun.source.util.TaskListener} (reflectively: Java 8's {@code --release} API has no
     * {@code jdk.compiler}).
     */
    private static void stopWhenCancelled(JavaCompiler.CompilationTask task, final Request request) {
        try {
            Class<?> listener = Class.forName("com.sun.source.util.TaskListener", false, task.getClass().getClassLoader());
            Object proxy = java.lang.reflect.Proxy.newProxyInstance(listener.getClassLoader(), new Class<?>[] {listener},
                (self, method, args) -> {
                    if (method.getDeclaringClass() == Object.class) {
                        switch (method.getName()) {
                            case "hashCode": return System.identityHashCode(self);
                            case "equals": return self == args[0];
                            default: return "cancellation listener";
                        }
                    }
                    if (request.cancelled) throw new Cancelled();
                    return null;
                });
            task.getClass().getMethod("addTaskListener", listener).invoke(task, proxy);
        } catch (ReflectiveOperationException | RuntimeException e) {
            // Not javac's task: cancellation then waits for the compilation to end.
        }
    }

    private static boolean isCancelled(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause()) if (t instanceof Cancelled) return true;
        return false;
    }

    private static String diagnostic(long id, Diagnostic<? extends JavaFileObject> d) {
        StringBuilder json = new StringBuilder("{\"id\":").append(id).append(",\"kind\":\"diagnostic\",\"severity\":");
        String severity;
        switch (d.getKind()) {
            case ERROR: severity = "error"; break;
            case WARNING:
            case MANDATORY_WARNING: severity = "warning"; break;
            default: severity = "info";
        }
        json.append(Json.quote(severity));
        JavaFileObject source = d.getSource();
        if (source != null) {
            json.append(",\"path\":").append(Json.quote(path(source.toUri())));
            long start = d.getStartPosition();
            long end = d.getEndPosition();
            int[] startCol = start >= 0 ? lineColumn(source, start) : null;
            int[] endCol = end >= 0 ? lineColumn(source, end) : null;
            if (startCol != null) json.append(",\"line\":").append(startCol[0]).append(",\"column\":").append(startCol[1]);
            else if (d.getLineNumber() > 0) json.append(",\"line\":").append(d.getLineNumber());
            if (endCol != null) json.append(",\"endLine\":").append(endCol[0]).append(",\"endColumn\":").append(endCol[1]);
        }
        if (d.getCode() != null) json.append(",\"code\":").append(Json.quote(d.getCode()));
        json.append(",\"message\":").append(Json.quote(d.getMessage(Locale.ROOT)));
        return json.append('}').toString();
    }

    /** 1-based line and 0-based UTF-16 column of a char offset (Java chars are UTF-16 units). */
    private static int[] lineColumn(JavaFileObject source, long offset) {
        CharSequence text;
        try {
            text = source.getCharContent(true);
        } catch (IOException | RuntimeException e) {
            return null;
        }
        if (offset > text.length()) return null;
        int line = 1;
        int lineStart = 0;
        for (int i = 0; i < offset; i++) {
            char c = text.charAt(i);
            if (c == '\n' || (c == '\r' && (i + 1 >= text.length() || text.charAt(i + 1) != '\n'))) {
                line++;
                lineStart = i + 1;
            }
        }
        return new int[] {line, (int) offset - lineStart};
    }

    static String path(URI uri) {
        if ("file".equals(uri.getScheme())) return new File(uri).getPath();
        return uri.toString();
    }

    /** Reports every file the compiler writes and the source it came from. */
    static final class Recording extends ForwardingJavaFileManager<JavaFileManager> {
        private final long id;

        Recording(JavaFileManager manager, long id) {
            super(manager);
            this.id = id;
        }

        @Override
        public JavaFileObject getJavaFileForOutput(Location location, String className, JavaFileObject.Kind kind,
                                                   FileObject sibling) throws IOException {
            JavaFileObject file = super.getJavaFileForOutput(location, className, kind, sibling);
            report(location, file, sibling, kind == JavaFileObject.Kind.SOURCE);
            return file;
        }

        @Override
        public FileObject getFileForOutput(Location location, String packageName, String relativeName,
                                           FileObject sibling) throws IOException {
            FileObject file = super.getFileForOutput(location, packageName, relativeName, sibling);
            report(location, file, sibling, location == StandardLocation.SOURCE_OUTPUT);
            return file;
        }

        private void report(Location location, FileObject file, FileObject sibling, boolean generatedSource) {
            StringBuilder json = new StringBuilder("{\"id\":").append(id).append(",\"kind\":")
                .append(Json.quote(generatedSource ? "generated" : "output"))
                .append(",\"path\":").append(Json.quote(path(file.toUri())));
            if (sibling != null && sibling.toUri().getScheme() != null)
                json.append(",\"source\":").append(Json.quote(path(sibling.toUri())));
            json.append(",\"location\":").append(Json.quote(location.getName()));
            send(json.append('}').toString());
        }
    }

    /** Just enough JSON for the protocol: objects, arrays, strings, numbers, booleans, null. */
    static final class Json {
        private final String text;
        private int at;

        private Json(String text) {
            this.text = text;
        }

        @SuppressWarnings("unchecked")
        static Map<String, Object> parseObject(String text) {
            Json json = new Json(text);
            Object value = json.value();
            json.space();
            if (!(value instanceof Map) || json.at != text.length()) throw new IllegalArgumentException("not one JSON object");
            return (Map<String, Object>) value;
        }

        static String quote(String s) {
            if (s == null) return "null";
            StringBuilder b = new StringBuilder(s.length() + 2).append('"');
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                switch (c) {
                    case '"': b.append("\\\""); break;
                    case '\\': b.append("\\\\"); break;
                    case '\n': b.append("\\n"); break;
                    case '\r': b.append("\\r"); break;
                    case '\t': b.append("\\t"); break;
                    default:
                        if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                        else b.append(c);
                }
            }
            return b.append('"').toString();
        }

        private void space() {
            while (at < text.length() && Character.isWhitespace(text.charAt(at))) at++;
        }

        private char peek() {
            space();
            if (at >= text.length()) throw new IllegalArgumentException("unexpected end");
            return text.charAt(at);
        }

        private void expect(char c) {
            if (peek() != c) throw new IllegalArgumentException("expected '" + c + "' at " + at);
            at++;
        }

        private Object value() {
            char c = peek();
            if (c == '{') {
                at++;
                Map<String, Object> map = new java.util.LinkedHashMap<>();
                if (peek() == '}') {
                    at++;
                    return map;
                }
                while (true) {
                    String key = string();
                    expect(':');
                    map.put(key, value());
                    if (peek() == ',') {
                        at++;
                        continue;
                    }
                    expect('}');
                    return map;
                }
            }
            if (c == '[') {
                at++;
                List<Object> list = new ArrayList<>();
                if (peek() == ']') {
                    at++;
                    return list;
                }
                while (true) {
                    list.add(value());
                    if (peek() == ',') {
                        at++;
                        continue;
                    }
                    expect(']');
                    return list;
                }
            }
            if (c == '"') return string();
            if (text.startsWith("true", at)) {
                at += 4;
                return Boolean.TRUE;
            }
            if (text.startsWith("false", at)) {
                at += 5;
                return Boolean.FALSE;
            }
            if (text.startsWith("null", at)) {
                at += 4;
                return null;
            }
            int start = at;
            while (at < text.length() && "+-0123456789.eE".indexOf(text.charAt(at)) >= 0) at++;
            if (start == at) throw new IllegalArgumentException("unexpected '" + c + "' at " + at);
            String number = text.substring(start, at);
            return number.contains(".") || number.contains("e") || number.contains("E")
                ? (Object) Double.parseDouble(number) : (Object) Long.parseLong(number);
        }

        private String string() {
            expect('"');
            StringBuilder b = new StringBuilder();
            while (true) {
                if (at >= text.length()) throw new IllegalArgumentException("unterminated string");
                char c = text.charAt(at++);
                if (c == '"') return b.toString();
                if (c != '\\') {
                    b.append(c);
                    continue;
                }
                char e = text.charAt(at++);
                switch (e) {
                    case 'n': b.append('\n'); break;
                    case 'r': b.append('\r'); break;
                    case 't': b.append('\t'); break;
                    case 'b': b.append('\b'); break;
                    case 'f': b.append('\f'); break;
                    case 'u':
                        b.append((char) Integer.parseInt(text.substring(at, at + 4), 16));
                        at += 4;
                        break;
                    default: b.append(e);
                }
            }
        }
    }

    private Server() {
    }
}
