use super::*;
use ide_core::{CancellationToken, LanguageId};
use ide_language::{Syntax, SyntaxCache};
use ide_streams::BoxKind;
use serde_json::json;
use std::sync::{Arc, OnceLock};

const SOURCE: &str = r#"import java.util.*;
import java.util.stream.*;

class Chains {
    Stream<Integer> items;

    void run(List<Integer> nums) {
        List<Integer> evens = nums.stream() // C_EVENS
            .filter(x -> x % 2 == 0) // C_EVENS_FILTER
            .collect(Collectors.toList());
        List<Integer> out = // C_DECL
            nums.stream() // C_ROOT
                .map(x -> x + 1) // C_ROOT_MAP
                .collect(Collectors.toList());
        long n = this.items.filter(x -> x > 0).count(); // C_FIELD
        Iterator<Integer> it = nums.stream().map(x -> x).iterator(); // C_LAZY
        List<String> a = nums.stream().filter(x -> x % 2 == 0).map(x -> x * 10 + 1).sorted().map(String::valueOf).collect(Collectors.toList()); // C_SPIKE
    }
}
"#;

fn service() -> &'static StructureService {
    static S: OnceLock<StructureService> = OnceLock::new();
    S.get_or_init(|| StructureService::new(Arc::new(SyntaxCache::new(Arc::new(Syntax::new())))))
}

fn line_of(marker: &str) -> u32 {
    let tag = format!("// {marker}");
    let found = SOURCE.lines().position(|l| l.trim_end().ends_with(&tag));
    found.unwrap_or_else(|| panic!("no line marked {marker}")) as u32
}

fn frame(line: u32) -> StackFrame {
    StackFrame {
        id: 1,
        name: "Chains.run(List)".into(),
        path: Some("/project/src/Chains.java".into()),
        line,
        column: 8,
        presentation_hint: None,
    }
}

fn chains_on(line: u32, top: bool, backend: bool) -> Vec<StreamChainInfo> {
    let java = LanguageId::new("java");
    let snap = Snapshot::text(&java, SOURCE);
    let found = chains_at(service(), &snap, &frame(line), top, backend, &CancellationToken::new()).expect("search");
    found.into_iter().map(|c| c.info).collect()
}

fn availability(info: &StreamChainInfo) -> serde_json::Value {
    let mut v = serde_json::to_value(info).unwrap();
    let map = v.as_object_mut().unwrap();
    json!({ "available": map.remove("available"), "reason": map.remove("reason") })
}

#[test]
fn chains_refuse_non_top_frame() {
    let infos = chains_on(line_of("C_EVENS"), false, true);
    assert!(!infos.is_empty());
    for info in &infos {
        assert_eq!(availability(info), json!({"available": false, "reason": {"kind": "notTopFrame"}}), "{info:?}");
    }
}

#[test]
fn chains_need_first_line() {
    let infos = chains_on(line_of("C_EVENS_FILTER"), true, true);
    assert_eq!(infos.len(), 1, "{infos:?}");
    assert_eq!(availability(&infos[0]), json!({"available": false, "reason": {"kind": "notAtChainStart"}}));
    let mid = chains_on(line_of("C_ROOT_MAP"), true, true);
    assert_eq!(availability(&mid[0]), json!({"available": false, "reason": {"kind": "notAtChainStart"}}));
}

/// ECJ puts a declaration's first instruction on the line of its initializer's root call.
#[test]
fn chains_accept_the_root_line_of_a_declaration() {
    let at_root = chains_on(line_of("C_ROOT"), true, true);
    assert_eq!(at_root.len(), 1, "{at_root:?}");
    assert_eq!(availability(&at_root[0]), json!({"available": true, "reason": null}));
    let at_head = chains_on(line_of("C_DECL"), true, true);
    assert_eq!(availability(&at_head[0]), json!({"available": true, "reason": null}));
}

#[test]
fn chains_list_rejections() {
    let field = chains_on(line_of("C_FIELD"), true, true);
    assert_eq!(field.len(), 1, "{field:?}");
    assert_eq!(
        availability(&field[0]),
        json!({"available": false, "reason": {"kind": "notJavaStreamRoot", "root": "this.items"}})
    );
    let lazy = chains_on(line_of("C_LAZY"), true, true);
    assert_eq!(lazy.len(), 1, "{lazy:?}");
    assert_eq!(
        availability(&lazy[0]),
        json!({"available": false, "reason": {"kind": "lazyTerminal", "op": "iterator"}})
    );
}

#[test]
fn chains_without_a_tracer_have_no_backend() {
    let infos = chains_on(line_of("C_EVENS"), true, false);
    assert_eq!(availability(&infos[0]), json!({"available": false, "reason": {"kind": "noBackend"}}));
}

#[test]
fn chain_info_json_shape() {
    let infos = chains_on(line_of("C_EVENS"), true, true);
    let v = serde_json::to_value(&infos[0]).unwrap();
    assert_eq!(v["index"], 0);
    assert_eq!(v["steps"], json!(["filter"]));
    assert_eq!(v["terminal"], "collect");
    assert_eq!(v["range"]["start"]["line"], line_of("C_EVENS"));
    assert_eq!(v["available"], true);
    assert!(v.get("reason").is_none(), "{v}");
}

#[test]
fn jvm_value_to_trace_value() {
    let boxed = JvmValue::Boxed { id: 4, type_name: "java.lang.Integer".into(), text: "8".into() };
    assert_eq!(trace_value(&boxed), TraceValue::Boxed { id: 4, class: BoxKind::Int, value: "8".into() });
    let long_text = JvmValue::Str { id: 5, text: None, length: 50_000 };
    assert_eq!(trace_value(&long_text), TraceValue::Str { id: 5, value: String::new(), truncated: true });
    let short_text = JvmValue::Str { id: 6, text: Some("81".into()), length: 2 };
    assert_eq!(trace_value(&short_text), TraceValue::Str { id: 6, value: "81".into(), truncated: false });
    let object = JvmValue::Object { id: 7, type_name: "com.x.Order".into() };
    assert_eq!(trace_value(&object), TraceValue::Object { id: 7, class: "com.x.Order".into() });
    let array = JvmValue::Array { id: 8, type_name: "int[]".into(), length: 3 };
    assert_eq!(trace_value(&array), TraceValue::Object { id: 8, class: "int[]".into() });
    assert_eq!(trace_value(&JvmValue::Null), TraceValue::Null);
    let odd_box = JvmValue::Boxed { id: 9, type_name: "java.math.BigInteger".into(), text: "1".into() };
    assert_eq!(trace_value(&odd_box), TraceValue::Object { id: 9, class: "java.math.BigInteger".into() });
    let count = JvmValue::Primitive { type_name: "long".into(), text: "4".into() };
    assert_eq!(trace_value(&count), TraceValue::Boxed { id: 0, class: BoxKind::Long, value: "4".into() });
    let odd_primitive = JvmValue::Primitive { type_name: "void".into(), text: String::new() };
    assert_eq!(trace_value(&odd_primitive), TraceValue::Null);
}

/// The log measured on `source -> filter -> map -> sorted -> map` (see ide-streams' spike test),
/// as the bundle reports it: every `peek` re-boxes, so no two boxes share an id.
fn spike_collected() -> TraceCollected {
    let steps_values: [(u16, &str); 24] = [
        (0, "5"),
        (0, "3"),
        (0, "8"),
        (1, "8"),
        (2, "81"),
        (0, "1"),
        (0, "4"),
        (1, "4"),
        (2, "41"),
        (0, "2"),
        (1, "2"),
        (2, "21"),
        (0, "9"),
        (0, "6"),
        (1, "6"),
        (2, "61"),
        (3, "21"),
        (4, "21"),
        (3, "41"),
        (4, "41"),
        (3, "61"),
        (4, "61"),
        (3, "81"),
        (4, "81"),
    ];
    let records = steps_values
        .iter()
        .enumerate()
        .map(|(i, &(step, text))| {
            let id = 100 + i as u64;
            let value = if step == 4 {
                JvmValue::Str { id, text: Some(text.into()), length: text.len() as u32 }
            } else {
                JvmValue::Boxed { id, type_name: "java.lang.Integer".into(), text: text.into() }
            };
            (step, value)
        })
        .collect();
    TraceCollected {
        records,
        dropped: 3,
        terminal: CollectedTerminal::Value(JvmValue::Object { id: 7, type_name: "java.util.ArrayList".into() }),
        skipped_breakpoints: 2,
        sequentialized: false,
    }
}

#[test]
fn ready_links_the_collected_records() {
    let java = LanguageId::new("java");
    let snap = Snapshot::text(&java, SOURCE);
    let found = chains_at(service(), &snap, &frame(line_of("C_SPIKE")), true, true, &CancellationToken::new()).unwrap();
    let Candidate { info, chain } = found.into_iter().next().unwrap();
    let chain = chain.unwrap();
    let plan = real_run_plan(&chain).unwrap();
    let collected = spike_collected();
    let expected_records: Vec<TraceRecordView> =
        collected.records.iter().map(|(step, value)| TraceRecordView { step: *step, value: value.clone() }).collect();

    let StreamTraceResult::Ready { chain: shown, steps, records, links, terminal, banners, generation } =
        ready(info.clone(), &chain, &plan, collected, 9, 0)
    else {
        panic!("not ready");
    };
    assert_eq!(*shown, info);
    assert_eq!(steps, ["stream", "filter", "map", "sorted", "map"]);
    assert_eq!(records, expected_records);
    assert_eq!(links.len(), records.len());
    assert_eq!(links[0], Link { parent: None, ambiguous: false });
    // `1=8` comes from the `0=8` just before it, and `2=81` from that.
    assert_eq!(links[3].parent, Some(2));
    assert_eq!(links[4].parent, Some(3));
    // `sorted` emits `3=21` after the whole upstream ran: it is the `2=21` of record 11, linked by
    // value although the box was re-made.
    assert_eq!(links[16], Link { parent: Some(11), ambiguous: false });
    assert_eq!(links[17].parent, Some(16));
    assert_eq!(links[22].parent, Some(4));
    assert_eq!(
        terminal,
        TerminalView::Value { value: JvmValue::Object { id: 7, type_name: "java.util.ArrayList".into() } }
    );
    assert_eq!(banners, [TraceBanner::Truncated { dropped: 3 }, TraceBanner::BreakpointsSkipped { count: 2 }]);
    assert_eq!(generation, 9);
}

#[test]
fn ready_says_how_many_stops_were_resumed() {
    let java = LanguageId::new("java");
    let snap = Snapshot::text(&java, SOURCE);
    let found = chains_at(service(), &snap, &frame(line_of("C_SPIKE")), true, true, &CancellationToken::new()).unwrap();
    let Candidate { info, chain } = found.into_iter().next().unwrap();
    let chain = chain.unwrap();
    let plan = real_run_plan(&chain).unwrap();

    let StreamTraceResult::Ready { banners, .. } = ready(info, &chain, &plan, spike_collected(), 9, 3) else {
        panic!("not ready");
    };
    assert_eq!(
        banners,
        [
            TraceBanner::Truncated { dropped: 3 },
            TraceBanner::BreakpointsSkipped { count: 2 },
            TraceBanner::BreakpointsResumed { count: 3 }
        ]
    );
}

const WINDOW: &str = "main";

/// A real `Host` with a trusted project holding `src/Chains.java` (= [`SOURCE`]).
struct Fixture {
    host: Host,
    source: std::path::PathBuf,
    _temp: tempfile::TempDir,
}

impl Fixture {
    async fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(temp.path()).unwrap();
        let root = base.join("project");
        std::fs::create_dir_all(root.join("src")).unwrap();
        let source = root.join("src/Chains.java");
        std::fs::write(&source, SOURCE).unwrap();
        let host = Host::new(crate::HostConfig {
            config_dir: base.join("config"),
            data_dir: base.join("data"),
            local_data_dir: base.join("local"),
            languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
            syntax: Arc::default(),
            sink_for: Box::new(|_| Arc::new(|_| {})),
            owner: |w| w,
            runtime: tokio::runtime::Handle::current(),
            project_environment: false,
        });
        host.open_project(WINDOW, &root).unwrap();
        host.set_project_trust(&root, true, false).await.unwrap();
        Self { host, source, _temp: temp }
    }

    fn frame(&self, line: u32) -> StackFrame {
        StackFrame { path: Some(self.source.as_path().into()), ..frame(line) }
    }

    async fn chains(&self, frame: StackFrame) -> Vec<StreamChainInfo> {
        candidates(&self.host, WINDOW, frame, true, true).await.unwrap().into_iter().map(|c| c.info).collect()
    }

    async fn trace(&self, request: u32, frame: StackFrame, index: u32, range: Range) -> StreamTraceResult {
        let request = RequestId(request);
        debug_stream_trace(
            &self.host,
            WINDOW,
            DebugSessionId(404),
            request,
            1,
            frame,
            index,
            range,
            Channel::new(|_| {}),
        )
        .await
        .unwrap()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chains_skip_frames_without_a_readable_java_source() {
    let f = Fixture::new().await;
    assert_eq!(f.chains(f.frame(line_of("C_EVENS"))).await.len(), 1, "the file on disk is read");
    let library = StackFrame {
        path: Some("jdt://contents/rt.jar/java.util.stream/ReferencePipeline.class?=java/rt.jar".into()),
        ..frame(120)
    };
    assert_eq!(f.chains(library).await, []);
    let missing = StackFrame { path: Some(f.source.with_file_name("Missing.java").as_path().into()), ..frame(3) };
    assert_eq!(f.chains(missing).await, []);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn trace_refuses_a_chain_that_changed() {
    let f = Fixture::new().await;
    let at = f.frame(line_of("C_EVENS"));
    let listed = f.chains(at.clone()).await.remove(0);
    let changed = StreamTraceResult::Failed { detail: "the chain changed; trace it again".into() };
    let mut moved = listed.range;
    moved.end.col += 1;
    assert_eq!(f.trace(1, at.clone(), listed.index, moved).await, changed);
    assert_eq!(f.trace(2, at, listed.index + 1, listed.range).await, changed);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn trace_reports_an_unavailable_chain_like_the_bundle() {
    let f = Fixture::new().await;
    let mid = f.frame(line_of("C_EVENS_FILTER"));
    let listed = f.chains(mid.clone()).await.remove(0);
    let detail = format!(
        "the stop is on line {}, the chain starts on line {}",
        line_of("C_EVENS_FILTER") + 1,
        line_of("C_EVENS") + 1
    );
    assert_eq!(
        f.trace(1, mid, listed.index, listed.range).await,
        StreamTraceResult::Unavailable { reason: TraceUnavailable::NotAtChainStart { detail } }
    );
    let field = f.frame(line_of("C_FIELD"));
    let listed = f.chains(field.clone()).await.remove(0);
    let detail = "the stream this.items does not start in this statement".to_string();
    assert_eq!(
        f.trace(2, field, listed.index, listed.range).await,
        StreamTraceResult::Unavailable { reason: TraceUnavailable::Unsupported { detail } }
    );
}

/// The session id names no session: reaching `stream_trace` would fail the call.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn trace_cancelled_before_it_starts_does_not_run() {
    let f = Fixture::new().await;
    let at = f.frame(line_of("C_EVENS"));
    let listed = f.chains(at.clone()).await.remove(0);
    f.host.cancel_request(RequestId(7));
    assert_eq!(
        f.trace(7, at, listed.index, listed.range).await,
        StreamTraceResult::Cancelled { detail: "cancelled before the trace started".into() }
    );
    assert_eq!(
        serde_json::to_value(StreamTraceResult::Cancelled { detail: "x".into() }).unwrap(),
        json!({"status": "cancelled", "detail": "x"})
    );
}

#[test]
fn ready_result_json_shape() {
    let info = chains_on(line_of("C_EVENS"), true, true).remove(0);
    let value = JvmValue::Boxed { id: 4, type_name: "java.lang.Integer".into(), text: "8".into() };
    let ready = StreamTraceResult::Ready {
        chain: Box::new(info),
        steps: vec!["stream".into(), "filter".into()],
        records: vec![TraceRecordView { step: 0, value: value.clone() }],
        links: vec![Link { parent: None, ambiguous: false }],
        terminal: TerminalView::Threw { exception: JvmValue::Object { id: 9, type_name: "java.lang.X".into() } },
        banners: vec![TraceBanner::Truncated { dropped: 2 }, TraceBanner::BreakpointsSkipped { count: 1 }],
        generation: 3,
    };
    let v = serde_json::to_value(&ready).unwrap();
    assert_eq!(v["status"], "ready");
    assert_eq!(v["chain"]["available"], true);
    assert_eq!(v["steps"], json!(["stream", "filter"]));
    assert_eq!(
        v["records"],
        json!([{"step": 0, "value": {"kind": "boxed", "id": 4, "typeName": "java.lang.Integer", "text": "8"}}])
    );
    assert_eq!(v["links"], json!([{"parent": null, "ambiguous": false}]));
    assert_eq!(
        v["terminal"],
        json!({"kind": "threw", "exception": {"kind": "object", "id": 9, "typeName": "java.lang.X"}})
    );
    assert_eq!(v["banners"], json!([{"kind": "truncated", "dropped": 2}, {"kind": "breakpointsSkipped", "count": 1}]));
    assert_eq!(v["generation"], 3);
    assert_eq!(serde_json::to_value(TerminalView::Value { value }).unwrap()["kind"], "value");
    assert_eq!(serde_json::to_value(TerminalView::Void).unwrap(), json!({"kind": "void"}));
}

#[test]
fn other_results_json_shape() {
    let unavailable =
        StreamTraceResult::Unavailable { reason: TraceUnavailable::NotAtChainStart { detail: "line 4".into() } };
    assert_eq!(
        serde_json::to_value(&unavailable).unwrap(),
        json!({"status": "unavailable", "reason": {"kind": "notAtChainStart", "detail": "line 4"}})
    );
    assert_eq!(
        serde_json::to_value(StreamTraceResult::Failed { detail: "boom".into() }).unwrap(),
        json!({"status": "failed", "detail": "boom"})
    );
    let progress = TraceProgress { phase: TracePhase::RecordingStopped, records: 5, dropped: 0, elapsed_ms: 40 };
    assert_eq!(
        serde_json::to_value(&progress).unwrap(),
        json!({"phase": "recordingStopped", "records": 5, "dropped": 0, "elapsedMs": 40})
    );
    let stuck = AbortState::Stuck { holders: vec![(3, "main".into())] };
    assert_eq!(serde_json::to_value(&stuck).unwrap(), json!({"kind": "stuck", "holders": [[3, "main"]]}));
    assert_eq!(serde_json::to_value(AbortState::Interrupted).unwrap(), json!({"kind": "interrupted"}));
}

#[test]
fn chain_info_steps_keep_modifiers() {
    let java = LanguageId::new("java");
    let source = "class Chains { void run(java.util.List<Integer> nums) {\n\
                  long n = nums.parallelStream().filter(x -> x > 0).unordered().map(x -> x).count();\n} }";
    let snap = Snapshot::text(&java, source);
    let found = chains_at(service(), &snap, &frame(1), true, true, &CancellationToken::new()).unwrap();
    assert_eq!(found[0].info.steps, ["filter", "unordered", "map"]);
}
