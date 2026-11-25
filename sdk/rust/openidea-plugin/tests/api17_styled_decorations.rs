use openidea_plugin::{Decoration, DecorationColors, Error, Range, StyledDecoration, host, mock::MockHost};

fn styled(style: &str, foreground: Option<&str>, background: Option<&str>) -> StyledDecoration {
    StyledDecoration {
        range: Range::default(),
        style: style.into(),
        hover: Some("TODO".into()),
        after: None,
        markdown_hover: None,
        colors: Some(DecorationColors {
            foreground: foreground.map(Into::into),
            background: background.map(Into::into),
        }),
    }
}

#[test]
fn styled_decorations_validate_and_normalize_colors() {
    let mock = MockHost::install();
    host::set_styled_decorations(
        "a.txt",
        "todo",
        &[
            styled("", Some("#1A1A1A"), Some("#FFEB3B80")),
            styled("highlight", None, Some("#00e5ff")),
            styled("", None, None),
            StyledDecoration { colors: None, ..styled("", None, None) },
        ],
    )
    .unwrap();
    let items = mock.styled_decorations().into_values().next().unwrap();
    assert_eq!(items.len(), 2, "an empty style needs colors");
    assert_eq!(
        items[0].colors,
        Some(DecorationColors { foreground: Some("#1a1a1a".into()), background: Some("#ffeb3b80".into()) })
    );
    for bad in ["red", "#fff", "#12345g", "rgb(0,0,0)", "#ffffff; x: y"] {
        let err = host::set_styled_decorations("a.txt", "todo", &[styled("", Some(bad), None)]).unwrap_err();
        assert!(matches!(err, Error::Invalid(ref m) if m.contains("#rrggbb")), "{bad}: {err:?}");
    }
    assert_eq!(mock.styled_decorations().into_values().next().unwrap().len(), 2, "a rejected call changes nothing");
}

#[test]
fn styled_sets_share_ids_and_limits_with_plain_sets() {
    let mock = MockHost::install();
    let plain = Decoration { range: Range::default(), style: "highlight".into(), hover: None, after: None };
    host::set_decorations("a.txt", "todo", &[plain]).unwrap();
    host::set_styled_decorations("a.txt", "todo", &[styled("", Some("#000000"), None)]).unwrap();
    assert!(mock.decorations().is_empty(), "the last call for a set id wins");
    assert_eq!(mock.styled_decorations().len(), 1);
    for i in 0..49 {
        host::set_decorations("a.txt", &format!("set{i}"), &[]).unwrap();
    }
    assert!(host::set_styled_decorations("a.txt", "overflow", &[]).is_err());
    host::clear_decorations("todo").unwrap();
    assert!(mock.styled_decorations().is_empty());
    let _mock = mock.with_capabilities(&[]);
    assert!(matches!(
        host::set_styled_decorations("a.txt", "todo", &[]),
        Err(Error::Denied(c)) if c == "project.read"
    ));
}
