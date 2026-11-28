package ai.openidea.jdbc;

import java.io.*;
import java.util.Arrays;
import java.util.Objects;
import java.util.concurrent.Semaphore;

/** Small replies have their own bounded buffer. Only one large reply is encoded at a time. */
final class ReplyBuffer extends ByteArrayOutputStream {
    private static final int SMALL = 64 * 1024;
    private static final String BUDGET_ERROR =
        "JDBC result exceeds the concurrent reply budget. Select fewer or smaller values.";
    private final Semaphore budget;
    private boolean reserved;

    ReplyBuffer(Semaphore budget) { this.budget = budget; }

    private static final class Writer extends DataOutputStream {
        final ReplyBuffer buffer;
        Writer(ReplyBuffer buffer) {
            super(buffer);
            this.buffer = buffer;
        }
    }

    static DataOutputStream writer(ByteArrayOutputStream buffer) {
        return buffer instanceof ReplyBuffer bounded ? new Writer(bounded) : new DataOutputStream(buffer);
    }

    static void beforeEncoding(DataOutputStream output, int bound) {
        if (output instanceof Writer writer) {
            // A field this size may already own a large value from the driver. Do not
            // retain it while waiting behind another large frame.
            writer.buffer.reserve((long) writer.buffer.count + bound, bound <= SMALL);
        }
    }

    private void reserve(long size, boolean wait) {
        if (reserved || size <= SMALL) return;
        try {
            if (wait) budget.acquire();
            else if (!budget.tryAcquire()) throw new UncheckedIOException(new IOException(BUDGET_ERROR));
            reserved = true;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new UncheckedIOException(new IOException("JDBC reply interrupted", e));
        }
    }

    private void grow(int extra) {
        if (extra > OpenIdeaJdbc.LIMIT - count)
            throw new UncheckedIOException(new IOException("JDBC result exceeds 16 MiB"));
        int needed = count + extra;
        reserve(needed, true);
        if (needed > buf.length) {
            int limit = reserved ? OpenIdeaJdbc.LIMIT : SMALL;
            buf = Arrays.copyOf(buf, Math.min(limit, Math.max(needed, buf.length * 2)));
        }
    }

    @Override public synchronized void write(int value) {
        grow(1);
        buf[count++] = (byte) value;
    }

    @Override public synchronized void write(byte[] data, int offset, int size) {
        Objects.checkFromIndexSize(offset, size, data.length);
        grow(size);
        System.arraycopy(data, offset, buf, count, size);
        count += size;
    }

    @Override public synchronized void reset() {
        super.reset();
        if (reserved) {
            buf = new byte[32];
            reserved = false;
            budget.release();
        }
    }

    @Override public void close() { reset(); }
}
