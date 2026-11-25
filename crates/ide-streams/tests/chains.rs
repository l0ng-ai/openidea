use ide_core::{CancellationToken, LanguageId};
use ide_language::{Syntax, SyntaxCache};
use ide_streams::{
    ChainSearch, ChainWarning, FrameKind, OpRole, Rejection, RootKind, StepKind, StopContext, StreamChain, find_chains,
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

fn search(marker: &str, in_lambda: bool) -> ChainSearch {
    let java = LanguageId::new("java");
    let stop = StopContext { line: line_of(marker), in_lambda, file_stem: "Chains" };
    find_chains(service(), &Snapshot::text(&java, FIXTURE), &stop, &CancellationToken::new()).expect("search")
}

/// The single chain on the marked line, with nothing rejected.
#[track_caller]
fn only_chain(marker: &str) -> StreamChain {
    let mut found = search(marker, false);
    assert!(found.rejected.is_empty(), "{marker}: unexpected rejections {:?}", found.rejected);
    assert_eq!(found.chains.len(), 1, "{marker}: {:?}", found.chains);
    found.chains.remove(0)
}

#[track_caller]
fn only_rejection(marker: &str, in_lambda: bool) -> Rejection {
    let found = search(marker, in_lambda);
    assert!(found.chains.is_empty(), "{marker}: unexpected chains {:?}", found.chains);
    assert_eq!(found.rejected.len(), 1, "{marker}: {:?}", found.rejected);
    found.rejected[0].reason.clone()
}

fn op_names(chain: &StreamChain) -> Vec<&str> {
    chain.ops.iter().map(|op| op.name.as_str()).collect()
}

#[test]
fn collector_calls_are_not_chains() {
    assert_eq!(only_chain("C_NEW").terminal.name, "collect");
    assert_eq!(op_names(&only_chain("C_STATIC_IMPORT")), ["map"]);
    let optional = search("C_OPTIONAL", false);
    assert!(optional.chains.is_empty() && optional.rejected.is_empty(), "{optional:?}");
}

#[test]
fn new_stream_chain_has_root_ops_and_terminal() {
    let chain = only_chain("C_NEW");
    assert_eq!(chain.root.text, "nums.stream()");
    assert_eq!(&chain.text[chain.root.span.0..chain.root.span.1], "nums.stream()");
    assert_eq!(op_names(&chain), ["filter", "map"]);
    assert_eq!(&chain.text[chain.ops[0].span.0..chain.ops[0].span.1], ".filter(x -> x % 2 == 0)");
    assert_eq!(chain.ops[1].role, OpRole::Step { link: StepKind::Sync });
    assert_eq!(chain.terminal.role, OpRole::Terminal { void: false });
    assert_eq!(&chain.text[chain.terminal.span.0..chain.terminal.span.1], ".collect(Collectors.toList())");
    assert!(chain.text.starts_with("nums.stream()") && chain.text.ends_with(".collect(Collectors.toList())"));
    assert!(chain.warnings.is_empty());
}

#[test]
fn stream_held_in_a_variable_is_a_local_root() {
    let chain = only_chain("C_VARIABLE");
    assert_eq!(chain.root.text, "given");
    assert_eq!(chain.root_kind, RootKind::Local { name: "given".into() });
    assert_eq!(chain.root.call, None);
}

#[test]
fn stream_from_an_unknown_method_is_an_other_root() {
    let chain = only_chain("C_FOREIGN_ROOT");
    assert_eq!(chain.root.text, "repo.findAll()");
    assert_eq!(chain.root_kind, RootKind::Other);
    assert_eq!(op_names(&chain), ["filter"]);
}

#[test]
fn new_stream_call_is_a_call_root() {
    let chain = only_chain("C_NEW");
    assert_eq!(chain.root_kind, RootKind::Call);
    let call = chain.root.call.expect("call root");
    assert_eq!((call.name.as_str(), call.args, call.skip), ("stream", 0, 0));
}

#[test]
fn unknown_operation_is_rejected() {
    assert_eq!(only_rejection("C_UNKNOWN_OP", false), Rejection::UnknownOperation { op: "mapToEntry".into() });
}

#[test]
fn primitive_stream_chain() {
    let chain = only_chain("C_INT");
    assert_eq!(chain.root.text, "IntStream.range(0, 10)");
    assert_eq!(op_names(&chain), ["map"]);
    assert_eq!(chain.terminal.name, "sum");
}

#[test]
fn lazy_terminal_is_rejected() {
    assert_eq!(only_rejection("C_ITERATOR", false), Rejection::LazyTerminal { op: "iterator".into() });
}

#[test]
fn parallel_modifiers_are_kept_with_a_warning() {
    let chain = only_chain("C_PARALLEL");
    assert_eq!(op_names(&chain), ["sequential", "map", "parallel"]);
    let roles: Vec<_> = chain.ops.iter().map(|op| op.role).collect();
    assert_eq!(roles, [OpRole::Modifier, OpRole::Step { link: StepKind::Sync }, OpRole::Modifier]);
    assert_eq!(chain.warnings, [ChainWarning::Sequentialized]);
}

#[test]
fn multi_line_chain_found_from_a_middle_line() {
    let chain = only_chain("C_MULTI");
    assert_eq!(chain.root.text, "nums.stream()");
    assert_eq!(op_names(&chain), ["map", "filter"]);
    assert_eq!(chain.terminal.name, "collect");
    assert_eq!(chain.range.start.line + 3, chain.range.end.line);
}

#[test]
fn line_inside_a_chain_lambda_is_rejected() {
    assert_eq!(only_rejection("C_IN_LAMBDA", true), Rejection::InsideChainLambda);
}

#[test]
fn nested_chain_belongs_to_the_frame() {
    let outer = only_chain("C_INNER");
    assert_eq!(outer.root.text, "xs.stream()");
    assert_eq!(outer.terminal.name, "toList");

    let mut in_lambda = search("C_INNER", true);
    assert!(in_lambda.rejected.is_empty(), "{:?}", in_lambda.rejected);
    assert_eq!(in_lambda.chains.len(), 1);
    let inner = in_lambda.chains.remove(0);
    assert_eq!(inner.text, "ys.stream().filter(y -> y < x).count()");
}

#[test]
fn two_chains_in_one_statement_in_source_order() {
    let found = search("C_TWO", false);
    assert!(found.rejected.is_empty());
    let texts: Vec<_> = found.chains.iter().map(|c| c.text.as_str()).collect();
    assert_eq!(texts, ["xs.stream().count()", "ys.stream().filter(y -> y > 0).count()"]);
}

#[test]
fn for_each_is_a_void_terminal() {
    assert_eq!(only_chain("C_FOREACH").terminal.role, OpRole::Terminal { void: true });
}

#[test]
fn chain_without_terminal_is_rejected() {
    assert_eq!(only_rejection("C_NO_TERMINAL", false), Rejection::NoTerminal);
}

#[test]
fn terminal_on_a_collected_result_keeps_the_stream_chain() {
    for (marker, terminal) in
        [("C_COLLECT_FOREACH", "collect"), ("C_TOLIST_FOREACH", "toList"), ("C_GROUPING_FOREACH", "collect")]
    {
        let chain = only_chain(marker);
        assert_eq!(chain.terminal.name, terminal, "{marker}");
        assert!(chain.text.starts_with("nums.stream()"), "{marker}: {}", chain.text);
    }
}

#[test]
fn lambda_of_a_collection_call_is_not_inside_a_chain() {
    let found = search("C_LIST_FOREACH_BODY", true);
    assert!(found.chains.is_empty() && found.rejected.is_empty(), "{found:?}");

    let grouping = search("C_GROUPING_FOREACH", true);
    assert!(grouping.chains.is_empty(), "{:?}", grouping.chains);
    let reasons: Vec<_> = grouping.rejected.iter().map(|r| (&r.reason, r.text.as_str())).collect();
    let chain = "nums.stream().collect(Collectors.groupingBy(x -> x % 2))";
    assert_eq!(reasons, [(&Rejection::InsideChainLambda, chain)]);
}

#[test]
fn outermost_stream_terminal_is_the_chain_end() {
    assert_eq!(only_chain("C_FIND_FIRST").terminal.name, "findFirst");
    assert_eq!(only_chain("C_COLLECT_SIZE").terminal.name, "collect");
}

#[test]
fn chain_in_a_statement_header_is_found_only_from_the_header() {
    assert_eq!(only_chain("C_IF_HEADER").terminal.name, "anyMatch");
    let body = search("C_IF_BODY", false);
    assert!(body.chains.is_empty() && body.rejected.is_empty(), "{body:?}");
}

#[test]
fn initializers_are_frames() {
    for marker in ["C_STATIC_INIT", "C_INSTANCE_INIT", "C_FIELD_INIT", "C_INSTANCE_FIELD"] {
        let chain = only_chain(marker);
        assert!(chain.text.starts_with("NUMS.stream()"), "{marker}: {}", chain.text);
    }
    assert_eq!(only_rejection("C_FIELD_INIT", true), Rejection::InsideChainLambda);
}

#[test]
fn syntax_error_rejects_only_the_broken_chain() {
    assert_eq!(only_rejection("C_BROKEN", false), Rejection::SyntaxError);
    assert_eq!(only_chain("C_BROKEN_NEXT").text, "nums.stream().count()");
}

#[test]
fn chains_in_unsupported_frames_are_reported_with_the_frame_kind() {
    for (marker, frame) in [
        ("C_ANON", FrameKind::Anonymous),
        ("C_ENUM_BODY", FrameKind::Anonymous),
        ("C_LOCAL", FrameKind::Local),
        ("C_SECONDARY", FrameKind::SecondaryTopLevel),
    ] {
        assert_eq!(only_chain(marker).frame.kind, Some(frame), "{marker}");
    }
    assert_eq!(only_chain("C_NEW").frame.kind, None);
}

#[test]
fn frame_shape_lists_classes_type_params_and_package() {
    let plain = only_chain("C_NEW").frame;
    assert_eq!(plain.class_path, ["Chains"]);
    assert_eq!(plain.package.as_deref(), Some("demo"));
    assert!(!plain.record && plain.type_params.is_empty());

    let generic = only_chain("C_GENERIC").frame;
    assert_eq!(generic.class_path, ["Chains", "Inner"]);
    assert_eq!(generic.type_params, [("T".to_string(), Some("Comparable".to_string())), ("K".to_string(), None)]);
    assert!(!generic.record);

    let record = only_chain("C_RECORD").frame;
    assert_eq!(record.class_path, ["Chains", "Point"]);
    assert!(record.record);
}

#[test]
fn enclosing_type_params_stop_at_static_boundaries() {
    let params = |marker| only_chain(marker).frame.type_params;
    assert_eq!(params("C_STATIC_GENERIC"), [("S".to_string(), None)]);
    assert_eq!(params("C_INNER_GENERIC"), [("K".to_string(), None)]);
    assert_eq!(params("C_STATIC_NESTED"), [("F".to_string(), None)]);
    // A nested record is implicitly static.
    assert_eq!(params("C_RECORD_GENERIC"), [("P".to_string(), None)]);
}

#[test]
fn columns_are_utf16() {
    let chain = only_chain("C_UTF16");
    let line = FIXTURE.lines().nth(line_of("C_UTF16") as usize).unwrap();
    let before = &line[..line.find("nums").unwrap()];
    assert_eq!(chain.range.start.col as usize, before.encode_utf16().count());
}

#[test]
fn rejection_json_shape() {
    let r = Rejection::UnknownOperation { op: "mapToEntry".into() };
    assert_eq!(serde_json::to_string(&r).unwrap(), r#"{"kind":"unknownOperation","op":"mapToEntry"}"#);
    let role = OpRole::Step { link: StepKind::Reorder };
    assert_eq!(serde_json::to_string(&role).unwrap(), r#"{"kind":"step","link":"reorder"}"#);
}
