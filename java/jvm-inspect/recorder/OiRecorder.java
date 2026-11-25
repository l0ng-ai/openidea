import java.util.Arrays;
import java.util.function.Consumer;
import java.util.function.DoubleConsumer;
import java.util.function.IntConsumer;
import java.util.function.LongConsumer;

/**
 * Defined in the debuggee by the bundle (no package, Java 8 bytecode, nothing but the JDK) and passed
 * to {@code peek} of each traced step. One instance is the log; each step gets an instance that
 * appends {@code (step, value)} to it. A record's index in the log is its time.
 *
 * <p>The bundle reads and writes the public fields by name through JDI and calls the two
 * constructors by signature; renaming any of them breaks the trace.
 */
public final class OiRecorder implements Consumer<Object>, IntConsumer, LongConsumer, DoubleConsumer {
    public Object[] values;
    public int[] steps;
    public int size;
    /** Lowered to {@code size} by "stop recording" while the terminal runs, so {@code size} may exceed it. */
    public int budget;
    /** A long: an endless stream drops past {@code Integer.MAX_VALUE} within seconds. */
    public long dropped;
    private final OiRecorder log;
    private final int step;

    public OiRecorder(int budget) {
        this.budget = budget;
        int capacity = Math.max(0, Math.min(budget, 256));
        this.values = new Object[capacity];
        this.steps = new int[capacity];
        this.log = this;
        this.step = -1;
    }

    public OiRecorder(OiRecorder log, int step) {
        this.log = log;
        this.step = step;
    }

    /** Never throws: a real run must not fail because of the trace. */
    synchronized void add(int s, Object v) {
        try {
            if (size >= budget) {
                dropped++;
                return;
            }
            if (size == values.length) {
                int capacity = (int) Math.min((long) budget, Math.max(16L, size * 2L));
                values = Arrays.copyOf(values, capacity);
                steps = Arrays.copyOf(steps, capacity);
            }
            values[size] = v;
            steps[size] = s;
            size++;
        } catch (OutOfMemoryError e) {
            // Not Throwable: the cancel exception that abort throws into the thread must get through.
            dropped++;
        }
    }

    public void accept(Object v) {
        log.add(step, v);
    }

    public void accept(int v) {
        log.add(step, Integer.valueOf(v));
    }

    public void accept(long v) {
        log.add(step, Long.valueOf(v));
    }

    public void accept(double v) {
        log.add(step, Double.valueOf(v));
    }
}
