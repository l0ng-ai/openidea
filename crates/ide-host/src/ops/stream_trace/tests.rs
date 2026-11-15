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
    assert_eq!(serde_json::to_value(TerminalView::Value { value }).unwrap()["kind"], "value",);
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
fn recorded_steps_skip_modifiers() {
    let java = LanguageId::new("java");
    let source = "class Chains { void run(java.util.List<Integer> nums) {\n\
                  long n = nums.parallelStream().filter(x -> x > 0).unordered().map(x -> x).count();\n} }";
    let snap = Snapshot::text(&java, source);
    let found = chains_at(service(), &snap, &frame(1), true, true, &CancellationToken::new()).unwrap();
    let chain = found[0].chain.as_ref().expect("a traceable chain");
    assert_eq!(found[0].info.steps, ["filter", "unordered", "map"]);
    assert_eq!(recorded_steps(chain), ["parallelStream", "filter", "map"]);
}
