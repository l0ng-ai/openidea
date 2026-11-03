use std::{collections::HashSet, path::PathBuf};

use ide_core::error::ErrorKind;
use ide_notebook::{NotebookDocument, NotebookEdit, kernel::KernelOutput};
use serde_json::{Value, json};

const ORIGINAL: &str = r##"{
  "unknownRoot": { "escaped": "\u0061", "number": 1e+02 },
  "nbformat_minor": 5,
  "metadata": {"custom": [true, {"x": "\u03bb"}]},
  "cells": [
    { "unknownCell": {"keep": "\u0041"}, "source": ["\u0061\n", "b\n", "\u0063"], "id": "first", "metadata": {}, "cell_type": "code", "execution_count": null, "outputs": [] },
    { "cell_type": "markdown", "source": "# title", "metadata": {"custom": 3}, "id": "second", "attachments": {"pic.png": {"image/png": "aW1hZ2U="}}, "future": [1, 2] },
    { "cell_type": "vendor.future", "source": ["opaque"], "metadata": {}, "id": "third", "vendor": {"raw": "\u0042"} }
  ],
  "nbformat": 4
}"##;

fn document(text: &str) -> NotebookDocument {
    NotebookDocument::from_text(PathBuf::from("notebook.ipynb"), text.into()).unwrap()
}

fn apply(doc: &mut NotebookDocument, edit: NotebookEdit) {
    let version = doc.version();
    doc.edit(version, edit).unwrap();
}

fn output(kind: &str, content: Value) -> KernelOutput {
    KernelOutput { kind: kind.into(), content, msg_id: "actual-parent-id".into() }
}

fn emit(doc: &mut NotebookDocument, cell: &str, kind: &str, content: Value) -> Vec<String> {
    doc.record_output(cell, &output(kind, content)).unwrap()
}

fn two_code_cells() -> NotebookDocument {
    document(&json!({
        "nbformat": 4, "nbformat_minor": 5, "metadata": {},
        "cells": [
            {"id": "a", "cell_type": "code", "metadata": {}, "source": "a()", "outputs": [], "execution_count": null},
            {"id": "b", "cell_type": "code", "metadata": {}, "source": ["b()"], "outputs": [], "execution_count": null}
        ]
    }).to_string())
}

#[test]
fn noop_save_preserves_all_bytes_for_utf8_bom_crlf_and_no_final_newline() {
    let dir = tempfile::tempdir().unwrap();
    let variants = [
        ORIGINAL.to_owned(),
        format!("{}\n", ORIGINAL),
        ORIGINAL.replace('\n', "\r\n"),
        format!("\u{feff}{}\r\n", ORIGINAL.replace('\n', "\r\n")),
    ];
    for (index, text) in variants.iter().enumerate() {
        let path = dir.path().join(format!("{index}.ipynb"));
        std::fs::write(&path, text).unwrap();
        let mut doc = NotebookDocument::load(&path).unwrap();
        assert!(!doc.snapshot().dirty);
        assert_eq!(doc.to_text(), *text);
        let before = doc.version();
        doc.save().unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), text.as_bytes());
        assert_eq!(doc.version(), before);
    }
}

#[test]
fn source_list_edit_preserves_unchanged_elements_and_every_other_byte() {
    let mut doc = document(ORIGINAL);
    apply(&mut doc, NotebookEdit::SetSource { cell: "first".into(), source: "a\nB\nc".into() });
    let expected = ORIGINAL.replace(r#"["\u0061\n", "b\n", "\u0063"]"#, r#"["\u0061\n", "B\n", "\u0063"]"#);
    assert_eq!(doc.to_text(), expected);
    assert!(doc.snapshot().dirty);
    let edited_version = doc.version();
    doc.undo().unwrap();
    assert_eq!(doc.to_text(), ORIGINAL);
    assert!(!doc.snapshot().dirty);
    assert!(doc.version() > edited_version);
    doc.redo().unwrap();
    assert_eq!(doc.to_text(), expected);
}

#[test]
fn string_source_stays_a_string_and_attachments_and_unknown_cells_survive() {
    let mut doc = document(ORIGINAL);
    apply(&mut doc, NotebookEdit::SetSource { cell: "second".into(), source: "new\n标题".into() });
    assert_eq!(doc.to_text(), ORIGINAL.replace(r##""# title""##, r#""new\n标题""#));
    let parsed: Value = serde_json::from_str(&doc.to_text()).unwrap();
    assert!(parsed["cells"][1]["source"].is_string());
    assert_eq!(parsed["cells"][1]["attachments"]["pic.png"]["image/png"], "aW1hZ2U=");
    assert_eq!(parsed["cells"][2]["vendor"]["raw"], "B");
}

#[test]
fn old_minor_and_invalid_or_duplicate_persisted_ids_are_not_repaired_on_load_or_edit() {
    let text = r#"{"nbformat":4,"nbformat_minor":2,"metadata":{},"cells":[{"cell_type":"raw","metadata":{},"source":"one","id":"duplicate"},{"cell_type":"raw","metadata":{},"source":"two","id":"duplicate"},{"cell_type":"raw","metadata":{},"source":"three","id":"bad id"},{"cell_type":"raw","metadata":{},"source":"four"}]}"#;
    let mut doc = document(text);
    let before = doc.snapshot();
    assert_eq!(before.cells.iter().map(|cell| &cell.id).collect::<HashSet<_>>().len(), 4);
    assert_eq!(doc.to_text(), text);
    apply(&mut doc, NotebookEdit::SetSource { cell: before.cells[3].id.clone(), source: "changed".into() });
    let after = doc.snapshot();
    assert_eq!(
        before.cells.iter().map(|cell| &cell.id).collect::<Vec<_>>(),
        after.cells.iter().map(|cell| &cell.id).collect::<Vec<_>>()
    );
    apply(&mut doc, NotebookEdit::InsertCell { after: None, cell_type: "code".into() });
    let parsed: Value = serde_json::from_str(&doc.to_text()).unwrap();
    assert_eq!(parsed["nbformat_minor"], 2);
    assert!(parsed["cells"][0].get("id").is_none());
    assert_eq!(parsed["cells"][1]["id"], "duplicate");
    assert_eq!(parsed["cells"][2]["id"], "duplicate");
    assert_eq!(parsed["cells"][3]["id"], "bad id");
    assert!(parsed["cells"][4].get("id").is_none());
}

#[test]
fn new_cells_get_valid_ids_only_for_minor_five_and_keep_identity_through_history() {
    let mut doc = document(ORIGINAL);
    apply(&mut doc, NotebookEdit::InsertCell { after: Some("first".into()), cell_type: "markdown".into() });
    let inserted = doc.snapshot().cells[1].id.clone();
    let parsed: Value = serde_json::from_str(&doc.to_text()).unwrap();
    assert_eq!(parsed["cells"][1]["id"], inserted);
    assert!(inserted.len() <= 64 && inserted.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
    doc.undo().unwrap();
    assert_eq!(doc.to_text(), ORIGINAL);
    doc.redo().unwrap();
    assert_eq!(doc.snapshot().cells[1].id, inserted);
}

#[test]
fn move_and_delete_restore_exact_raw_subtrees_and_container_punctuation() {
    let mut doc = document(ORIGINAL);
    apply(&mut doc, NotebookEdit::MoveCell { cell: "third".into(), before: Some("first".into()) });
    assert_eq!(
        doc.snapshot().cells.iter().map(|cell| cell.id.as_str()).collect::<Vec<_>>(),
        ["third", "first", "second"]
    );
    assert!(doc.to_text().contains(r#""vendor": {"raw": "\u0042"}"#));
    apply(&mut doc, NotebookEdit::DeleteCell { cell: "first".into() });
    assert_eq!(doc.snapshot().cells.iter().map(|cell| cell.id.as_str()).collect::<Vec<_>>(), ["third", "second"]);
    doc.undo().unwrap();
    doc.undo().unwrap();
    assert_eq!(doc.to_text(), ORIGINAL);
    doc.redo().unwrap();
    doc.redo().unwrap();
    assert_eq!(doc.snapshot().cells.iter().map(|cell| cell.id.as_str()).collect::<Vec<_>>(), ["third", "second"]);
}

#[test]
fn delete_last_cell_and_reinsert_into_empty_notebook_are_supported() {
    let text = r#"{"nbformat":4,"nbformat_minor":5,"metadata":{},"cells":[ {"id":"only","cell_type":"raw","source":"x","metadata":{}} ]}"#;
    let mut doc = document(text);
    apply(&mut doc, NotebookEdit::DeleteCell { cell: "only".into() });
    assert_eq!(serde_json::from_str::<Value>(&doc.to_text()).unwrap()["cells"], json!([]));
    doc.undo().unwrap();
    assert_eq!(doc.to_text(), text);
    apply(&mut doc, NotebookEdit::DeleteCell { cell: "only".into() });
    apply(&mut doc, NotebookEdit::InsertCell { after: None, cell_type: "code".into() });
    assert_eq!(doc.snapshot().cells[0].cell_type, "code");
    assert_eq!(doc.snapshot().cells[0].outputs, Vec::<Value>::new());
}

#[test]
fn type_conversion_keeps_unknown_fields_and_restores_removed_fields_exactly() {
    let text =
        ORIGINAL.replace("\"outputs\": []", r#""outputs": [{"output_type":"vendor.output","payload":{"x":"\u0061"}}]"#);
    let mut doc = document(&text);
    apply(&mut doc, NotebookEdit::SetCellType { cell: "first".into(), cell_type: "markdown".into() });
    let converted: Value = serde_json::from_str(&doc.to_text()).unwrap();
    assert!(converted["cells"][0].get("outputs").is_none());
    assert!(converted["cells"][0].get("execution_count").is_none());
    assert_eq!(converted["cells"][0]["unknownCell"]["keep"], "A");
    doc.undo().unwrap();
    assert_eq!(doc.to_text(), text);
    apply(&mut doc, NotebookEdit::SetCellType { cell: "second".into(), cell_type: "code".into() });
    let converted: Value = serde_json::from_str(&doc.to_text()).unwrap();
    assert_eq!(converted["cells"][1]["outputs"], json!([]));
    assert_eq!(converted["cells"][1]["execution_count"], Value::Null);
    assert_eq!(converted["cells"][1]["attachments"]["pic.png"]["image/png"], "aW1hZ2U=");
}

#[test]
fn output_only_revisions_accept_pending_source_edits_but_stale_user_edits_are_rejected() {
    let mut doc = two_code_cells();
    let base = doc.version();
    emit(&mut doc, "a", "stream", json!({"name":"stdout", "text":"hello"}));
    assert!(doc.version() > base);
    doc.edit(base, NotebookEdit::SetSource { cell: "a".into(), source: "new source".into() }).unwrap();
    assert_eq!(doc.snapshot().cells[0].outputs[0]["text"], "hello");
    let current = doc.version();
    let stale = doc.edit(base, NotebookEdit::SetSource { cell: "b".into(), source: "stale".into() }).unwrap_err();
    assert_eq!(stale.kind, ErrorKind::OutOfSync);
    assert_eq!(doc.version(), current);
    let future = doc.edit(current + 1, NotebookEdit::DeleteCell { cell: "a".into() }).unwrap_err();
    assert_eq!(future.kind, ErrorKind::OutOfSync);
    assert_eq!(doc.snapshot().cells[1].source, "b()");
}

#[test]
fn source_undo_preserves_execution_outputs_and_output_does_not_clear_redo() {
    let mut doc = two_code_cells();
    let initial_version = doc.version();
    apply(&mut doc, NotebookEdit::SetSource { cell: "a".into(), source: "print(1)".into() });
    doc.begin_execution("a").unwrap();
    emit(&mut doc, "a", "execute_input", json!({"execution_count": 7}));
    emit(&mut doc, "a", "stream", json!({"name":"stdout", "text":"1\n"}));
    let output_version = doc.version();
    doc.undo().unwrap();
    let state = doc.snapshot();
    assert_eq!(state.cells[0].source, "a()");
    assert_eq!(state.cells[0].execution_count, Some(7));
    assert_eq!(state.cells[0].outputs[0]["text"], "1\n");
    assert!(state.version > output_version && output_version > initial_version);
    emit(&mut doc, "a", "stream", json!({"name":"stderr", "text":"later"}));
    assert!(doc.snapshot().can_redo);
    doc.redo().unwrap();
    let state = doc.snapshot();
    assert_eq!(state.cells[0].source, "print(1)");
    assert_eq!(state.cells[0].outputs[1]["text"], "later");
}

#[test]
fn history_is_rejected_until_execution_batch_is_drained() {
    let mut doc = two_code_cells();
    apply(&mut doc, NotebookEdit::SetSource { cell: "a".into(), source: "changed".into() });
    doc.set_execution_active(true).unwrap();
    assert!(!doc.snapshot().can_undo);
    assert_eq!(doc.undo().unwrap_err().kind, ErrorKind::InvalidInput);
    assert_eq!(doc.redo().unwrap_err().kind, ErrorKind::InvalidInput);
    assert_eq!(doc.reload().unwrap_err().kind, ErrorKind::InvalidInput);
    assert!(doc.set_execution_active(true).is_err());
    doc.set_execution_active(false).unwrap();
    doc.undo().unwrap();
    assert_eq!(doc.snapshot().cells[0].source, "a()");
}

#[test]
fn inserted_cell_redo_retains_outputs_produced_after_its_creation() {
    let mut doc = two_code_cells();
    apply(&mut doc, NotebookEdit::InsertCell { after: None, cell_type: "code".into() });
    let id = doc.snapshot().cells[0].id.clone();
    emit(&mut doc, &id, "stream", json!({"name":"stdout", "text":"keep"}));
    doc.undo().unwrap();
    doc.redo().unwrap();
    assert_eq!(doc.snapshot().cells[0].id, id);
    assert_eq!(doc.snapshot().cells[0].outputs[0]["text"], "keep");
}

#[test]
fn display_updates_reach_earlier_cells_and_never_persist_transient_ids() {
    let mut doc = two_code_cells();
    let display = json!({"data":{"text/plain":"old", "vendor/mime":{"arbitrary":true}}, "metadata":{"custom":1}, "transient":{"display_id":"shared"}, "vendorField": 9});
    emit(&mut doc, "a", "display_data", display.clone());
    emit(&mut doc, "b", "execute_result", {
        let mut value = display;
        value["execution_count"] = json!(3);
        value
    });
    let changed = emit(
        &mut doc,
        "b",
        "update_display_data",
        json!({"data":{"text/plain":"new"}, "metadata":{"custom":2}, "transient":{"display_id":"shared"}}),
    );
    assert_eq!(changed.into_iter().collect::<HashSet<_>>(), HashSet::from(["a".to_owned(), "b".to_owned()]));
    let state = doc.snapshot();
    assert_eq!(state.cells[0].outputs[0]["data"]["text/plain"], "new");
    assert_eq!(state.cells[1].outputs[0]["data"]["text/plain"], "new");
    assert_eq!(state.cells[0].outputs[0]["vendorField"], 9);
    assert_eq!(state.cells[1].outputs[0]["execution_count"], 3);
    assert!(!doc.to_text().contains("display_id"));
    assert!(!doc.to_text().contains("transient"));
}

#[test]
fn deferred_clear_is_applied_only_to_next_output_and_removes_display_targets() {
    let mut doc = two_code_cells();
    emit(
        &mut doc,
        "a",
        "display_data",
        json!({"data":{"text/plain":"old"}, "metadata":{}, "transient":{"display_id":"d"}}),
    );
    let version = doc.version();
    assert!(emit(&mut doc, "a", "clear_output", json!({"wait":true})).is_empty());
    assert_eq!(doc.version(), version);
    assert_eq!(doc.snapshot().cells[0].outputs[0]["data"]["text/plain"], "old");
    emit(&mut doc, "a", "execute_input", json!({"execution_count":2}));
    assert_eq!(doc.snapshot().cells[0].outputs[0]["data"]["text/plain"], "old");
    assert_eq!(emit(&mut doc, "a", "stream", json!({"name":"stdout","text":"replacement"})), ["a"]);
    let state = doc.snapshot();
    assert_eq!(state.cells[0].outputs, vec![json!({"output_type":"stream", "name":"stdout", "text":"replacement"})]);
    assert!(
        emit(
            &mut doc,
            "b",
            "update_display_data",
            json!({"data":{"text/plain":"not resurrected"}, "metadata":{}, "transient":{"display_id":"d"}})
        )
        .is_empty()
    );
    emit(&mut doc, "a", "clear_output", json!({"wait":false}));
    assert_eq!(doc.snapshot().cells[0].outputs, Vec::<Value>::new());
    assert_eq!(doc.snapshot().cells[0].execution_count, Some(2));
}

#[test]
fn streams_merge_only_adjacent_same_names_and_errors_and_mime_data_are_retained() {
    let mut doc = two_code_cells();
    emit(&mut doc, "a", "stream", json!({"name":"stdout", "text":"one"}));
    emit(&mut doc, "a", "stream", json!({"name":"stdout", "text":" two"}));
    emit(&mut doc, "a", "stream", json!({"name":"stderr", "text":"warning"}));
    emit(&mut doc, "a", "stream", json!({"name":"stdout", "text":"three"}));
    emit(
        &mut doc,
        "a",
        "error",
        json!({"ename":"ValueError", "evalue":"bad", "traceback":["line one", "line two"], "vendor":true}),
    );
    emit(
        &mut doc,
        "a",
        "display_data",
        json!({"data":{"image/png":"aW1hZ2U=", "application/vnd.vendor+json":{"x":1}}, "metadata":{"width":100}}),
    );
    let state = doc.snapshot();
    assert_eq!(state.cells[0].outputs[0]["text"], "one two");
    assert_eq!(state.cells[0].outputs[1]["text"], "warning");
    assert_eq!(state.cells[0].outputs[2]["text"], "three");
    assert_eq!(state.cells[0].outputs[3]["traceback"], json!(["line one", "line two"]));
    assert_eq!(state.cells[0].outputs[3]["vendor"], true);
    assert_eq!(state.cells[0].outputs[4]["data"]["application/vnd.vendor+json"]["x"], 1);
}

#[test]
fn save_undo_and_reload_track_the_exact_disk_baseline_and_document_incarnation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("document.ipynb");
    std::fs::write(&path, ORIGINAL).unwrap();
    let mut doc = NotebookDocument::load(&path).unwrap();
    let id = doc.id().to_owned();
    apply(&mut doc, NotebookEdit::SetSource { cell: "second".into(), source: "saved".into() });
    let saved = doc.to_text();
    assert!(!doc.save().unwrap().dirty);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), saved);
    assert!(doc.undo().unwrap().dirty);
    assert_eq!(doc.to_text(), ORIGINAL);
    let version = doc.version();
    let reloaded = doc.reload().unwrap();
    assert_eq!(reloaded.id, id);
    assert!(reloaded.version > version);
    assert!(!reloaded.dirty && !reloaded.can_undo && !reloaded.can_redo);
    assert_eq!(doc.to_text(), saved);
    assert_ne!(NotebookDocument::load(&path).unwrap().id(), id);
}

#[test]
fn external_conflict_is_detected_even_when_clean_and_failed_save_retains_history() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("conflict.ipynb");
    std::fs::write(&path, ORIGINAL).unwrap();
    let mut doc = NotebookDocument::load(&path).unwrap();
    std::fs::write(&path, format!("{ORIGINAL}\n")).unwrap();
    assert_eq!(doc.save().unwrap_err().kind, ErrorKind::OutOfSync);
    apply(&mut doc, NotebookEdit::SetSource { cell: "second".into(), source: "unsaved".into() });
    let unsaved = doc.to_text();
    let version = doc.version();
    assert_eq!(doc.save().unwrap_err().kind, ErrorKind::OutOfSync);
    assert_eq!(doc.to_text(), unsaved);
    assert_eq!(doc.version(), version);
    assert!(doc.snapshot().dirty && doc.snapshot().can_undo);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), format!("{ORIGINAL}\n"));
    std::fs::remove_file(&path).unwrap();
    assert_eq!(doc.save().unwrap_err().kind, ErrorKind::OutOfSync);
    assert!(!path.exists());
    doc.undo().unwrap();
    assert_eq!(doc.to_text(), ORIGINAL);
}

#[test]
fn malformed_source_duplicate_json_keys_unsupported_format_and_invalid_utf8_are_rejected() {
    for text in [
        ORIGINAL.replace(r#"["\u0061\n", "b\n", "\u0063"]"#, "[123]"),
        ORIGINAL.replace("\"nbformat\": 4", "\"nbformat\": 3"),
        ORIGINAL.replace("\"nbformat\": 4", "\"nbformat\": 4, \"nbformat\": 4"),
    ] {
        assert!(NotebookDocument::from_text(PathBuf::from("invalid.ipynb"), text).is_err());
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("invalid.ipynb");
    std::fs::write(&path, [0xff, 0xfe, 0x80]).unwrap();
    assert!(NotebookDocument::load(&path).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), [0xff, 0xfe, 0x80]);
}

#[test]
fn malformed_kernel_output_does_not_apply_a_pending_clear_or_advance_revision() {
    let mut doc = two_code_cells();
    emit(&mut doc, "a", "stream", json!({"name":"stdout", "text":"keep"}));
    emit(&mut doc, "a", "clear_output", json!({"wait":true}));
    let before = doc.to_text();
    let version = doc.version();
    let error = doc.record_output("a", &output("display_data", json!({"data": {}}))).unwrap_err();
    assert_eq!(error.kind, ErrorKind::InvalidInput);
    assert_eq!(doc.to_text(), before);
    assert_eq!(doc.version(), version);
    emit(&mut doc, "a", "stream", json!({"name":"stdout", "text":"replacement"}));
    assert_eq!(doc.snapshot().cells[0].outputs[0]["text"], "replacement");
}

#[test]
fn late_output_never_recreates_deleted_cells() {
    let mut doc = two_code_cells();
    apply(&mut doc, NotebookEdit::DeleteCell { cell: "a".into() });
    let before = doc.to_text();
    let error = doc.record_output("a", &output("stream", json!({"name":"stdout", "text":"late"}))).unwrap_err();
    assert_eq!(error.kind, ErrorKind::NotFound);
    assert_eq!(doc.to_text(), before);
    assert_eq!(doc.snapshot().cells[0].id, "b");
}

#[test]
fn minor_five_existing_duplicate_and_missing_ids_remain_untouched_after_mutation() {
    let text = ORIGINAL.replace("\"id\": \"second\"", "\"id\": \"first\"").replace(", \"id\": \"third\"", "");
    let mut doc = document(&text);
    let state = doc.snapshot();
    assert_eq!(state.cells.iter().map(|cell| &cell.id).collect::<HashSet<_>>().len(), 3);
    assert_eq!(doc.to_text(), text);
    apply(&mut doc, NotebookEdit::SetSource { cell: state.cells[0].id.clone(), source: "changed".into() });
    apply(&mut doc, NotebookEdit::InsertCell { after: Some(state.cells[2].id.clone()), cell_type: "raw".into() });
    let parsed: Value = serde_json::from_str(&doc.to_text()).unwrap();
    assert_eq!(parsed["cells"][0]["id"], "first");
    assert_eq!(parsed["cells"][1]["id"], "first");
    assert!(parsed["cells"][2].get("id").is_none());
    assert_eq!(parsed["cells"][3]["id"], doc.snapshot().cells[3].id);
}

#[test]
fn edited_crlf_bom_notebook_preserves_every_unaffected_byte() {
    let text = format!("\u{feff}{}\r\n", ORIGINAL.replace('\n', "\r\n"));
    let mut doc = document(&text);
    apply(&mut doc, NotebookEdit::SetSource { cell: "second".into(), source: "edited".into() });
    assert_eq!(doc.to_text(), text.replace(r##""# title""##, r#""edited""#));
    doc.undo().unwrap();
    assert_eq!(doc.to_text(), text);
    assert!(!doc.is_dirty());
}

#[test]
fn ineffective_edits_do_not_create_dirty_state_history_or_revisions() {
    let mut doc = two_code_cells();
    let version = doc.version();
    apply(&mut doc, NotebookEdit::SetSource { cell: "a".into(), source: "a()".into() });
    apply(&mut doc, NotebookEdit::SetCellType { cell: "a".into(), cell_type: "code".into() });
    apply(&mut doc, NotebookEdit::MoveCell { cell: "a".into(), before: Some("a".into()) });
    apply(&mut doc, NotebookEdit::MoveCell { cell: "b".into(), before: None });
    doc.begin_execution("a").unwrap();
    assert!(emit(&mut doc, "a", "clear_output", json!({"wait":false})).is_empty());
    let state = doc.snapshot();
    assert_eq!(state.version, version);
    assert!(!state.dirty && !state.can_undo && !state.can_redo);
}

#[test]
fn explicit_output_replacement_strips_transient_fields_without_discarding_user_redo() {
    let mut doc = two_code_cells();
    apply(&mut doc, NotebookEdit::SetSource { cell: "a".into(), source: "changed".into() });
    doc.undo().unwrap();
    let base = doc.version();
    apply(
        &mut doc,
        NotebookEdit::SetOutputs {
            cell: "a".into(),
            execution_count: Some(4),
            outputs: vec![
                json!({"output_type":"vendor.output", "payload":{"keep":true}, "transient":{"display_id":"not persisted"}}),
            ],
        },
    );
    assert!(doc.version() > base);
    assert!(doc.snapshot().can_redo);
    assert!(!doc.to_text().contains("transient"));
    doc.edit(base, NotebookEdit::SetSource { cell: "b".into(), source: "accepted across output-only revision".into() })
        .unwrap();
    assert_eq!(doc.snapshot().cells[0].outputs[0]["payload"]["keep"], true);
}

#[test]
fn malformed_stored_outputs_and_failed_output_edits_never_modify_the_document() {
    let text =
        ORIGINAL.replace("\"outputs\": []", r#""outputs": [{"output_type":"stream","name":"stdout","text":[123]}]"#);
    assert!(NotebookDocument::from_text(PathBuf::from("invalid.ipynb"), text).is_err());
    let mut doc = two_code_cells();
    let before = doc.to_text();
    let version = doc.version();
    let error = doc
        .edit(
            version,
            NotebookEdit::SetOutputs {
                cell: "a".into(),
                execution_count: Some(1),
                outputs: vec![json!({"output_type":"error","ename":"E","evalue":"bad","traceback":[42]})],
            },
        )
        .unwrap_err();
    assert_eq!(error.kind, ErrorKind::InvalidInput);
    assert_eq!(doc.to_text(), before);
    assert_eq!(doc.version(), version);
}
