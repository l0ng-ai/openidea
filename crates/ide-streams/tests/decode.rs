use ide_core::{CancellationToken, LanguageId};
use ide_language::{Syntax, SyntaxCache};
use ide_streams::{
    Banner, BoxKind, DEFAULT_BUDGET_ENTRIES, DecodeError, E1Value, EvalFailure, Outcome, Record, Recording,
    StopContext, TracePlan, TraceValue, TypeHints, build_plan, classify_eval_error, decode, find_chains, normalize,
};
use ide_syntax::{Snapshot, StructureService};
use std::sync::{Arc, OnceLock};

const SAMPLE: &str = "import java.util.*;
import java.util.stream.*;

class Sample {
    void f(List<Integer> nums) {
        {F}
    }
}
";

fn service() -> &'static StructureService {
    static S: OnceLock<StructureService> = OnceLock::new();
    S.get_or_init(|| StructureService::new(Arc::new(SyntaxCache::new(Arc::new(Syntax::new())))))
}

#[track_caller]
fn plan(stmt: &str) -> TracePlan {
    let src = SAMPLE.replace("{F}", &format!("{stmt} // HERE"));
    let line = src.lines().position(|l| l.trim_end().ends_with("// HERE")).expect("a line marked HERE") as u32;
    let java = LanguageId::new("java");
    let stop = StopContext { line, in_lambda: false, file_stem: "Sample" };
    let mut found =
        find_chains(service(), &Snapshot::text(&java, &src), &stop, &CancellationToken::new()).expect("search");
    assert_eq!(found.chains.len(), 1, "{:?}", found.chains);
    let chain = normalize(&found.chains.remove(0), &TypeHints::default()).expect("normalises");
    build_plan(&chain, "n1", DEFAULT_BUDGET_ENTRIES)
}

fn filter_plan() -> TracePlan {
    plan("Object r = nums.stream().filter(x -> x > 1).collect(Collectors.toList());")
}

fn o(id: u64) -> TraceValue {
    TraceValue::Object { id, class: "Foo".into() }
}

fn int(id: u64, v: i32) -> TraceValue {
    TraceValue::Boxed { id, class: BoxKind::Int, value: v.to_string() }
}

fn recording(entries: Vec<TraceValue>) -> Recording {
    let total_len = entries.len();
    Recording { entries, total_len }
}

fn e1(type_name: &str, text: &str) -> E1Value {
    E1Value { type_name: type_name.into(), text: text.into() }
}

fn rec(step: u16, value: TraceValue) -> Record {
    Record { step, value }
}

#[test]
fn completed_trace() {
    let entries = vec![int(1, 0), o(10), int(2, 1), o(10), int(1, 0), o(11), int(3, -1), o(99)];
    let d = decode(&filter_plan(), &recording(entries), &e1("ArrayList", "ArrayList@1")).unwrap();
    assert_eq!(d.records, [rec(0, o(10)), rec(1, o(10)), rec(0, o(11))]);
    assert_eq!(d.outcome, Outcome::Completed { result: Some(o(99)) });
    assert_eq!(d.banners, []);
}

#[test]
fn budget_and_thread_guards() {
    let p = filter_plan();
    let rec0 = recording(vec![int(1, 0), o(10)]);
    let d = decode(
        &p,
        &rec0,
        &e1("IllegalStateException", "IllegalStateException@447 \"java.lang.IllegalStateException: oi-budget:n1\""),
    )
    .unwrap();
    assert_eq!(d.outcome, Outcome::BudgetExceeded);

    let thread =
        "IllegalStateException@349 \"java.lang.IllegalStateException: java.lang.IllegalStateException: oi-thread:n1\"";
    let d = decode(&p, &rec0, &e1("IllegalStateException", thread)).unwrap();
    assert_eq!(d.outcome, Outcome::WrongThread);

    let other = "IllegalStateException@447 \"java.lang.IllegalStateException: oi-budget:zz\"";
    let d = decode(&p, &rec0, &e1("IllegalStateException", other)).unwrap();
    assert_eq!(d.outcome, Outcome::Threw { message: "java.lang.IllegalStateException: oi-budget:zz".into() });
}

#[test]
fn user_exception() {
    let text = "ArithmeticException@525 \"java.lang.ArithmeticException: / by zero\"";
    let d = decode(&filter_plan(), &recording(vec![int(1, 0), o(10)]), &e1("ArithmeticException", text)).unwrap();
    assert_eq!(d.outcome, Outcome::Threw { message: "java.lang.ArithmeticException: / by zero".into() });
    assert_eq!(d.records, [rec(0, o(10))]);
}

#[test]
fn exception_without_quoted_message_keeps_the_whole_text() {
    let d = decode(&filter_plan(), &recording(vec![]), &e1("NullPointerException", "NullPointerException@9")).unwrap();
    assert_eq!(d.outcome, Outcome::Threw { message: "NullPointerException@9".into() });
}

#[test]
fn count_from_size() {
    let p = plan("long r = nums.stream().filter(x -> x > 1).count();");
    let long = TraceValue::Boxed { id: 5, class: BoxKind::Long, value: "7".into() };
    let d = decode(&p, &recording(vec![int(3, -1), long.clone()]), &e1("Long", "7")).unwrap();
    assert_eq!(d.outcome, Outcome::Completed { result: Some(long) });
    assert_eq!(d.banners, [Banner::CountFromSize]);
}

#[test]
fn count_with_records_has_no_banner() {
    let p = plan("long r = nums.stream().filter(x -> x > 1).count();");
    let long = TraceValue::Boxed { id: 5, class: BoxKind::Long, value: "1".into() };
    let entries = vec![int(1, 0), o(10), int(2, -1), long];
    let d = decode(&p, &recording(entries), &e1("Long", "1")).unwrap();
    assert_eq!(d.banners, []);
}

#[test]
fn truncated_recording_keeps_whole_pairs() {
    let entries = vec![int(1, 0), o(10), int(2, 1), o(10), int(1, 0), o(11), int(1, 1)];
    let rec = Recording { entries, total_len: 10 };
    let d = decode(&filter_plan(), &rec, &e1("ArrayList", "ArrayList@1")).unwrap();
    assert_eq!(d.records.len(), 3);
    assert_eq!(d.banners, [Banner::Truncated { read: 6, total: 10 }]);
    assert_eq!(d.outcome, Outcome::Completed { result: None });
}

#[test]
fn truncated_recording_still_reports_the_outcome() {
    let entries = vec![int(1, 0), o(10)];
    let rec = Recording { entries, total_len: 6 };
    let text = "IllegalStateException@1 \"java.lang.IllegalStateException: oi-budget:n1\"";
    let d = decode(&filter_plan(), &rec, &e1("IllegalStateException", text)).unwrap();
    assert_eq!(d.outcome, Outcome::BudgetExceeded);

    let d = decode(&filter_plan(), &rec, &e1("StackOverflowError", "StackOverflowError@2")).unwrap();
    assert_eq!(d.outcome, Outcome::Threw { message: "StackOverflowError@2".into() });
    let d = decode(&filter_plan(), &rec, &e1("Throwable", "Throwable@2")).unwrap();
    assert!(matches!(d.outcome, Outcome::Threw { .. }));
}

#[test]
fn terminator_in_a_truncated_recording_is_malformed() {
    let rec = Recording { entries: vec![int(1, -1), o(1)], total_len: 6 };
    let err = decode(&filter_plan(), &rec, &e1("ArrayList", "ArrayList@1")).unwrap_err();
    assert_eq!(err, DecodeError::Malformed { at: 0 });
}

#[test]
fn odd_recording_is_malformed() {
    let p = filter_plan();
    let ok = e1("ArrayList", "ArrayList@1");
    let err = decode(&p, &recording(vec![int(1, 0), o(10), int(2, 1)]), &ok).unwrap_err();
    assert_eq!(err, DecodeError::Malformed { at: 2 });

    let err = decode(&p, &recording(vec![int(1, 7), o(10)]), &ok).unwrap_err();
    assert_eq!(err, DecodeError::Malformed { at: 0 });

    let str_marker = TraceValue::Str { id: 1, value: "0".into(), truncated: false };
    let err = decode(&p, &recording(vec![str_marker, o(10)]), &ok).unwrap_err();
    assert_eq!(err, DecodeError::Malformed { at: 0 });

    let err = decode(&p, &recording(vec![int(1, -1), o(10), int(2, 0), o(11)]), &ok).unwrap_err();
    assert_eq!(err, DecodeError::Malformed { at: 2 });

    let long_marker = TraceValue::Boxed { id: 1, class: BoxKind::Long, value: "0".into() };
    let err = decode(&p, &recording(vec![int(1, 0), o(10), long_marker, o(10)]), &ok).unwrap_err();
    assert_eq!(err, DecodeError::Malformed { at: 2 });
}

#[test]
fn sorted_pass_through_banner() {
    let p = plan("Object r = nums.stream().filter(x -> x > 1).sorted().collect(Collectors.toList());");
    // Step 2 (sorted) emits before step 1 (filter) is done: the source was already sorted.
    let entries = vec![int(1, 1), o(1), int(2, 2), o(1), int(1, 1), o(2), int(3, 2), o(2), int(4, -1), o(9)];
    let d = decode(&p, &recording(entries), &e1("ArrayList", "ArrayList@1")).unwrap();
    assert_eq!(d.banners, [Banner::SortedPassThrough { step: 2 }]);
}

#[test]
fn eval_errors() {
    assert_eq!(
        classify_eval_error(
            "Cannot evaluate because of compilation error(s): [java.util.ArrayList<java cannot be resolved to a type]."
        ),
        EvalFailure::GenericCapture
    );
    assert_eq!(
        classify_eval_error(
            "Cannot evaluate because of java.lang.NullPointerException: Cannot invoke \"org.eclipse.jdt.internal.compiler.lookup.ModuleBinding.canAccess(org.eclipse.jdt.internal.compiler.lookup.PackageBinding)\" because \"mod\" is null"
        ),
        EvalFailure::UnqualifiedStatic
    );
    assert_eq!(
        classify_eval_error(
            "Cannot evaluate because of compilation error(s): Functional expressions cannot be evaluated inside local and or anonymous classes."
        ),
        EvalFailure::UnsupportedFrame
    );
    assert_eq!(
        classify_eval_error(
            "Cannot evaluate because of compilation error(s): [The method priv(int) from the type Svc is not visible]."
        ),
        EvalFailure::NotVisible { member: "priv".into() }
    );
    assert_eq!(
        classify_eval_error("Cannot evaluate because of compilation error(s): Stream cannot be resolved."),
        EvalFailure::UnresolvedName { name: "Stream".into() }
    );
    let other = "Cannot evaluate because of timeout";
    assert_eq!(classify_eval_error(other), EvalFailure::Other { message: other.into() });
}

#[test]
fn decode_types_serialise_camel_case() {
    let json = serde_json::to_string(&Banner::Truncated { read: 6, total: 10 }).unwrap();
    assert_eq!(json, r#"{"kind":"truncated","read":6,"total":10}"#);
    let json = serde_json::to_string(&EvalFailure::UnresolvedName { name: "A".into() }).unwrap();
    assert_eq!(json, r#"{"kind":"unresolvedName","name":"A"}"#);
}
