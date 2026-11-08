package ai.openidea.jvminspect;

import java.util.HashMap;
import java.util.Map;

/**
 * The objects of one VM that the bundle has handed out, by JDWP id. An id is valid only within the
 * stop ({@code generation}) it was returned in.
 */
final class Handles<T> {
    static final int MAX = 100_000;

    static final class Stale extends Exception {
        private static final long serialVersionUID = 1L;

        Stale(long id) {
            super("object " + id + " is not from this stop");
        }
    }

    private final Map<Long, T> objects = new HashMap<>();
    private Long generation;

    /**
     * Starts a command. A new generation, or a table over {@link #MAX}, starts an empty table; the
     * limit is checked here so that one command's own objects never go stale while it runs.
     */
    void begin(long generation) {
        if (this.generation == null || this.generation != generation || objects.size() > MAX) objects.clear();
        this.generation = generation;
    }

    void put(long id, T object) {
        objects.put(id, object);
    }

    T get(long id) throws Stale {
        T object = objects.get(id);
        if (object == null) throw new Stale(id);
        return object;
    }
}
