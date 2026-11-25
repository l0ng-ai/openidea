import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.function.BiConsumer;
import java.util.function.Consumer;
import java.util.stream.Collectors;
import java.util.stream.IntStream;
import java.util.stream.Stream;

// Ground truth for the stream resolver: random chains run by this JDK, logged by peek in time
// order, with each element's real parent. Usage: java TraceOracle.java <seed> <count>
public class TraceOracle {
    static int nextId = 0;

    static final class Item {
        final int id = nextId++;
        final int v;
        final Item from;

        Item(int v, Item from) {
            this.v = v;
            this.from = from;
        }

        // Value equality, so distinct drops equal elements the way it does for boxes.
        @Override
        public boolean equals(Object o) {
            return o instanceof Item && ((Item) o).v == v;
        }

        @Override
        public int hashCode() {
            return v;
        }
    }

    static final class Rec {
        final int stage;
        final Item item;

        Rec(int stage, Item item) {
            this.stage = stage;
            this.item = item;
        }
    }

    // Stream.mapMulti exists from JDK 16; called reflectively so the file still runs on 11.
    static final Method MAP_MULTI = findMapMulti();

    static Method findMapMulti() {
        try {
            return Stream.class.getMethod("mapMulti", BiConsumer.class);
        } catch (NoSuchMethodException e) {
            return null;
        }
    }

    static final String[] VARIANTS = {"map", "filter", "filterStateful", "flatMap", "mapMulti", "skip", "limit",
            "distinct", "sorted", "sortedDesc", "sortedByKey", "takeWhile", "dropWhile", "peek"};

    static String method(String variant) {
        if (variant.startsWith("sorted")) return "sorted";
        if (variant.equals("filterStateful")) return "filter";
        return variant;
    }

    static boolean creates(String variant) {
        return variant.equals("map") || variant.equals("flatMap") || variant.equals("mapMulti");
    }

    final int low;
    final int range;

    TraceOracle(int low, int range) {
        this.low = low;
        this.range = range;
    }

    int wrap(int x) {
        return low + Math.floorMod(x - low, range);
    }

    @SuppressWarnings("unchecked")
    Stream<Item> apply(Stream<Item> s, String variant, int a) {
        switch (variant) {
            case "map":
                return s.map(t -> new Item(wrap(t.v * 7 + a), t));
            case "filter":
                return s.filter(t -> Math.floorMod(t.v, 2) == 0);
            case "filterStateful": {
                int[] seen = {0};
                return s.filter(t -> seen[0]++ % 2 == 1);
            }
            case "flatMap":
                return s.flatMap(t -> IntStream.range(0, Math.floorMod(t.v, 3)).mapToObj(i -> new Item(wrap(t.v + i), t)));
            case "mapMulti": {
                BiConsumer<Item, Consumer<Item>> expand = (t, sink) -> {
                    for (int i = 0; i < Math.floorMod(t.v, 3); i++) sink.accept(new Item(wrap(t.v - i), t));
                };
                try {
                    return (Stream<Item>) MAP_MULTI.invoke(s, expand);
                } catch (IllegalAccessException | InvocationTargetException e) {
                    throw new IllegalStateException(e);
                }
            }
            case "skip":
                return s.skip(a % 3);
            case "limit":
                return s.limit(a % 5 + 1);
            case "distinct":
                return s.distinct();
            case "sorted":
                return s.sorted(Comparator.comparingInt(t -> t.v));
            case "sortedDesc":
                return s.sorted(Comparator.comparingInt((Item t) -> t.v).reversed());
            case "sortedByKey":
                return s.sorted(Comparator.comparingInt(t -> Math.floorMod(t.v, 3)));
            case "takeWhile":
                return s.takeWhile(t -> t.v < low + range / 2);
            case "dropWhile":
                return s.dropWhile(t -> t.v < low + range / 3);
            default:
                return s.peek(t -> {});
        }
    }

    public static void main(String[] args) {
        Random rnd = new Random(Long.parseLong(args[0]));
        int count = Integer.parseInt(args[1]);
        List<String> pool = new ArrayList<>();
        for (String v : VARIANTS) {
            if (MAP_MULTI != null || !v.equals("mapMulti")) pool.add(v);
        }
        StringBuilder out = new StringBuilder();
        for (int c = 0; c < count; c++) {
            // Small values hit the Integer cache (-128..127), large ones cross its edge.
            TraceOracle chain = rnd.nextBoolean() ? new TraceOracle(-1, 7) : new TraceOracle(-150, 601);
            int n = rnd.nextInt(10);
            List<Item> source = new ArrayList<>();
            for (int i = 0; i < n; i++) source.add(new Item(chain.low + rnd.nextInt(chain.range), null));
            String[] ops = new String[1 + rnd.nextInt(4)];
            for (int i = 0; i < ops.length; i++) ops[i] = pool.get(rnd.nextInt(pool.size()));

            List<Rec> log = new ArrayList<>();
            Stream<Item> s = source.stream().peek(t -> log.add(new Rec(0, t)));
            for (int i = 0; i < ops.length; i++) {
                int stage = i + 1;
                s = chain.apply(s, ops[i], rnd.nextInt(10)).peek(t -> log.add(new Rec(stage, t)));
            }
            s.collect(Collectors.toList());

            List<Map<Item, Integer>> seen = new ArrayList<>();
            for (int i = 0; i <= ops.length; i++) seen.add(new IdentityHashMap<>());
            out.append("{\"ops\":[");
            for (int i = 0; i < ops.length; i++) out.append(i > 0 ? "," : "").append('"').append(method(ops[i])).append('"');
            out.append("],\"records\":[");
            for (int i = 0; i < log.size(); i++) {
                Rec r = log.get(i);
                out.append(i > 0 ? "," : "").append('[').append(r.stage).append(',').append(r.item.id).append(',')
                        .append(r.item.v).append(']');
            }
            out.append("],\"truth\":[");
            for (int i = 0; i < log.size(); i++) {
                Rec r = log.get(i);
                int parent = -1;
                if (r.stage > 0) {
                    Item want = creates(ops[r.stage - 1]) ? r.item.from : r.item;
                    Integer found = seen.get(r.stage - 1).get(want);
                    if (found == null) throw new IllegalStateException("parent not logged before chain " + c);
                    parent = found;
                }
                seen.get(r.stage).put(r.item, i);
                out.append(i > 0 ? "," : "").append(parent);
            }
            out.append("]}\n");
        }
        System.out.print(out);
    }
}
