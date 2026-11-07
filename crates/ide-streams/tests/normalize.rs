use ide_core::{CancellationToken, LanguageId, Pos};
use ide_language::{Syntax, SyntaxCache};
use ide_streams::{
    Adjustment, NormalizedChain, OpRole, Rejection, StopContext, StreamChain, TypeHints, TypeQuery, find_chains,
    normalize, parse_hover_declared_type,
};
use ide_syntax::{Snapshot, StructureService};
use std::sync::{Arc, OnceLock};

const SAMPLE: &str = "import java.util.*;
import java.util.stream.*;

class Sample extends Base {
    private static int LIMIT = 3;
    static int twice(int x) { return x * 2; }
    private int priv(int a) { return a; }
    int inst(int a) { return a; }
    void f(List<Integer> nums, Object o) {
        {F}
    }
    static class Inner {
        static int K = 1;
        void g(List<Integer> nums) {
            {G}
        }
    }
}
";

fn service() -> &'static StructureService {
    static S: OnceLock<StructureService> = OnceLock::new();
    S.get_or_init(|| StructureService::new(Arc::new(SyntaxCache::new(Arc::new(Syntax::new())))))
}

/// The single chain on the line marked `// HERE` of a file named `<stem>.java`.
#[track_caller]
fn chain_in(src: &str, stem: &str) -> StreamChain {
    let line = src.lines().position(|l| l.trim_end().ends_with("// HERE")).expect("a line marked HERE") as u32;
    let java = LanguageId::new("java");
    let stop = StopContext { line, in_lambda: false, file_stem: stem };
    let mut found =
        find_chains(service(), &Snapshot::text(&java, src), &stop, &CancellationToken::new()).expect("search");
    assert!(found.rejected.is_empty(), "unexpected rejections {:?}", found.rejected);
    assert_eq!(found.chains.len(), 1, "{:?}", found.chains);
    found.chains.remove(0)
}

fn hints(pairs: &[(u32, &str)]) -> TypeHints {
    TypeHints(pairs.iter().map(|&(id, ty)| (id, ty.to_string())).collect())
}

#[track_caller]
fn norm(src: &str, pairs: &[(u32, &str)]) -> Result<NormalizedChain, Rejection> {
    normalize(&chain_in(src, "Sample"), &hints(pairs))
}

fn in_f(stmts: &str) -> String {
    SAMPLE.replace("{F}", stmts).replace("{G}", "")
}

/// `in_f` with `f` declared as `<signature>`.
fn in_f_as(signature: &str, stmts: &str) -> String {
    in_f(stmts).replace("void f(List<Integer> nums, Object o)", signature)
}

fn in_g(stmts: &str) -> String {
    SAMPLE.replace("{F}", "").replace("{G}", stmts)
}

/// `expr` as the chain of `Sample.f`, normalised and printed.
#[track_caller]
fn plain(expr: &str) -> Result<String, Rejection> {
    norm(&in_f(&format!("Object r = {expr}; // HERE")), &[]).map(|n| n.plain_text())
}

#[test]
fn lambda_parameter_types_are_dropped() {
    assert_eq!(
        plain("nums.stream().map((Integer x) -> x + 1).toList()").unwrap(),
        "nums.stream().map((x) -> x + 1).toList()"
    );
    assert_eq!(
        plain("nums.stream().reduce(0, (final Integer a, Integer b) -> a + b)").unwrap(),
        "nums.stream().reduce(0, (a, b) -> a + b)"
    );
    assert_eq!(plain("nums.stream().map((var x) -> x).toList()").unwrap(), "nums.stream().map((x) -> x).toList()");
    let n = norm(&in_f("Object r = nums.stream().map((Integer x) -> x).toList(); // HERE"), &[]).unwrap();
    assert_eq!(n.adjustments, [Adjustment::LambdaParamTypesRemoved]);
}

#[test]
fn statics_in_lambdas_are_qualified() {
    assert_eq!(
        plain("nums.stream().map(x -> x * LIMIT + twice(x)).toList()").unwrap(),
        "nums.stream().map(x -> x * Sample.LIMIT + Sample.twice(x)).toList()"
    );
    let inner = norm(&in_g("Object r = nums.stream().map(x -> x + K).toList(); // HERE"), &[]).unwrap();
    assert_eq!(inner.plain_text(), "nums.stream().map(x -> x + Sample.Inner.K).toList()");
    assert_eq!(inner.adjustments, [Adjustment::StaticQualified { name: "K".into(), with: "Sample.Inner.K".into() }]);
    assert_eq!(
        plain("Stream.of(LIMIT).map(LIMIT -> LIMIT + 1).toList()").unwrap(),
        "Stream.of(LIMIT).map(LIMIT -> LIMIT + 1).toList()"
    );
    assert_eq!(
        plain("Stream.iterate(1, x -> x + LIMIT).limit(LIMIT).toList()").unwrap(),
        "Stream.iterate(1, x -> x + Sample.LIMIT).limit(LIMIT).toList()"
    );
}

#[test]
fn private_methods_in_lambdas_are_rejected() {
    let private = Err(Rejection::PrivateMethodInLambda { name: "priv".into() });
    assert_eq!(plain("nums.stream().map(x -> priv(x)).toList()"), private);
    assert_eq!(plain("nums.stream().map(x -> this.priv(x)).toList()"), private);
    assert_eq!(plain("nums.stream().map(this::priv).toList()"), private);
    assert_eq!(plain("nums.stream().map(super::inst).toList()"), Err(Rejection::SuperMethodReference));
    assert_eq!(plain("nums.stream().map(this::inst).toList()").unwrap(), "nums.stream().map(this::inst).toList()");
}

#[test]
fn instanceof_patterns_are_rewritten() {
    assert_eq!(
        plain("nums.stream().map(x -> o instanceof Point q ? q.x() + x : x).toList()").unwrap(),
        "nums.stream().map(x -> o instanceof Point ? ((Point) o).x() + x : x).toList()"
    );
    assert_eq!(
        plain("nums.stream().map(x -> o instanceof Point(int a, int b) ? a + b : x).toList()"),
        Err(Rejection::PatternNotRewritable)
    );
    assert_eq!(
        plain("nums.stream().map(x -> switch (x % 2) { case 0 -> \"e\"; default -> \"o\"; }).toList()"),
        Err(Rejection::SwitchExpression)
    );
    assert_eq!(
        plain("nums.stream().map(x -> this.o instanceof Point q ? q.x() : x).toList()"),
        Err(Rejection::PatternNotRewritable)
    );
    assert_eq!(
        plain("Stream.of(o instanceof Point q ? q.x() : 0).toList()").unwrap(),
        "Stream.of(o instanceof Point ? ((Point) o).x() : 0).toList()"
    );
}

#[test]
fn switch_statements_are_allowed() {
    let chain = "nums.stream().map(x -> { switch (x) { case 0: x = 1; break; default: break; } return x; }).toList()";
    assert_eq!(plain(chain).unwrap(), chain);
}

#[test]
fn patterns_whose_name_is_declared_again_are_rejected() {
    assert_eq!(
        plain("nums.stream().map(x -> o instanceof Point q ? q.x() : o instanceof Line q ? q.n() : 0).toList()"),
        Err(Rejection::PatternNotRewritable)
    );
    assert_eq!(
        plain(
            "nums.stream().map(x -> (o instanceof Point q ? q.x() : 0) + nums.stream().mapToInt(q -> q).sum()).toList()"
        ),
        Err(Rejection::PatternNotRewritable)
    );
}

#[test]
fn parameterless_lambdas_are_not_adjusted() {
    let n = norm(&in_f("Object r = Stream.generate(() -> 1).limit(2).toList(); // HERE"), &[]).unwrap();
    assert_eq!(n.plain_text(), "Stream.generate(() -> 1).limit(2).toList()");
    assert!(n.adjustments.is_empty(), "{:?}", n.adjustments);
}

#[test]
fn statics_resolve_to_the_nearest_declaring_class() {
    assert_eq!(
        norm(&in_g("Object r = nums.stream().map(x -> twice(x) + K).toList(); // HERE"), &[]).unwrap().plain_text(),
        "nums.stream().map(x -> Sample.twice(x) + Sample.Inner.K).toList()"
    );
    let nested = "class Sample {
    interface Shapes {
        int SIDES = 4;
        static int sq(int v) { return v * v; }
        default Object h(List<Integer> nums) {
            return nums.stream().map(x -> x * SIDES + sq(x)).toList(); // HERE
        }
    }
    enum Mode {
        FAST;
        void m(List<Integer> nums) {
            {E}
        }
    }
}
";
    assert_eq!(
        norm(&nested.replace("{E}", ""), &[]).unwrap().plain_text(),
        "nums.stream().map(x -> x * Sample.Shapes.SIDES + Sample.Shapes.sq(x)).toList()"
    );
    let in_enum = nested
        .replace(" // HERE", "")
        .replace("{E}", "Object r = nums.stream().filter(x -> this == FAST).toList(); // HERE");
    assert_eq!(
        norm(&in_enum, &[]).unwrap().plain_text(),
        "nums.stream().filter(x -> this == Sample.Mode.FAST).toList()"
    );
}

#[test]
fn parallel_becomes_sequential_before_the_terminal() {
    let n = norm(&in_f("Object r = nums.parallelStream().sequential().map(x -> x).parallel().toList(); // HERE"), &[])
        .unwrap();
    assert_eq!(n.plain_text(), "nums.parallelStream().map(x -> x).sequential().toList()");
    assert!(n.adjustments.contains(&Adjustment::ParallelRemoved), "{:?}", n.adjustments);
    let labels: Vec<_> = n.segments.iter().map(|s| (s.label.as_str(), s.role)).collect();
    assert_eq!(labels[1], ("sequential", OpRole::Modifier));
    assert_eq!(labels.len(), 3);
    assert_eq!(plain("nums.parallelStream().count()").unwrap(), "nums.parallelStream().sequential().count()");
    assert_eq!(plain("nums.stream().unordered().count()").unwrap(), "nums.stream().unordered().count()");
    let sequential = norm(&in_f("Object r = nums.stream().sequential().toList(); // HERE"), &[]).unwrap();
    assert_eq!(sequential.plain_text(), "nums.stream().sequential().toList()");
    assert!(sequential.adjustments.is_empty(), "{:?}", sequential.adjustments);
}

#[test]
fn reserved_identifiers_are_rejected() {
    assert_eq!(
        plain("nums.stream().map(__oiX -> __oiX).toList()"),
        Err(Rejection::ReservedIdentifier { name: "__oiX".into() })
    );
    assert_eq!(
        norm(&in_f("int __r = 1;\n        Object r = nums.stream().map(x -> x + __r).toList(); // HERE"), &[]),
        Err(Rejection::ReservedIdentifier { name: "__r".into() })
    );
}

#[test]
fn segments_drop_the_space_between_operations() {
    let n = norm(
        &in_f("Object r = nums.stream()\n            .map(x -> x) // HERE\n            /* note */ .toList();"),
        &[],
    )
    .unwrap();
    assert_eq!(n.root, "nums.stream()");
    assert!(n.prelude.is_empty());
    assert_eq!(n.plain_text(), "nums.stream().map(x -> x).toList()");
}

#[track_caller]
fn plain_as(signature: &str, stmts: &str, pairs: &[(u32, &str)]) -> Result<String, Rejection> {
    norm(&in_f_as(signature, stmts), pairs).map(|n| n.plain_text())
}

const MAP_SIGNATURE: &str = "void f(Map<String, List<Integer>> m, List<Integer> nums)";

#[test]
fn generic_captures_get_a_raw_alias() {
    let n = norm(
        &in_f_as(MAP_SIGNATURE, "Object r = nums.stream().flatMap(x -> m.get(\"a\").stream()).toList(); // HERE"),
        &[],
    )
    .unwrap();
    assert_eq!(n.prelude, "Map __c_m = m; ");
    assert_eq!(
        n.plain_text(),
        "Map __c_m = m; nums.stream().flatMap(x -> ((Map<String, List<Integer>>) __c_m).get(\"a\").stream()).toList()"
    );
    assert_eq!(
        n.adjustments,
        [Adjustment::CaptureAliased { name: "m".into(), as_type: "Map<String, List<Integer>>".into() }]
    );
    // Only the uses inside lambdas go through the alias.
    assert_eq!(
        plain_as(MAP_SIGNATURE, "Object r = Stream.of(m.size()).map(x -> m.size() + x).toList(); // HERE", &[])
            .unwrap(),
        "Map __c_m = m; Stream.of(m.size()).map(x -> ((Map<String, List<Integer>>) __c_m).size() + x).toList()"
    );
    let arrays = "void f(List<Integer>[] groups, List<Integer> nums)";
    assert_eq!(
        plain_as(arrays, "Object r = nums.stream().map(x -> groups.length).toList(); // HERE", &[]).unwrap(),
        "List[] __c_groups = groups; nums.stream().map(x -> ((List<Integer>[]) __c_groups).length).toList()"
    );
}

#[test]
fn var_capture_uses_the_hover_hint() {
    let src = in_f(
        "var list = new ArrayList<>(nums);\n        Object r = nums.stream().peek(x -> list.add(x)).count(); // HERE",
    );
    let chain = chain_in(&src, "Sample");
    let line = src.lines().position(|l| l.contains("var list")).unwrap();
    let col = src.lines().nth(line).unwrap().find("list").unwrap();
    assert_eq!(chain.facts.queries, [TypeQuery { id: 0, name: "list".into(), pos: Pos::new(line as u32, col as u32) }]);

    let hinted = normalize(&chain, &hints(&[(0, "ArrayList<Integer>")])).unwrap();
    assert_eq!(
        hinted.plain_text(),
        "ArrayList __c_list = list; nums.stream().peek(x -> ((ArrayList<Integer>) __c_list).add(x)).count()"
    );
    assert_eq!(
        hinted.adjustments,
        [Adjustment::CaptureAliased { name: "list".into(), as_type: "ArrayList<Integer>".into() }]
    );

    let raw = normalize(&chain, &hints(&[])).unwrap();
    assert_eq!(raw.plain_text(), "ArrayList __c_list = list; nums.stream().peek(x -> __c_list.add(x)).count()");
    assert!(
        raw.adjustments.contains(&Adjustment::CaptureRaw { name: "list".into(), erasure: "ArrayList".into() }),
        "{:?}",
        raw.adjustments
    );

    let of = "var xs = List.of(1, 2);\n        Object r = nums.stream().filter(x -> xs.contains(x)).count(); // HERE";
    assert_eq!(norm(&in_f(of), &[]), Err(Rejection::MissingTypeHint { name: "xs".into() }));
    assert_eq!(
        norm(&in_f(of), &[(0, "List<Integer>")]).unwrap().plain_text(),
        "List __c_xs = xs; nums.stream().filter(x -> ((List<Integer>) __c_xs).contains(x)).count()"
    );
}

#[test]
fn plain_captures_stay() {
    let signature = "<T> void f(List<Integer> nums, int k, String[] arr, T best)";
    let chain = "nums.stream().filter(x -> x > k && arr.length > 0 && best != null).count()";
    let n = norm(&in_f_as(signature, &format!("Object r = {chain}; // HERE")), &[]).unwrap();
    assert!(n.prelude.is_empty());
    assert_eq!(n.plain_text(), chain);
    // A var whose hinted type is not generic needs no alias either.
    let s = "var s = \"a\";\n        Object r = nums.stream().filter(x -> s.isEmpty()).count(); // HERE";
    assert_eq!(
        norm(&in_f(s), &[(0, "String")]).unwrap().plain_text(),
        "nums.stream().filter(x -> s.isEmpty()).count()"
    );
    // Declared after the chain: not the variable the lambda reads.
    let later =
        "Object r = nums.stream().filter(x -> m != null).count(); // HERE\n        Map<String, Integer> m = null;";
    assert_eq!(norm(&in_f(later), &[]).unwrap().plain_text(), "nums.stream().filter(x -> m != null).count()");
}

#[test]
fn primitives_in_object_arrays_are_boxed_outside_lambdas() {
    let locals = "long big = 1L;\n        int k = 2;\n        ";
    let boxed = norm(
        &in_f(&format!(
            "{locals}Object r = Arrays.asList(new Object[]{{ big, k, \"s\", 5L, 'c' }}).stream().count(); // HERE"
        )),
        &[],
    )
    .unwrap();
    assert_eq!(
        boxed.plain_text(),
        "Arrays.asList(new Object[]{ Long.valueOf(big), Integer.valueOf(k), \"s\", Long.valueOf(5L), Character.valueOf('c') }).stream().count()"
    );
    assert_eq!(boxed.adjustments[0], Adjustment::PrimitiveBoxed { text: "big".into() });
    assert_eq!(
        norm(
            &in_f(&format!(
                "{locals}Object r = Arrays.asList(new Object[]{{ 1, 1.5, 1.5f, true, nums, o }}).stream().count(); // HERE"
            )),
            &[]
        )
        .unwrap()
        .plain_text(),
        "Arrays.asList(new Object[]{ Integer.valueOf(1), Double.valueOf(1.5), Float.valueOf(1.5f), Boolean.valueOf(true), nums, o }).stream().count()"
    );
    let in_lambda = "nums.stream().map(x -> new Object[]{ x, big }).count()";
    assert_eq!(norm(&in_f(&format!("{locals}Object r = {in_lambda}; // HERE")), &[]).unwrap().plain_text(), in_lambda);
}

const POINT: &str = "package demo;
import java.util.stream.*;
import java.util.List;
{IMPORTS}
public record Point(int x, int y) {
    Object f(List<Integer> nums) {
        Object r = {CHAIN}; // HERE
        return r;
    }
}
";

#[track_caller]
fn in_point(imports: &str, chain: &str) -> Result<NormalizedChain, Rejection> {
    let src = POINT.replace("{IMPORTS}", imports).replace("{CHAIN}", chain);
    normalize(&chain_in(&src, "Point"), &TypeHints::default())
}

#[test]
fn record_frames_use_qualified_names() {
    let point = |chain| in_point("", chain).map(|n| n.plain_text());
    assert_eq!(
        point("Stream.of(x, y).mapToInt(i -> i).sum()").unwrap(),
        "java.util.stream.Stream.of(x, y).mapToInt(i -> i).sum()"
    );
    assert_eq!(
        point("List.of(x).stream().collect(Collectors.toList())").unwrap(),
        "java.util.List.of(x).stream().collect(java.util.stream.Collectors.toList())"
    );
    assert_eq!(
        point("Stream.of(Integer.valueOf(x)).count()").unwrap(),
        "java.util.stream.Stream.of(Integer.valueOf(x)).count()"
    );
    assert_eq!(
        in_point("import com.acme.*;", "Foo.items().stream().count()"),
        Err(Rejection::UnqualifiableType { name: "Foo".into() })
    );
    let n = in_point(
        "import java.util.function.*;",
        "Stream.of(x).map(v -> (BiFunction<Integer, Integer, Point>) Point::new).count()",
    )
    .unwrap();
    assert_eq!(
        n.plain_text(),
        "java.util.stream.Stream.of(x).map(v -> (java.util.function.BiFunction<Integer, Integer, demo.Point>) demo.Point::new).count()"
    );
    assert_eq!(
        n.adjustments[0],
        Adjustment::TypeQualified { name: "Stream".into(), with: "java.util.stream.Stream".into() }
    );
    // The alias and its cast are compiled in the frame too.
    assert_eq!(
        point("nums.stream().map(v -> nums.size()).count()").unwrap(),
        "java.util.List __c_nums = nums; nums.stream().map(v -> ((java.util.List<Integer>) __c_nums).size()).count()"
    );
    assert_eq!(
        point("Stream.of((Object) x).map(v -> v instanceof List q ? q.size() : 0).count()").unwrap(),
        "java.util.stream.Stream.of((Object) x).map(v -> v instanceof java.util.List ? ((java.util.List) v).size() : 0).count()"
    );
}

#[test]
fn record_frames_qualify_statics_and_var_aliases() {
    let src = POINT
        .replace("{IMPORTS}", "import java.util.*;")
        .replace("Object f(", "static int K = 1;\n    Object f(")
        .replace("{CHAIN}", "nums.stream().map(v -> v + K).count()");
    assert_eq!(
        normalize(&chain_in(&src, "Point"), &TypeHints::default()).unwrap().plain_text(),
        "nums.stream().map(v -> v + demo.Point.K).count()"
    );
    // Hover spells types by simple name, so a record frame asks for none.
    let src = POINT.replace("{IMPORTS}", "import java.util.*;").replace(
        "Object r = {CHAIN};",
        "var copy = new ArrayList<>(nums);\n        Object r = nums.stream().filter(v -> copy.contains(v)).count();",
    );
    let chain = chain_in(&src, "Point");
    assert!(chain.facts.queries.is_empty());
    assert_eq!(
        normalize(&chain, &TypeHints::default()).unwrap().plain_text(),
        "java.util.ArrayList __c_copy = copy; nums.stream().filter(v -> __c_copy.contains(v)).count()"
    );
}

#[test]
fn locals_declared_inside_the_chain_are_not_captures() {
    let chain = "nums.stream().map(x -> { List<Integer> tmp = List.of(x); return tmp.stream().filter(y -> tmp.contains(y)).count(); }).toList()";
    assert_eq!(plain(chain).unwrap(), chain);
}

const GENERIC: &str = "import java.util.*;
class Sample {
    static {PARAMS} long c(List<T> xs, T[] arr, T best) {
        return {CHAIN}; // HERE
    }
}
";

#[track_caller]
fn generic(params: &str, chain: &str) -> NormalizedChain {
    norm(&GENERIC.replace("{PARAMS}", params).replace("{CHAIN}", chain), &[]).unwrap()
}

#[test]
fn generic_frames_cast_to_the_bound() {
    let bounded = "<T extends Comparable<T>>";
    let n = generic(bounded, "xs.stream().filter(t -> t.compareTo(best) > 0).count()");
    assert_eq!(n.plain_text(), "xs.stream().filter(t -> ((Comparable) t).compareTo(best) > 0).count()");
    assert_eq!(n.adjustments, [Adjustment::GenericCast { name: "t".into(), to: "Comparable".into() }]);
    let unbounded = "xs.stream().filter(t -> t.compareTo(best) > 0).count()";
    assert_eq!(generic("<T>", unbounded).plain_text(), unbounded);
    assert_eq!(
        generic(
            bounded,
            "Arrays.stream(arr).sorted((a, b) -> b.compareTo(a)).filter(t -> t.compareTo(best) > 0).count()"
        )
        .plain_text(),
        "Arrays.stream(arr).sorted((a, b) -> ((Comparable) b).compareTo(((Comparable) a))).filter(t -> ((Comparable) t).compareTo(best) > 0).count()"
    );
    // After `map` the element type is unknown.
    assert_eq!(
        generic(bounded, "xs.stream().map(t -> t).filter(t -> t.compareTo(best) > 0).count()").plain_text(),
        "xs.stream().map(t -> ((Comparable) t)).filter(t -> t.compareTo(best) > 0).count()"
    );
}

#[test]
fn hover_text_gives_the_declared_type() {
    assert_eq!(
        parse_hover_declared_type("ArrayList<Integer> list - demo.Main.run(List<Integer>, int)", "list").as_deref(),
        Some("ArrayList<Integer>")
    );
    assert_eq!(
        parse_hover_declared_type("Map<String, List<Integer>> m - demo.Main.run(List<Integer>, int)", "m").as_deref(),
        Some("Map<String, List<Integer>>")
    );
    assert_eq!(parse_hover_declared_type("int k - demo.Main.run(List<Integer>, int)", "list"), None);
    assert_eq!(
        parse_hover_declared_type("```java\nList<Integer> xs - demo.Main.run()\n```", "xs").as_deref(),
        Some("List<Integer>")
    );
}
