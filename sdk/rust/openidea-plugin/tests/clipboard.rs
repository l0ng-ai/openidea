use openidea_plugin::{ClipboardContent, Error, host, mock::MockHost};

#[test]
fn reads_text_and_images_behind_their_own_grant() {
    let mock = MockHost::install().with_capabilities(&["clipboard"]);
    mock.set_clipboard(Some("curl https://example.com"), None);
    assert_eq!(host::read_clipboard(), Err(Error::Denied("clipboard.read".into())));

    let mock = mock.with_capabilities(&["clipboard.read"]);
    let text = host::read_clipboard().unwrap();
    assert_eq!(text.text.as_deref(), Some("curl https://example.com"));
    assert_eq!(text.image, None);
    // Reading doesn't grant writing.
    assert_eq!(host::copy_to_clipboard("x"), Err(Error::Denied("clipboard".into())));

    let png = [0x89, b'P', b'N', b'G'];
    mock.set_clipboard(None, Some(&png));
    assert_eq!(host::read_clipboard().unwrap(), ClipboardContent { text: None, image: Some(png.to_vec()) });
    mock.set_clipboard(None, None);
    assert!(host::read_clipboard().unwrap().is_empty());
}

#[test]
fn unattended_calls_and_nested_commands_are_denied() {
    let mock = MockHost::install().with_capabilities(&["clipboard.read", "ide.commands"]);
    mock.set_clipboard(Some("secret"), None);
    mock.set_unattended(true);
    assert!(matches!(host::read_clipboard(), Err(Error::Denied(c)) if c.starts_with("clipboard.read")));
    mock.set_unattended(false);
    assert_eq!(host::read_clipboard().unwrap().text.as_deref(), Some("secret"));

    // Another plugin's command, run through `execute_command`, is not one the user ran.
    mock.on_command("plugin.other.read", |_| Ok(host::read_clipboard()?.text));
    assert!(matches!(host::execute_command("plugin.other.read", None), Err(Error::Denied(_))));
}
