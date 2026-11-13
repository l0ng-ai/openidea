use openidea_plugin::{Decoration, Error, FileDecoration, Range, TextQuery, TextSearch, host, mock::MockHost};

#[test]
fn command_permission_distinguishes_own_commands() {
    let mock = MockHost::install().with_capabilities(&[]);
    for id in ["test.action", "plugin.other.run", "plugin.mock.other.run"] {
        mock.on_command(id, |_| Ok(Some("ok".into())));
    }
    mock.on_own_command("run", |_| Ok(Some("ok".into())));
    for id in ["test.action", "plugin.other.run", "plugin.mock.other.run"] {
        assert!(matches!(host::execute_command(id, None), Err(Error::Denied(c)) if c == "ide.commands"));
    }
    assert_eq!(host::execute_command("plugin.mock.run", None).unwrap().as_deref(), Some("ok"));
    let _mock = mock.with_capabilities(&["ide.commands"]);
    assert!(host::execute_command("test.action", None).is_ok());
    assert!(host::execute_command("plugin.other.run", None).is_ok());
}

#[test]
fn workbench_wrappers_enforce_grants_and_editor_ranges_need_no_grant() {
    let mock = MockHost::install().with_capabilities(&[]);
    mock.open_editor("/project/a.txt", "text", "😀text", &[]);
    mock.add_file("a.txt", "disk");
    let ctx = mock.invocation();
    let editor = ctx.editor().unwrap();
    editor
        .set_selections(&[Range::new(openidea_plugin::Position::new(0, 2), openidea_plugin::Position::new(0, 4))])
        .unwrap();
    editor.reveal(Range::default()).unwrap();
    assert_eq!(mock.revealed_ranges(), [Range::default()]);
    let project = ctx.project().unwrap();
    assert!(matches!(host::open_editors(), Err(Error::Denied(c)) if c == "editor.read"));
    assert!(host::open_editor("a.txt", None).is_err());
    assert!(project.search_text(&TextQuery::default(), 1).is_err());
    assert!(host::problems(None).is_err());
    assert!(host::set_decorations("a.txt", "set", &[]).is_err());
    assert!(host::clear_decorations("set").is_err());
    assert!(host::clear_file_decorations("set").is_err());
    assert!(project.vcs_log(None, 1).is_err());
    assert!(project.vcs_blame("a.txt").is_err());
    assert!(project.vcs_diff(None, None).is_err());
    let _mock = mock.with_capabilities(&["project.read", "editor.read", "vcs.read"]);
    assert_eq!(host::open_editors().unwrap()[0].language, "text");
    host::open_editor("a.txt", Some(Range::default())).unwrap();
    assert!(host::open_editor("../outside", None).is_err());
    assert!(host::problems(None).unwrap().is_empty());
}

#[test]
fn decorations_replace_clear_validate_styles_badges_paths_and_limits() {
    let mock = MockHost::install();
    let item = |style: &str| Decoration {
        range: Range::default(),
        style: style.into(),
        hover: None,
        after: Some("text".into()),
    };
    host::set_decorations("a.txt", "test", &[item("highlight"), item("unknown")]).unwrap();
    assert_eq!(mock.decorations().values().next().unwrap().len(), 1);
    assert!(host::set_decorations("../outside", "test", &[]).is_err());
    host::set_decorations("a.txt", "test", &[]).unwrap();
    assert!(mock.decorations().values().next().unwrap().is_empty());
    host::clear_decorations("test").unwrap();
    assert!(mock.decorations().is_empty());
    let file = |badge: &str| FileDecoration { badge: Some(badge.into()), style: "added".into(), tooltip: None };
    assert!(host::set_file_decoration("a.txt", "test", &file("abc")).is_err());
    host::set_file_decoration("a.txt", "test", &file("😀a")).unwrap();
    host::clear_file_decorations("test").unwrap();
    assert!(mock.file_decorations().is_empty());
    host::set_file_decoration("a.txt", "notes", &file("A")).unwrap();
    host::set_file_note("a.txt", "notes", "entry point", Some("why")).unwrap();
    assert!(mock.file_decorations().is_empty(), "a note replaces the set's annotation");
    assert_eq!(mock.file_notes().values().next(), Some(&("entry point".to_string(), Some("why".to_string()))));
    assert!(host::set_file_note("a.txt", "notes", "two\nlines", None).is_err());
    assert!(host::set_file_note("a.txt", "notes", &"x".repeat(201), None).is_err());
    host::clear_file_decorations("notes").unwrap();
    assert!(mock.file_notes().is_empty());
    for i in 0..50 {
        host::set_decorations("a.txt", &format!("set{i}"), &[]).unwrap();
    }
    assert!(host::set_decorations("a.txt", "overflow", &[]).is_err());
}

#[test]
fn search_limits_and_vcs_trust_are_modelled() {
    let mock = MockHost::install();
    mock.on_search(|query, limit| {
        assert_eq!(query.pattern, "needle");
        assert_eq!(limit, 10_000);
        Ok(TextSearch::default())
    });
    let ctx = mock.invocation();
    let project = ctx.project().unwrap();
    project.search_text(&TextQuery { pattern: "needle".into(), ..Default::default() }, u32::MAX).unwrap();
    mock.set_vcs_reads(Vec::new(), "a.txt", Vec::new(), Some("patch".into()));
    assert_eq!(project.vcs_diff(None, None).unwrap().as_deref(), Some("patch"));
    assert!(project.vcs_diff(None, Some("--output=x")).is_err());
    mock.set_restricted(true);
    assert!(project.vcs_log(None, 1).is_err());
    assert!(project.vcs_blame("a.txt").is_err());
    assert!(project.vcs_diff(None, None).is_err());
}
