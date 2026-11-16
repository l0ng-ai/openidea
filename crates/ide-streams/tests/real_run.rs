use ide_core::{CancellationToken, LanguageId};
use ide_language::{Syntax, SyntaxCache};
use ide_streams::{
    BoxKind, Link, RealRunPlan, RealRunRefusal, Record, RootKind, StepKind, StepSpec, StopContext, StreamChain,
    TerminalOutcome, TraceBanner, TraceRecording, TraceValue, find_chains, link_trace, real_run_plan, recorded_steps,
};
use ide_syntax::{Snapshot, StructureService};
use std::sync::{Arc, OnceLock};

const FIXTURE: &str = include_str!("fixtures/Chains.java");

fn service() -> &'static StructureService {
    static S: OnceLock<StructureService> = OnceLock::new();
    S.get_or_init(|| StructureService::new(Arc::new(SyntaxCache::new(Arc::new(Syntax::new())))))
}

fn line_of(marker: &str) -> u32 {
    let tag = format!("// {marker}");
    let found = FIXTURE.lines().position(|l| l.trim_end().ends_with(&tag));
    found.unwrap_or_else(|| panic!("no line marked {marker}")) as u32
}

fn chains_at(marker: &str) -> Vec<StreamChain> {
    let java = LanguageId::new("java");
    let stop = StopContext { line: line_of(marker), in_lambda: false, file_stem: "Chains" };
    let found =
        find_chains(service(), &Snapshot::text(&java, FIXTURE), &stop, &CancellationToken::new()).expect("search");
    assert!(found.rejected.is_empty(), "{marker}: unexpected rejections {:?}", found.rejected);
    found.chains
}

#[track_caller]
fn only_chain(marker: &str) -> StreamChain {
    let mut chains = chains_at(marker);
    assert_eq!(chains.len(), 1, "{marker}: {chains:?}");
    chains.remove(0)
}

#[track_caller]
fn plan_of(marker: &str) -> RealRunPlan {
    real_run_plan(&only_chain(marker)).unwrap_or_else(|e| panic!("{marker}: {e:?}"))
}

fn spec(name: &str, args: u8, skip: u8) -> StepSpec {
    StepSpec { name: name.into(), args, skip }
}

fn specs(steps: &[StepSpec]) -> Vec<(&str, u8, u8)> {
    steps.iter().map(|s| (s.name.as_str(), s.args, s.skip)).collect()
}

#[test]
fn plan_for_collection_chain() {
    let plan = plan_of("C_PLAN_COLLECTION");
    assert_eq!(plan.root, Some(spec("stream", 0, 0)));
    assert_eq!(plan.local, None);
    assert_eq!(specs(&plan.steps), [("filter", 1, 0), ("map", 1, 0), ("sorted", 0, 0), ("map", 1, 0)]);
    assert_eq!(plan.terminal, spec("collect", 1, 0));
    assert_eq!(plan.class_filters, ["java.util.*"]);
    assert_eq!(plan.step_kinds, [StepKind::Sync, StepKind::Sync, StepKind::Reorder, StepKind::Sync]);
    assert!(!plan.sequentialize);
}

#[test]
fn plan_for_intstream_range() {
    let plan = plan_of("C_PLAN_RANGE");
    assert_eq!(plan.root, Some(spec("range", 2, 0)));
    assert_eq!(plan.class_filters, ["java.util.stream.*"]);
    assert_eq!(plan.terminal.name, "sum");
}

#[test]
fn plan_for_local_root() {
    let chain = only_chain("C_PLAN_LOCAL");
    assert_eq!(chain.root_kind, RootKind::Local { name: "s".into() });
    let plan = real_run_plan(&chain).unwrap();
    assert_eq!(plan.root, None);
    assert_eq!(plan.local.as_deref(), Some("s"));
    assert_eq!(specs(&plan.steps), [("filter", 1, 0)]);
    assert_eq!(plan.class_filters, ["java.util.stream.*"]);
}

#[test]
fn parameter_roots_are_locals() {
    assert_eq!(only_chain("C_VARIABLE").root_kind, RootKind::Local { name: "given".into() });
}

#[test]
fn plan_refuses_roots_that_are_not_new_streams_or_locals() {
    let field = only_chain("C_PLAN_FIELD");
    assert_eq!(field.root_kind, RootKind::Other);
    assert_eq!(real_run_plan(&field), Err(RealRunRefusal::NotJavaStreamRoot { root: "this.items".into() }));

    let bare = only_chain("C_PLAN_FIELD_BARE");
    assert_eq!(bare.root_kind, RootKind::Other);
    assert_eq!(real_run_plan(&bare), Err(RealRunRefusal::NotJavaStreamRoot { root: "items".into() }));

    let foreign = only_chain("C_FOREIGN_ROOT");
    assert_eq!(real_run_plan(&foreign), Err(RealRunRefusal::NotJavaStreamRoot { root: "repo.findAll()".into() }));
}

#[test]
fn plan_marks_parallel() {
    assert!(plan_of("C_PLAN_PARALLEL").sequentialize);
    let modifiers = plan_of("C_PARALLEL");
    assert!(modifiers.sequentialize);
    assert_eq!(specs(&modifiers.steps), [("sequential", 0, 0), ("map", 1, 0), ("parallel", 0, 0)]);
    assert_eq!(modifiers.step_kinds, [StepKind::Sync]);
}

#[test]
fn recorded_steps_follow_the_plan() {
    let collection = only_chain("C_PLAN_COLLECTION");
    assert_eq!(recorded_steps(&collection), ["stream", "filter", "map", "sorted", "map"]);
    assert_eq!(recorded_steps(&collection).len(), real_run_plan(&collection).unwrap().step_kinds.len() + 1);
    let modifiers = only_chain("C_PARALLEL");
    assert_eq!(recorded_steps(&modifiers), ["parallelStream", "map"]);
    assert_eq!(recorded_steps(&modifiers).len(), real_run_plan(&modifiers).unwrap().step_kinds.len() + 1);
    assert_eq!(recorded_steps(&only_chain("C_PLAN_LOCAL")), ["", "filter"]);
}

#[test]
fn skip_counts_receiver_occurrences() {
    let chains = chains_at("C_PLAN_SKIP");
    let outer = chains.iter().find(|c| c.terminal.name == "count").expect("count chain");
    let plan = real_run_plan(outer).unwrap();
    assert_eq!(plan.root, Some(spec("stream", 0, 1)));
    assert_eq!(specs(&plan.steps), [("filter", 1, 0)]);

    let inner = chains.iter().find(|c| c.terminal.name == "collect").expect("collect chain");
    assert_eq!(real_run_plan(inner).unwrap().root, Some(spec("stream", 0, 0)));
}

#[test]
fn later_steps_and_terminal_never_skip() {
    let plan = plan_of("C_PLAN_SAME_NAME");
    assert_eq!(specs(&plan.steps), [("map", 1, 0), ("filter", 1, 0), ("map", 1, 0)]);
    assert_eq!(plan.terminal, spec("count", 0, 0));
}

#[test]
fn root_skip_ignores_calls_inside_lambda_bodies() {
    // The first chain's lambda calls `list.stream()`, but only once its terminal runs.
    let chains = chains_at("C_PLAN_LAMBDA_CALLS");
    assert_eq!(chains.len(), 2);
    let second = chains.iter().find(|c| c.text.starts_with("list.stream()")).expect("second chain");
    assert_eq!(real_run_plan(second).unwrap().root, Some(spec("stream", 0, 1)));
}

#[test]
fn root_skip_counts_earlier_sibling_chain() {
    let chains = chains_at("C_PLAN_SIBLING");
    let roots: Vec<_> = chains.iter().map(|c| real_run_plan(c).unwrap().root.unwrap()).collect();
    assert_eq!(roots, [spec("stream", 0, 0), spec("stream", 0, 1)]);
}

#[test]
fn root_skip_needs_same_arg_count() {
    let chains = chains_at("C_PLAN_ARRAYS_NESTED");
    let counting = chains.iter().find(|c| c.terminal.name == "count").expect("count chain");
    // `Arrays.stream(arr)` is a different overload from the root's `stream()`.
    assert_eq!(real_run_plan(counting).unwrap().root, Some(spec("stream", 0, 0)));
    let inner = chains.iter().find(|c| c.terminal.name == "collect").expect("collect chain");
    assert_eq!(real_run_plan(inner).unwrap().root, Some(spec("stream", 1, 0)));
}

#[test]
fn root_skip_counts_sibling_chain_in_if_header() {
    let chains = chains_at("C_PLAN_IF_HEADER");
    let roots: Vec<_> = chains.iter().map(|c| real_run_plan(c).unwrap().root.unwrap()).collect();
    assert_eq!(roots, [spec("stream", 0, 0), spec("stream", 0, 1)]);
}

#[test]
fn root_skip_counts_earlier_condition_of_else_if() {
    let root = plan_of("C_PLAN_ELSE_IF").root.unwrap();
    assert_eq!(root, spec("stream", 0, 1));
}

#[test]
fn root_skip_ignores_earlier_branch_bodies() {
    // The body of the first branch ran only if its condition held, and then the `else if` was never reached.
    let root = plan_of("C_PLAN_ELSE_IF_BODY").root.unwrap();
    assert_eq!(root, spec("stream", 0, 0));
}

#[test]
fn root_skip_ignores_other_families() {
    // `Optional.of` is not a stream source, so the debugger never sees it as a candidate.
    assert_eq!(plan_of("C_PLAN_OTHER_FAMILY").root, Some(spec("of", 1, 0)));
}

#[test]
fn header_chain_still_starts_at_its_own_line() {
    let chain = only_chain("C_PLAN_ELSE_IF");
    assert_eq!(chain.first_line, line_of("C_PLAN_ELSE_IF"));
}

#[test]
fn varargs_of_counts_as_one_parameter() {
    assert_eq!(plan_of("C_PLAN_STREAM_OF").root, Some(spec("of", 1, 0)));
}

#[test]
fn first_line_is_statement_start() {
    let chain = only_chain("C_PLAN_FIRST_LINE");
    let start = line_of("C_PLAN_FIRST_LINE");
    assert_eq!(chain.first_line, start);
    assert!(chain.range.end.line >= start + 5);
    assert_eq!(real_run_plan(&chain).unwrap().first_line, start);
    assert_eq!(real_run_plan(&chain).unwrap().last_line, chain.range.end.line);

    // A chain written on one line starts where its statement does.
    assert_eq!(only_chain("C_PLAN_COLLECTION").first_line, line_of("C_PLAN_COLLECTION"));
}

/// A method exit two requests match comes in one event set twice, which the bundle cannot take:
/// `java.util.*` already covers `java.util.stream.*`.
#[test]
fn class_filters_follow_the_source() {
    let streams = "java.util.stream.*";
    let lines = &[streams, "java.lang.String", "java.io.BufferedReader"][..];
    let cases: [(&str, &[&str]); 12] = [
        ("C_SRC_ARRAYS", &[streams, "java.util.Arrays"]),
        ("C_SRC_CHARS", &[streams, "java.lang.String", "java.lang.AbstractStringBuilder", "java.lang.CharSequence"]),
        ("C_LINES_LITERAL", lines),
        ("C_LINES", lines),
        ("C_SRC_LINES", lines),
        ("C_SRC_FILES", &[streams, "java.nio.file.Files"]),
        ("C_SRC_PATTERN", &[streams, "java.util.regex.Pattern"]),
        ("C_SRC_RANDOM", &["java.util.*"]),
        ("C_GENERATE", &[streams]),
        ("C_ITERATE_PURE", &[streams]),
        ("C_PLAN_RANGE", &[streams]),
        ("C_STATIC_INIT", &["java.util.*"]),
    ];
    for (marker, expected) in cases {
        assert_eq!(plan_of(marker).class_filters, expected, "{marker}");
    }
}

#[test]
fn nested_collect_then_stream_plans_each_chain() {
    let chains = chains_at("C_REOPEN_READER");
    let filters: Vec<_> = chains.iter().map(|c| real_run_plan(c).unwrap().class_filters).collect();
    assert_eq!(
        filters,
        [vec!["java.util.stream.*", "java.lang.String", "java.io.BufferedReader"], vec!["java.util.*"]]
    );
}

#[test]
fn plan_refuses_what_the_pipeline_cannot_trace() {
    let mut chain = only_chain("C_PLAN_RANGE");
    chain.terminal.role = ide_streams::OpRole::LazyTerminal;
    assert_eq!(real_run_plan(&chain), Err(RealRunRefusal::LazyTerminal { op: "sum".into() }));

    let mut chain = only_chain("C_PLAN_RANGE");
    chain.ops[0].role = ide_streams::OpRole::Terminal { void: false };
    assert_eq!(real_run_plan(&chain), Err(RealRunRefusal::UnknownOperation { op: "filter".into() }));
}

#[test]
fn plan_json_shape() {
    let json = serde_json::to_value(plan_of("C_PLAN_COLLECTION")).unwrap();
    assert_eq!(json["root"], serde_json::json!({"name": "stream", "args": 0, "skip": 0}));
    assert_eq!(json["local"], serde_json::Value::Null);
    assert_eq!(json["classFilters"], serde_json::json!(["java.util.*"]));
    assert_eq!(json["stepKinds"], serde_json::json!(["sync", "sync", "reorder", "sync"]));
    assert_eq!(json["firstLine"], line_of("C_PLAN_COLLECTION"));
    assert_eq!(json["lastLine"], line_of("C_PLAN_COLLECTION"));
    assert_eq!(json["sequentialize"], false);
    assert_eq!(json["terminal"]["name"], "collect");
    assert_eq!(
        serde_json::to_value(RootKind::Local { name: "s".into() }).unwrap(),
        serde_json::json!({"kind": "local", "name": "s"})
    );
    assert_eq!(
        serde_json::to_value(TraceBanner::BreakpointsSkipped { count: 2 }).unwrap(),
        serde_json::json!({"kind": "breakpointsSkipped", "count": 2})
    );
}

fn int(value: i32) -> TraceValue {
    TraceValue::Boxed { id: value as u64 + 1000, class: BoxKind::Int, value: value.to_string() }
}

fn text(id: u64, value: &str) -> TraceValue {
    TraceValue::Str { id, value: value.into(), truncated: false }
}

/// The log of the measured collection chain `source -> filter -> map -> sorted -> map`.
fn spike_records() -> Vec<Record> {
    let at = |step, v| Record { step, value: int(v) };
    let str_at = |step, v: &str| Record { step, value: text(v.parse::<u64>().unwrap() + 5000, v) };
    vec![
        at(0, 5),
        at(0, 3),
        at(0, 8),
        at(1, 8),
        at(2, 81),
        at(0, 1),
        at(0, 4),
        at(1, 4),
        at(2, 41),
        at(0, 2),
        at(1, 2),
        at(2, 21),
        at(0, 9),
        at(0, 6),
        at(1, 6),
        at(2, 61),
        at(3, 21),
        str_at(4, "21"),
        at(3, 41),
        str_at(4, "41"),
        at(3, 61),
        str_at(4, "61"),
        at(3, 81),
        str_at(4, "81"),
    ]
}

fn terminal_value() -> TerminalOutcome {
    TerminalOutcome::Value { value: TraceValue::Object { id: 7, class: "java.util.ArrayList".into() } }
}

fn recording(records: Vec<Record>, dropped: u64, terminal: TerminalOutcome) -> TraceRecording {
    TraceRecording { records, dropped, terminal }
}

#[test]
fn link_trace_reproduces_spike_log() {
    let plan = plan_of("C_PLAN_COLLECTION");
    let linked = link_trace(&plan, &recording(spike_records(), 0, terminal_value()), 0);
    assert_eq!(linked.records, spike_records());
    assert_eq!(linked.links.len(), linked.records.len());
    // `1=8` comes from the `0=8` just before it.
    assert_eq!(linked.links[3].parent, Some(2));
    assert_eq!(linked.links[4].parent, Some(3));
    // `sorted` emits `3=21` (record 16) after the whole upstream ran: it is the `2=21` of record 11.
    assert_eq!(linked.links[16], Link { parent: Some(11), ambiguous: false });
    assert_eq!(linked.links[17].parent, Some(16));
    assert_eq!(linked.links[22].parent, Some(4));
    assert_eq!(linked.banners, []);
}

#[test]
fn link_trace_banners() {
    let plan = plan_of("C_PLAN_COLLECTION");
    let truncated = link_trace(&plan, &recording(spike_records(), 5, terminal_value()), 0);
    assert_eq!(truncated.banners, [TraceBanner::Truncated { dropped: 5 }]);

    let skipped = link_trace(&plan, &recording(spike_records(), 0, terminal_value()), 2);
    assert_eq!(skipped.banners, [TraceBanner::BreakpointsSkipped { count: 2 }]);

    let count_plan = plan_of("C_STATIC_INIT");
    assert_eq!(count_plan.terminal.name, "count");
    let sized = link_trace(&count_plan, &recording(Vec::new(), 0, terminal_value()), 0);
    assert_eq!(sized.banners, [TraceBanner::CountFromSize]);
    // Any record means elements flowed, so the count was not taken from the size.
    let source_only = vec![Record { step: 0, value: int(1) }, Record { step: 0, value: int(2) }];
    let flowed = link_trace(&count_plan, &recording(source_only, 0, terminal_value()), 0);
    assert_eq!(flowed.banners, []);
}

#[test]
fn link_trace_flags_pass_through_sort_sequentialize_and_throw() {
    let plan = plan_of("C_PLAN_COLLECTION");
    // `sorted` emitting `3=1` before `2=2` was recorded means it did not sort.
    let records = vec![
        Record { step: 2, value: int(1) },
        Record { step: 3, value: int(1) },
        Record { step: 2, value: int(2) },
        Record { step: 3, value: int(2) },
    ];
    let threw = TerminalOutcome::Threw {
        exception: TraceValue::Object { id: 9, class: "java.lang.IllegalStateException".into() },
    };
    let linked = link_trace(&plan, &recording(records, 0, threw), 0);
    assert_eq!(linked.banners, [TraceBanner::SortedPassThrough { step: 3 }, TraceBanner::Threw]);

    let parallel = plan_of("C_PLAN_PARALLEL");
    let linked = link_trace(&parallel, &recording(Vec::new(), 0, TerminalOutcome::Void), 0);
    assert_eq!(linked.banners, [TraceBanner::Sequentialized]);
}
