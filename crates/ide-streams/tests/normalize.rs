use ide_core::{CancellationToken, LanguageId};
use ide_language::{Syntax, SyntaxCache};
use ide_streams::{Adjustment, NormalizedChain, OpRole, Rejection, StopContext, TypeHints, find_chains, normalize};
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

/// Normalises the single chain on the line marked `// HERE`.
#[track_caller]
fn norm(src: &str, hints: &[(u32, &str)]) -> Result<NormalizedChain, Rejection> {
    let line = src.lines().position(|l| l.trim_end().ends_with("// HERE")).expect("a line marked HERE") as u32;
    let java = LanguageId::new("java");
    let stop = StopContext { line, in_lambda: false, file_stem: "Sample" };
    let mut found =
        find_chains(service(), &Snapshot::text(&java, src), &stop, &CancellationToken::new()).expect("search");
    assert!(found.rejected.is_empty(), "unexpected rejections {:?}", found.rejected);
    assert_eq!(found.chains.len(), 1, "{:?}", found.chains);
    let hints = TypeHints(hints.iter().map(|&(id, ty)| (id, ty.to_string())).collect());
    normalize(&found.chains.remove(0), &hints)
}

fn in_f(stmts: &str) -> String {
    SAMPLE.replace("{F}", stmts).replace("{G}", "")
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
