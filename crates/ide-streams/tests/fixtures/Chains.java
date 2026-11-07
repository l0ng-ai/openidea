package demo;

import java.util.*;
import java.util.stream.*;
import static java.util.stream.Collectors.toList;

public class Chains {
    private static final int LIMIT = 3;

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

    void sources(List<Integer> nums, java.io.BufferedReader reader, int step) {
        List<Integer> p = nums.parallelStream().sequential().map(x -> x).parallel().toList(); // C_PARALLEL
        List<Double> g = Stream.generate(Math::random).limit(3).toList(); // C_GENERATE
        List<Integer> i1 = Stream.iterate(1, Chains::next).limit(3).toList(); // C_ITERATE_REF
        List<Integer> i2 = Stream.iterate(1, x -> x + step).limit(3).toList(); // C_ITERATE_CAPTURE
        List<Integer> i3 = Stream.iterate(1, x -> x * 2).limit(3).toList(); // C_ITERATE_PURE
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
    }

    record Point(int x, int y) {
        long count(List<Integer> nums) {
            return nums.stream().filter(v -> v > x).count(); // C_RECORD
        }
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
