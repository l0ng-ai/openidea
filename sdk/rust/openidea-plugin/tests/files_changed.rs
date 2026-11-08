use openidea_plugin::{Event, EventKind, FilesChanged};

#[test]
fn additive_files_changed_payload_is_typed_and_lossless() {
    let batch = FilesChanged {
        created: vec!["/project/新建😀.rs".into()],
        modified: vec![r"C:\project\a.rs".into()],
        removed: vec!["/project/gone.rs".into()],
    };
    assert_eq!(EventKind::FilesChanged.name(), "files-changed");
    let data = serde_json::to_string(&batch).unwrap();
    assert_eq!(Event::from_other("files-changed".into(), data), Event::FilesChanged(batch));
}

#[test]
fn unknown_and_malformed_events_keep_the_original_payload() {
    for (kind, data) in
        [("future", "{}"), ("files-changed", "bad"), ("files-changed", r#"{"created":[],"modified":[],"removed":[1]}"#)]
    {
        assert_eq!(Event::from_other(kind.into(), data.into()), Event::Other { kind: kind.into(), data: data.into() });
    }
}

#[test]
fn mock_filters_files_changed_with_the_events_capability() {
    use openidea_plugin::{Error, host, mock::MockHost};
    let mock = MockHost::install();
    host::subscribe_paths("files-changed", &["config/*.yaml"]).unwrap();
    assert_eq!(mock.path_subscriptions()["files-changed"], ["config/*.yaml"]);
    assert!(mock.subscriptions().contains(&EventKind::FilesChanged));
    host::subscribe_paths("files-changed", &[]).unwrap();
    assert!(mock.path_subscriptions()["files-changed"].is_empty());
    host::subscribe(EventKind::FilesChanged).unwrap();
    assert!(mock.path_subscriptions().is_empty());
    host::subscribe_paths("files-changed", &["**/*.yaml"]).unwrap();
    host::unsubscribe(EventKind::FilesChanged);
    assert!(mock.path_subscriptions().is_empty());
    assert!(!mock.subscriptions().contains(&EventKind::FilesChanged));
    let _denied = MockHost::install().with_capabilities(&[]);
    assert!(matches!(host::subscribe_paths("files-changed", &[]), Err(Error::Denied(_))));
}
