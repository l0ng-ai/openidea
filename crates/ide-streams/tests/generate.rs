use ide_core::{CancellationToken, LanguageId};
use ide_language::{Syntax, SyntaxCache};
use ide_streams::{
    DEFAULT_BUDGET_ENTRIES, NormalizedChain, StepKind, StopContext, TypeHints, build_plan, find_chains, fresh_nonce,
    normalize,
};
use ide_syntax::{Snapshot, StructureService};
use std::sync::{Arc, OnceLock};

const SAMPLE: &str = "import java.util.*;
import java.util.stream.*;

class Sample {
    void f(List<Integer> nums, Map<String, List<Integer>> m) {
        {F}
    }
}
";

fn service() -> &'static StructureService {
    static S: OnceLock<StructureService> = OnceLock::new();
    S.get_or_init(|| StructureService::new(Arc::new(SyntaxCache::new(Arc::new(Syntax::new())))))
}

#[track_caller]
fn norm(stmt: &str) -> NormalizedChain {
    let src = SAMPLE.replace("{F}", &format!("{stmt} // HERE"));
    let line = src.lines().position(|l| l.trim_end().ends_with("// HERE")).expect("a line marked HERE") as u32;
    let java = LanguageId::new("java");
    let stop = StopContext { line, in_lambda: false, file_stem: "Sample" };
    let mut found =
        find_chains(service(), &Snapshot::text(&java, &src), &stop, &CancellationToken::new()).expect("search");
    assert!(found.rejected.is_empty(), "unexpected rejections {:?}", found.rejected);
    assert_eq!(found.chains.len(), 1, "{:?}", found.chains);
    normalize(&found.chains.remove(0), &TypeHints::default()).expect("normalises")
}

fn evens() -> NormalizedChain {
    norm("Object r = nums.stream().filter(x -> x % 2 == 0).map(x -> x * 3).collect(Collectors.toList());")
}

#[test]
fn e1_snapshot() {
    insta::assert_snapshot!(build_plan(&evens(), "n1", DEFAULT_BUDGET_ENTRIES).e1);
}

#[test]
fn e1_snapshot_with_prelude() {
    let chain = norm("Object r = nums.stream().flatMap(x -> m.get(\"a\").stream()).toList();");
    assert_eq!(chain.prelude, "Map __c_m = m; ");
    insta::assert_snapshot!(build_plan(&chain, "n1", DEFAULT_BUDGET_ENTRIES).e1);
}

#[test]
fn e0_e3_and_steps() {
    let p = build_plan(&evens(), "n1", DEFAULT_BUDGET_ENTRIES);
    assert_eq!(p.nonce, "n1");
    assert_eq!(p.key, "oi.n1");
    assert_eq!(p.e0, r#"System.getProperties().put("oi.n1", new java.util.ArrayList())"#);
    assert_eq!(p.e3, r#"System.getProperties().remove("oi.n1")"#);
    assert_eq!(p.steps.iter().map(|s| s.label.as_str()).collect::<Vec<_>>(), ["nums.stream()", "filter", "map"]);
    assert_eq!(p.steps.iter().map(|s| s.index).collect::<Vec<_>>(), [0, 1, 2]);
    assert!(p.steps.iter().all(|s| s.kind == StepKind::Sync));
    assert_eq!(p.terminal, "collect");
    assert!(!p.void_terminal);
    assert_eq!(p.budget, DEFAULT_BUDGET_ENTRIES);
    assert_eq!(p.e1.matches(".peek(__oiX").count(), 3);
}

#[test]
fn reordering_steps_keep_their_kind() {
    let p = build_plan(&norm("Object r = nums.stream().sorted().distinct().toList();"), "n1", 10);
    let kinds: Vec<_> = p.steps.iter().map(|s| s.kind).collect();
    assert_eq!(kinds, [StepKind::Sync, StepKind::Reorder, StepKind::Sync]);
}

#[test]
fn void_terminal_still_writes_the_terminator() {
    let chain = norm("nums.stream().filter(x -> x > 1).forEach(x -> {});");
    let p = build_plan(&chain, "n1", DEFAULT_BUDGET_ENTRIES);
    assert!(p.void_terminal);
    assert_eq!(p.terminal, "forEach");
    assert!(
        p.e1.ends_with("; Object __r = null; __oi.add(Integer.valueOf(-1)); __oi.add(__r); return __r;"),
        "{}",
        p.e1
    );
    assert!(!p.e1.contains("Object __r = nums"), "{}", p.e1);
}

#[test]
fn modifiers_get_no_peek() {
    let chain = norm("Object r = nums.parallelStream().sequential().map(x -> x).parallel().toList();");
    let p = build_plan(&chain, "n1", DEFAULT_BUDGET_ENTRIES);
    let peek = |k: u16| {
        format!(
            ".peek(__oiX -> {{ if (__oi.size() >= 100000) throw new IllegalStateException(\"oi-budget:n1\"); if (Thread.currentThread() != __oiT) throw new IllegalStateException(\"oi-thread:n1\"); __oi.add(Integer.valueOf({k})); __oi.add(__oiX); }})"
        )
    };
    let expected = format!("nums.parallelStream(){}.map(x -> x){}.sequential().toList()", peek(0), peek(1));
    assert!(p.e1.contains(&expected), "{}", p.e1);
    assert_eq!(p.e1.matches(".peek(__oiX").count(), 2);
    assert_eq!(p.steps.iter().map(|s| s.label.as_str()).collect::<Vec<_>>(), ["nums.parallelStream()", "map"]);
}

#[test]
fn custom_budget() {
    let p = build_plan(&evens(), "n1", 1000);
    assert_eq!(p.budget, 1000);
    assert!(p.e1.contains("__oi.size() >= 1000"), "{}", p.e1);
    assert!(!p.e1.contains("100000"));
}

#[test]
fn nonces_are_fresh() {
    let (a, b) = (fresh_nonce(), fresh_nonce());
    assert_ne!(a, b);
    assert_eq!(a.len(), 16);
    assert!(a.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
}
