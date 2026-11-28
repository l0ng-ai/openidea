package ai.openidea.jdbc;

import java.io.*;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.List;
import java.util.Set;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Opt-in framing: request ID, connection ID and field count, then the legacy fields.
 * Replies carry the request ID before the legacy length and payload. Zero fields
 * requests cancellation, and a reply with zero length acknowledges it.
 */
final class MultiplexBridge {
    private static final int SERVICE = 0;
    // The service/shared session and closing drivers occupy slots as well.
    private static final int MAX_CONNECTIONS = 32;
    private static final int REQUEST_HEADER = Long.BYTES + 2 * Integer.BYTES;
    private static final long CLOSE_GRACE = TimeUnit.MILLISECONDS.toNanos(1500);

    private final DataInputStream input;
    private final DataOutputStream output;
    private final ConcurrentMap<Integer, Session> sessions = new ConcurrentHashMap<>();
    // Closing drivers still count towards the cap until their Connection.close returns.
    private final Set<Session> live = ConcurrentHashMap.newKeySet();
    // Reserve before large writes and encodings, not while JDBC executes. This keeps
    // frame copies and encoding temporaries within the 192 MiB JVM's headroom.
    private final Semaphore largeReplies = new Semaphore(1, true);
    private volatile List<String> settings;
    private final AtomicBoolean stopping = new AtomicBoolean();

    MultiplexBridge(DataInputStream input, DataOutputStream output) {
        this.input = input;
        this.output = output;
    }

    private static ThreadFactory daemon(String name) {
        return action -> {
            var thread = new Thread(action, name);
            thread.setDaemon(true);
            return thread;
        };
    }

    private static final class Session {
        final int id;
        final OpenIdeaJdbc jdbc = new OpenIdeaJdbc();
        final AtomicReference<OpenIdeaJdbc.Work> active = new AtomicReference<>();
        final ExecutorService worker = Executors.newSingleThreadExecutor(daemon("jdbc-session"));
        // A driver may hold Statement.cancel indefinitely. Keep it off the reader and
        // confine the outstanding calls to this connection.
        final ExecutorService canceller = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS,
            new ArrayBlockingQueue<>(1), daemon("jdbc-cancel"), new ThreadPoolExecutor.DiscardPolicy());

        Session(int id) { this.id = id; }

        void cancel(OpenIdeaJdbc.Work work) {
            var statement = work.requestCancel();
            if (statement != null) canceller.execute(() -> OpenIdeaJdbc.Work.cancelStatement(statement));
        }
    }

    private void send(long id, ByteArrayOutputStream payload) throws IOException {
        synchronized (output) {
            if (stopping.get()) return;
            output.writeLong(id);
            OpenIdeaJdbc.send(output, payload);
        }
    }

    private static ByteArrayOutputStream status(String error) throws IOException {
        var bytes = new ByteArrayOutputStream();
        var result = new DataOutputStream(bytes);
        result.writeBoolean(error == null);
        if (error == null) {
            OpenIdeaJdbc.header(result);
            OpenIdeaJdbc.end(result, false, -1);
        } else {
            OpenIdeaJdbc.text(result, error);
        }
        return bytes;
    }

    private void retire(Session session) {
        if (session == null || !sessions.remove(session.id, session)) return;
        var work = session.active.get();
        if (work != null) session.cancel(work);
        session.worker.execute(() -> {
            try { session.jdbc.close(); }
            catch (SQLException | RuntimeException ignored) {}
            finally { live.remove(session); }
        });
        session.worker.shutdown();
        session.canceller.shutdown();
    }

    private Connection connect(List<String> options) throws Exception {
        if (!options.get(0).equals("org.duckdb.DuckDBDriver")) return OpenIdeaJdbc.connect(options);
        // A second DuckDB login would create a different unnamed in-memory database.
        // Call duplicate on the service worker so it never races another operation
        // on the same JDBC Connection.
        Session service = sessions.get(SERVICE);
        if (service == null) throw new SQLException("The DuckDB service connection is unavailable");
        return service.worker.submit(() -> {
            Connection source = service.jdbc.connection;
            return (Connection) source.getClass().getMethod("duplicate").invoke(source);
        }).get();
    }

    private synchronized void request(long id, int connection, List<String> fields) throws IOException {
        if (stopping.get()) return;
        String op = fields.get(0);
        Session session = sessions.get(connection);
        if (op.equals("close")) {
            if (connection == SERVICE || fields.size() != 1) {
                send(id, status("Invalid JDBC console close request"));
            } else {
                retire(session); // Retire the ID before acknowledging, even if the driver is busy.
                send(id, status(null));
            }
            return;
        }

        boolean open = op.equals("open");
        List<String> options = settings;
        if (open) {
            boolean valid = connection == SERVICE
                ? fields.size() >= 6 && fields.size() % 2 == 0
                : fields.size() == 1 && options != null;
            if (!valid || session != null) {
                send(id, status("Invalid JDBC connection open request"));
                return;
            }
            if (live.size() >= MAX_CONNECTIONS) {
                send(id, status("JDBC connection limit reached. Close a console or wait for its connection to finish closing, then try again."));
                return;
            }
            if (connection == SERVICE) options = List.copyOf(fields.subList(1, fields.size()));
            session = new Session(connection);
            sessions.put(connection, session);
            live.add(session);
        } else if (session == null) {
            send(id, status("JDBC connection is closed"));
            return;
        }

        var work = new OpenIdeaJdbc.Work(id);
        if (!session.active.compareAndSet(null, work)) {
            send(id, status("The JDBC connection is already executing a request"));
            return;
        }
        try {
            schedule(session, work, fields, open, options);
        } catch (RejectedExecutionException closed) {
            session.active.compareAndSet(work, null);
            send(id, status("JDBC connection is closed"));
        }
    }

    private void schedule(Session session, OpenIdeaJdbc.Work work, List<String> fields,
                          boolean open, List<String> options) {
        session.worker.execute(() -> {
            try (var buffer = new ReplyBuffer(largeReplies)) {
                var answer = session.jdbc.reply(work, fields,
                    args -> session.id == SERVICE ? OpenIdeaJdbc.connect(args) : connect(options), buffer);
                if (open) {
                    if (session.jdbc.connection == null) retire(session);
                    else if (session.id == SERVICE) settings = options;
                }
                session.active.compareAndSet(work, null);
                send(work.id, answer);
            } catch (Throwable fatal) {
                abort();
            }
        });
    }

    private void abort() {
        if (!stopping.compareAndSet(false, true)) return;
        // The reader may be blocked on stdin and the worker cannot join itself.
        var closer = new Thread(() -> {
            try { closeSessions(); }
            finally { Runtime.getRuntime().halt(1); }
        }, "jdbc-broken-pipe");
        closer.setDaemon(false);
        closer.start();
    }

    private void closeSessions() {
        List<Session> remaining;
        synchronized (this) { remaining = List.copyOf(live); }
        for (Session session : remaining) retire(session);
        long deadline = System.nanoTime() + CLOSE_GRACE;
        for (Session session : remaining) {
            long wait = deadline - System.nanoTime();
            if (wait <= 0) break;
            try { session.worker.awaitTermination(wait, TimeUnit.NANOSECONDS); }
            catch (InterruptedException e) { Thread.currentThread().interrupt(); break; }
        }
    }

    void run() throws IOException {
        try {
            while (!stopping.get()) {
                long id;
                try { id = input.readLong(); } catch (EOFException eof) { return; }
                int connection = input.readInt();
                int count = input.readInt();
                if (count == 0) {
                    Session session = sessions.get(connection);
                    var work = session == null ? null : session.active.get();
                    if (work != null && work.id == id) session.cancel(work);
                    send(id, null);
                } else {
                    request(id, connection, OpenIdeaJdbc.readFields(input, count, REQUEST_HEADER));
                }
            }
        } finally {
            if (stopping.compareAndSet(false, true)) closeSessions();
        }
    }
}
