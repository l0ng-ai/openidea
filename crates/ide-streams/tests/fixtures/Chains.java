package demo;

import java.util.*;
import java.util.stream.*;
import static java.util.stream.Collectors.toList;

public class Chains {
    private static final int LIMIT = 3;
    static final List<Integer> NUMS = List.of(1, 2, 3);
    static final List<Integer> DOUBLED = NUMS.stream().map(x -> x * 2).toList(); // C_FIELD_INIT
    final long countAll = NUMS.stream().count(); // C_INSTANCE_FIELD
    int stride = 2;

    static {
        long c = NUMS.stream().count(); // C_STATIC_INIT
    }

    {
        long c = NUMS.stream().filter(x -> x > 1).count(); // C_INSTANCE_INIT
    }

    List<Integer> collectors(List<Integer> nums) {
        List<Integer> a = nums.stream().filter(x -> x % 2 == 0).map(x -> x * LIMIT).collect(Collectors.toList()); // C_NEW
        List<Integer> b = nums.stream().map(x -> x + 1).collect(toList()); // C_STATIC_IMPORT
        int o = Optional.of(1).map(x -> x + 1).filter(x -> x > 0).orElse(0); // C_OPTIONAL
        a.addAll(b);
        return a;
    }

    long roots(Stream<String> given, List<Integer> nums, Repository repo) {
        long n = given.filter(s -> !s.isEmpty()).count(); // C_VARIABLE
        int sq = IntStream.range(0, 10).map(i -> i * i).sum(); // C_INT
        Iterator<Integer> it = nums.stream().map(x -> x + 1).iterator(); // C_ITERATOR
        long r = repo.findAll().filter(x -> x > 0).count(); // C_FOREIGN_ROOT
        long u = nums.stream().map(x -> x).mapToEntry(x -> x).count(); // C_UNKNOWN_OP
        return n + sq + r + u;
    }

    static int next(int x) {
        return x + 1;
    }

    int bump(int x) {
        return x + stride;
    }

    void sources(List<Integer> nums, java.io.BufferedReader reader, int step) {
        List<Integer> p = nums.parallelStream().sequential().map(x -> x).parallel().toList(); // C_PARALLEL
        List<Double> g = Stream.generate(Math::random).limit(3).toList(); // C_GENERATE
        List<Integer> i1 = Stream.iterate(1, Chains::next).limit(3).toList(); // C_ITERATE_REF
        List<Integer> i2 = Stream.iterate(1, x -> x + step).limit(3).toList(); // C_ITERATE_CAPTURE
        List<Integer> i3 = Stream.iterate(1, x -> x * 2).limit(3).toList(); // C_ITERATE_PURE
        List<Integer> i4 = Stream.iterate(1, x -> x + this.stride).limit(3).toList(); // C_ITERATE_THIS_FIELD
        List<Integer> i5 = Stream.iterate(1, x -> this.bump(x)).limit(3).toList(); // C_ITERATE_THIS_CALL
        List<Integer> i6 = Stream.iterate(1, x -> { int y = x * 2; return y; }).limit(3).toList(); // C_ITERATE_BLOCK_LOCAL
        long l1 = reader.lines().count(); // C_LINES
        long l2 = "a\nb".lines().count(); // C_LINES_LITERAL
    }

    void shapes(List<Integer> nums, List<Integer> xs, List<Integer> ys) {
        List<Integer> m = nums.stream()
                .map(x -> x * 2)
                .filter(y -> y > 0) // C_MULTI
                .collect(Collectors.toList());
        List<Integer> k = nums.stream().map(x -> {
            int y = x * 2;
            return y + LIMIT; // C_IN_LAMBDA
        }).collect(Collectors.toList());
        List<Long> inner = xs.stream().map(x -> ys.stream().filter(y -> y < x).count()).toList(); // C_INNER
        long a1 = xs.stream().count(), a2 = ys.stream().filter(y -> y > 0).count(); // C_TWO
        nums.stream().forEach(x -> System.out.println(x)); // C_FOREACH
        var s = nums.stream().map(x -> x); // C_NO_TERMINAL
        String t = "é😀"; long c = nums.stream().count(); // C_UTF16
    }

    void idioms(List<Integer> nums, java.io.BufferedReader reader) {
        nums.stream().map(x -> x + 1).collect(Collectors.toList()).forEach(x -> { // C_COLLECT_FOREACH
            System.out.println(x); // C_LIST_FOREACH_BODY
        });
        nums.stream().filter(x -> x > 1).toList().forEach(System.out::println); // C_TOLIST_FOREACH
        nums.stream().collect(Collectors.groupingBy(x -> x % 2)).forEach((k, v) -> System.out.println(k + "=" + v)); // C_GROUPING_FOREACH
        long rr = reader.lines().collect(Collectors.toList()).stream().count(); // C_REOPEN_READER
        long rg = Stream.generate(Math::random).limit(2).collect(Collectors.toList()).stream().count(); // C_REOPEN_GENERATE
        int f = nums.stream().filter(x -> x > 0).findFirst().orElse(0); // C_FIND_FIRST
        int z = nums.stream().map(x -> x).collect(Collectors.toList()).size(); // C_COLLECT_SIZE
        int total = 0;
        if (nums.stream().anyMatch(x -> x > 0)) { // C_IF_HEADER
            total += 1; // C_IF_BODY
        }
    }

    void broken(List<Integer> nums) {
        nums.stream().map(x -> x +).toList(); // C_BROKEN
        long ok = nums.stream().count(); // C_BROKEN_NEXT
    }

    void frames(List<Integer> nums) {
        Runnable r = new Runnable() {
            public void run() {
                long c = nums.stream().count(); // C_ANON
            }
        };
        class Helper {
            long go() {
                return nums.stream().count(); // C_LOCAL
            }
        }
    }

    static class Inner<K> {
        <T extends Comparable<T>> long sortedCount(List<T> items) {
            return items.stream().sorted().count(); // C_GENERIC
        }

        static <S> long staticCount(List<S> items) {
            return items.stream().count(); // C_STATIC_GENERIC
        }

        class Lid {
            long count(List<K> items) {
                return items.stream().count(); // C_INNER_GENERIC
            }
        }

        static class Tag<F> {
            long count(List<F> items) {
                return items.stream().count(); // C_STATIC_NESTED
            }
        }

        record Pair<P>(P left) {
            long count(List<P> items) {
                return items.stream().count(); // C_RECORD_GENERIC
            }
        }
    }

    record Point(int x, int y) {
        long count(List<Integer> nums) {
            return nums.stream().filter(v -> v > x).count(); // C_RECORD
        }
    }

    enum Mode {
        FAST {
            long go(List<Integer> nums) {
                return nums.stream().count(); // C_ENUM_BODY
            }
        };
    }

    interface Repository {
        Stream<Integer> findAll();
    }
}

class Secondary {
    long go(List<Integer> nums) {
        return nums.stream().count(); // C_SECONDARY
    }
}
