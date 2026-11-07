use std::sync::{Arc, Mutex, OnceLock};

use ide_core::{CancellationToken, LanguageId};
use ide_language::{Syntax, SyntaxCache};
use ide_streams::{
    BoxKind, DEFAULT_BUDGET_ENTRIES, DistinctDrop, E1Value, EvalFailure, Evaluator, Link, Outcome, ReadError,
    Recording, RecordingReader, StopContext, TraceError, TracePlan, TraceValue, TypeHints, build_plan, find_chains,
    normalize, run_trace,
};
use ide_syntax::{Snapshot, StructureService};

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

fn completed_recording() -> Recording {
    let entries = vec![int(1, 0), o(10), int(2, 1), o(10), int(1, 0), o(11), int(3, -1), o(99)];
    let total_len = entries.len();
    Recording { entries, total_len }
}

fn e1_value() -> E1Value {
    E1Value { type_name: "ArrayList".into(), text: "ArrayList@1".into() }
}

/// Answers E0, E1 and E3 from fixed results and records every expression it was asked.
struct FakeEval {
    calls: Mutex<Vec<String>>,
    e0: Result<E1Value, String>,
    e1: Result<E1Value, String>,
    e3: Result<E1Value, String>,
    cancel_on_e0: Option<CancellationToken>,
    cancel_on_e1: Option<CancellationToken>,
    plan: TracePlan,
}

impl FakeEval {
    fn new(plan: &TracePlan) -> Self {
        let ok = || Ok(E1Value { type_name: "int".into(), text: "0".into() });
        FakeEval {
            calls: Mutex::new(Vec::new()),
            e0: ok(),
            e1: Ok(e1_value()),
            e3: ok(),
            cancel_on_e0: None,
            cancel_on_e1: None,
            plan: plan.clone(),
        }
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

impl Evaluator for FakeEval {
    async fn evaluate(&self, expression: &str) -> Result<E1Value, String> {
        self.calls.lock().unwrap().push(expression.to_string());
        if expression == self.plan.e1 {
            if let Some(token) = &self.cancel_on_e1 {
                token.cancel();
            }
            self.e1.clone()
        } else if expression == self.plan.e3 {
            self.e3.clone()
        } else {
            if let Some(token) = &self.cancel_on_e0 {
                token.cancel();
            }
            self.e0.clone()
        }
    }
}

struct FakeReader {
    recording: Result<Recording, ReadError>,
    asked: Mutex<Vec<(String, usize)>>,
}

impl FakeReader {
    fn new(recording: Result<Recording, ReadError>) -> Self {
        FakeReader { recording, asked: Mutex::new(Vec::new()) }
    }
}

impl RecordingReader for FakeReader {
    async fn read(&self, key: &str, limit: usize) -> Result<Recording, ReadError> {
        self.asked.lock().unwrap().push((key.to_string(), limit));
        self.recording.clone()
    }
}

#[tokio::test]
async fn happy_path_runs_e0_e1_e3_in_order() {
    let p = filter_plan();
    let eval = FakeEval::new(&p);
    let reader = FakeReader::new(Ok(completed_recording()));

    let result = run_trace(&p, &eval, &reader, &CancellationToken::new()).await.unwrap();

    assert_eq!(eval.calls(), [p.e0.clone(), p.e1.clone(), p.e3.clone()]);
    assert_eq!(result.trace.outcome, Outcome::Completed { result: Some(o(99)) });
    assert_eq!(result.trace.records.len(), 3);
    assert_eq!(
        result.links,
        [
            Link { parent: None, ambiguous: false },
            Link { parent: Some(0), ambiguous: false },
            Link { parent: None, ambiguous: false },
        ]
    );
    assert_eq!(result.drops, []);
    assert!(!result.cleanup_failed);
    assert_eq!(reader.asked.lock().unwrap().as_slice(), [(p.key.clone(), p.budget + 2)]);
}

#[tokio::test]
async fn e3_runs_after_eval_failure() {
    let p = filter_plan();
    let mut eval = FakeEval::new(&p);
    eval.e1 = Err(
        "Cannot evaluate because of compilation error(s): [The method priv(int) from the type Svc is not visible]."
            .into(),
    );
    let reader = FakeReader::new(Ok(completed_recording()));

    let err = run_trace(&p, &eval, &reader, &CancellationToken::new()).await.unwrap_err();

    assert_eq!(err, TraceError::Eval(EvalFailure::NotVisible { member: "priv".into() }));
    assert_eq!(eval.calls().last(), Some(&p.e3));
    assert!(reader.asked.lock().unwrap().is_empty());
}

#[tokio::test]
async fn e3_runs_after_read_failure() {
    let p = filter_plan();
    let eval = FakeEval::new(&p);
    let reader = FakeReader::new(Err(ReadError::Unsupported));

    let err = run_trace(&p, &eval, &reader, &CancellationToken::new()).await.unwrap_err();

    assert_eq!(err, TraceError::Read(ReadError::Unsupported));
    assert_eq!(eval.calls(), [p.e0.clone(), p.e1.clone(), p.e3.clone()]);
}

#[tokio::test]
async fn e3_runs_after_decode_failure() {
    let p = filter_plan();
    let eval = FakeEval::new(&p);
    let reader = FakeReader::new(Ok(Recording { entries: vec![int(1, 0)], total_len: 1 }));

    let err = run_trace(&p, &eval, &reader, &CancellationToken::new()).await.unwrap_err();

    assert!(matches!(err, TraceError::Decode(_)), "{err:?}");
    assert_eq!(eval.calls().last(), Some(&p.e3));
}

#[tokio::test]
async fn setup_failure_still_cleans() {
    let p = filter_plan();
    let mut eval = FakeEval::new(&p);
    eval.e0 = Err("boom".into());
    let reader = FakeReader::new(Ok(completed_recording()));

    let err = run_trace(&p, &eval, &reader, &CancellationToken::new()).await.unwrap_err();

    assert_eq!(err, TraceError::Setup { message: "boom".into() });
    assert_eq!(eval.calls(), [p.e0.clone(), p.e3.clone()]);
    assert!(reader.asked.lock().unwrap().is_empty());
}

#[tokio::test]
async fn cancelled_before_start_calls_nothing() {
    let p = filter_plan();
    let eval = FakeEval::new(&p);
    let reader = FakeReader::new(Ok(completed_recording()));
    let cancel = CancellationToken::new();
    cancel.cancel();

    let err = run_trace(&p, &eval, &reader, &cancel).await.unwrap_err();

    assert_eq!(err, TraceError::Cancelled);
    assert!(eval.calls().is_empty());
}

#[tokio::test]
async fn cancelled_after_e0_skips_e1_but_cleans() {
    let p = filter_plan();
    let cancel = CancellationToken::new();
    let mut eval = FakeEval::new(&p);
    eval.cancel_on_e0 = Some(cancel.clone());
    let reader = FakeReader::new(Ok(completed_recording()));

    let err = run_trace(&p, &eval, &reader, &cancel).await.unwrap_err();

    assert_eq!(err, TraceError::Cancelled);
    assert_eq!(eval.calls(), [p.e0.clone(), p.e3.clone()]);
    assert!(reader.asked.lock().unwrap().is_empty());
}

#[tokio::test]
async fn plan_without_steps_does_not_panic() {
    let mut p = filter_plan();
    p.steps.clear();
    let eval = FakeEval::new(&p);
    let reader = FakeReader::new(Ok(Recording { entries: vec![], total_len: 0 }));

    let result = run_trace(&p, &eval, &reader, &CancellationToken::new()).await.unwrap();

    assert_eq!(result.links, []);
    assert_eq!(result.drops, []);
}

#[tokio::test]
async fn cancelled_after_e1_still_cleans() {
    let p = filter_plan();
    let cancel = CancellationToken::new();
    let mut eval = FakeEval::new(&p);
    eval.cancel_on_e1 = Some(cancel.clone());
    let reader = FakeReader::new(Ok(completed_recording()));

    let err = run_trace(&p, &eval, &reader, &cancel).await.unwrap_err();

    assert_eq!(err, TraceError::Cancelled);
    assert_eq!(eval.calls(), [p.e0.clone(), p.e1.clone(), p.e3.clone()]);
    assert!(reader.asked.lock().unwrap().is_empty());
}

#[tokio::test]
async fn cleanup_failure_is_only_a_flag() {
    let p = filter_plan();
    let mut eval = FakeEval::new(&p);
    eval.e3 = Err("gone".into());
    let reader = FakeReader::new(Ok(completed_recording()));

    let result = run_trace(&p, &eval, &reader, &CancellationToken::new()).await.unwrap();

    assert!(result.cleanup_failed);
    assert_eq!(result.trace.records.len(), 3);
}

#[tokio::test]
async fn reader_gets_budget_plus_terminator() {
    let p = filter_plan();
    let eval = FakeEval::new(&p);
    let reader = FakeReader::new(Ok(completed_recording()));

    run_trace(&p, &eval, &reader, &CancellationToken::new()).await.unwrap();

    let asked = reader.asked.lock().unwrap();
    assert_eq!(asked[0].1, p.budget + 2);
    assert_eq!(asked[0].0, p.key);
}

#[tokio::test]
async fn distinct_steps_report_their_drops() {
    let p = plan("Object r = nums.stream().distinct().collect(Collectors.toList());");
    let eval = FakeEval::new(&p);
    // Step 0 emits 7 twice; step 1 (distinct) lets only the first through.
    let entries = vec![int(1, 0), int(5, 7), int(2, 1), int(5, 7), int(1, 0), int(6, 7), int(3, -1), o(99)];
    let total_len = entries.len();
    let reader = FakeReader::new(Ok(Recording { entries, total_len }));

    let result = run_trace(&p, &eval, &reader, &CancellationToken::new()).await.unwrap();

    assert_eq!(result.drops, [DistinctDrop { dropped: 2, same_as: Some(0) }]);
}

#[test]
fn trace_errors_serialise_with_a_kind_tag() {
    let json = serde_json::to_string(&TraceError::Eval(EvalFailure::UnresolvedName { name: "A".into() })).unwrap();
    assert_eq!(json, r#"{"kind":"eval","detail":{"kind":"unresolvedName","name":"A"}}"#);
    let json = serde_json::to_string(&TraceError::Cancelled).unwrap();
    assert_eq!(json, r#"{"kind":"cancelled"}"#);
    let json = serde_json::to_string(&ReadError::Failed { message: "x".into() }).unwrap();
    assert_eq!(json, r#"{"kind":"failed","message":"x"}"#);
}
