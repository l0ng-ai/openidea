//! The golden cases and their expectations, shared by the real-JVM and the fixture runs.

use std::sync::{Arc, OnceLock};

use ide_core::{CancellationToken, LanguageId};
use ide_language::{Syntax, SyntaxCache};
use ide_streams::{
    Banner, BoxKind, ChainWarning, DEFAULT_BUDGET_ENTRIES, DistinctDrop, Outcome, StopContext, StreamChain, TracePlan,
    TraceResult, TraceValue, TypeHints, build_plan, find_chains, normalize,
};
use ide_syntax::{Snapshot, StructureService};

pub const NONCE: &str = "g0";

/// Equal by `key`, printed as `label`, so `distinct` and `toString` disagree.
pub const K_CLASS: &str = "    static final class K {
        final String key;
        final String label;

        K(String key, String label) {
            this.key = key;
            this.label = label;
        }

        @Override
        public boolean equals(Object o) {
            return o instanceof K && ((K) o).key.equals(key);
        }

        @Override
        public int hashCode() {
            return key.hashCode();
        }

        @Override
        public String toString() {
            return label;
        }
    }
";

pub struct Case {
    pub name: &'static str,
    pub locals: &'static str,
    pub chain: &'static str,
    pub budget: usize,
}

const fn case(name: &'static str, locals: &'static str, chain: &'static str) -> Case {
    Case { name, locals, chain, budget: DEFAULT_BUDGET_ENTRIES }
}

pub const CASES: &[Case] = &[
    case("count_sized", "List<Integer> nums = List.of(5, 3, 8, 1);", "Object o = nums.stream().map(x -> x).count();"),
    case(
        "sorted_noop",
        "TreeSet<Integer> set = new TreeSet<>(List.of(5, 3, 8, 1));",
        "Object o = set.stream().sorted().collect(Collectors.toList());",
    ),
    case(
        "sorted_limit",
        "List<Integer> nums = List.of(5, 3, 8, 1);",
        "Object o = nums.stream().sorted().limit(2).collect(Collectors.toList());",
    ),
    case(
        "skip_duplicates",
        "List<Integer> nums = List.of(1, 1, 1);",
        "Object o = nums.stream().skip(2).collect(Collectors.toList());",
    ),
    case(
        "distinct_equals_not_tostring",
        "List<K> ks = List.of(new K(\"a\", \"first\"), new K(\"b\", \"second\"), new K(\"a\", \"third\"));",
        "Object o = ks.stream().distinct().collect(Collectors.toList());",
    ),
    case(
        "exception_mid_stream",
        "List<Integer> nums = List.of(5, 3, 8);",
        "Object o = nums.stream().map(x -> 10 / (x - 3)).collect(Collectors.toList());",
    ),
    Case {
        name: "budget_exceeded",
        locals: "",
        chain: "Object o = Stream.iterate(1, x -> x + 1).filter(x -> x < 0).findFirst();",
        budget: 1000,
    },
    case(
        "void_foreach",
        "List<Integer> nums = List.of(1, 2);",
        "nums.stream().map(x -> x * 2).forEach(x -> System.out.print(x));",
    ),
    case(
        "parallel_made_sequential",
        "List<Integer> nums = List.of(1, 2, 3, 4, 5, 6, 7, 8);",
        "Object o = nums.parallelStream().map(x -> x + 1).collect(Collectors.toList());",
    ),
];

fn service() -> &'static StructureService {
    static S: OnceLock<StructureService> = OnceLock::new();
    S.get_or_init(|| StructureService::new(Arc::new(SyntaxCache::new(Arc::new(Syntax::new())))))
}

/// The user's file stopped at the chain line.
fn user_source(case: &Case) -> String {
    format!(
        "import java.util.*;\nimport java.util.stream.*;\n\nclass Golden {{\n{K_CLASS}\n    static Object run() {{\n        {}\n        {} // HERE\n        return null;\n    }}\n}}\n",
        case.locals, case.chain
    )
}

/// The chain found in the user's source and the plan built from it with no type hints.
#[track_caller]
pub fn chain_and_plan(case: &Case) -> (StreamChain, TracePlan) {
    let src = user_source(case);
    let line = src.lines().position(|l| l.trim_end().ends_with("// HERE")).expect("a line marked HERE") as u32;
    let stop = StopContext { line, in_lambda: false, file_stem: "Golden" };
    let java = LanguageId::new("java");
    let mut found =
        find_chains(service(), &Snapshot::text(&java, &src), &stop, &CancellationToken::new()).expect("search");
    assert!(found.rejected.is_empty(), "{}: rejected {:?}", case.name, found.rejected);
    assert_eq!(found.chains.len(), 1, "{}: {:?}", case.name, found.chains);
    let chain = found.chains.remove(0);
    let normalized = normalize(&chain, &TypeHints::default()).unwrap_or_else(|r| panic!("{}: {r:?}", case.name));
    let plan = build_plan(&normalized, NONCE, case.budget);
    (chain, plan)
}

fn int(value: &TraceValue) -> Option<i64> {
    match value {
        TraceValue::Boxed { class: BoxKind::Int, value, .. } => value.parse().ok(),
        _ => None,
    }
}

fn steps_and_ints(result: &TraceResult) -> Vec<(u16, i64)> {
    result.trace.records.iter().map(|r| (r.step, int(&r.value).expect("an int element"))).collect()
}

fn parents(result: &TraceResult) -> Vec<Option<u32>> {
    result.links.iter().map(|l| l.parent).collect()
}

/// Every record of `step` links to the record right before it, which is one of `step - 1`.
#[track_caller]
fn links_to_previous(result: &TraceResult, step: u16) {
    let records = &result.trace.records;
    let mut seen = 0;
    for i in (0..records.len()).filter(|&i| records[i].step == step) {
        assert_eq!(result.links[i].parent, Some(i as u32 - 1), "record {i}");
        assert_eq!(records[i - 1].step, step - 1, "record {}", i - 1);
        seen += 1;
    }
    assert!(seen > 0, "no records at step {step}");
}

#[track_caller]
fn completed(result: &TraceResult) -> &TraceValue {
    match &result.trace.outcome {
        Outcome::Completed { result: Some(value) } => value,
        other => panic!("not completed: {other:?}"),
    }
}

#[track_caller]
pub fn expect(case: &Case, chain: &StreamChain, result: &TraceResult) {
    let trace = &result.trace;
    let records = &trace.records;
    assert_eq!(result.links.len(), records.len());
    assert!(!result.cleanup_failed);
    if case.name != "parallel_made_sequential" {
        assert_eq!(chain.warnings, [], "{}", case.name);
    }
    if !matches!(case.name, "count_sized" | "sorted_noop") {
        assert_eq!(trace.banners, [], "{}", case.name);
    }
    match case.name {
        "count_sized" => {
            assert!(
                matches!(completed(result), TraceValue::Boxed { class: BoxKind::Long, value, .. } if value == "4"),
                "{:?}",
                trace.outcome
            );
            assert_eq!(records.len(), 0);
            assert_eq!(trace.banners, [Banner::CountFromSize]);
        }
        "sorted_noop" => {
            completed(result);
            assert_eq!(trace.banners, [Banner::SortedPassThrough { step: 1 }]);
            links_to_previous(result, 1);
        }
        "sorted_limit" => {
            completed(result);
            assert_eq!(steps_and_ints(result), [(0, 5), (0, 3), (0, 8), (0, 1), (1, 1), (2, 1), (1, 3), (2, 3)]);
            assert_eq!(parents(result), [None, None, None, None, Some(3), Some(4), Some(1), Some(6)]);
        }
        "skip_duplicates" => {
            completed(result);
            assert_eq!(records.len(), 4);
            let skipped: Vec<_> = records.iter().enumerate().filter(|(_, r)| r.step == 1).map(|(i, _)| i).collect();
            assert_eq!(skipped.len(), 1);
            assert_eq!(result.links[skipped[0]].parent, Some(2));
        }
        "distinct_equals_not_tostring" => {
            completed(result);
            assert_eq!(records.len(), 5);
            assert_eq!(result.drops, [DistinctDrop { dropped: 4, same_as: None }]);
            let kept: Vec<_> =
                records.iter().zip(&result.links).filter(|(r, _)| r.step == 1).map(|(_, l)| l.parent).collect();
            assert_eq!(kept, [Some(0), Some(2)]);
        }
        "exception_mid_stream" => {
            assert_eq!(trace.outcome, Outcome::Threw { message: "java.lang.ArithmeticException: / by zero".into() });
            assert_eq!(steps_and_ints(result), [(0, 5), (1, 5), (0, 3)]);
        }
        "budget_exceeded" => {
            assert_eq!(trace.outcome, Outcome::BudgetExceeded);
            assert_eq!(records.len(), 500);
        }
        "void_foreach" => {
            assert_eq!(trace.outcome, Outcome::Completed { result: Some(TraceValue::Null) });
            assert_eq!(records.len(), 4);
        }
        "parallel_made_sequential" => {
            assert_eq!(chain.warnings, [ChainWarning::ParallelRemoved]);
            completed(result);
            assert_eq!(records.len(), 16);
            links_to_previous(result, 1);
        }
        other => panic!("no expectation for case {other}"),
    }
}
