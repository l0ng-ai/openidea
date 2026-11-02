//! Saved passwords against the real OS credential store (Windows Credential
//! Manager, macOS Keychain, Secret Service). Ignored by default: it needs a
//! credential store and may show a system prompt. `cargo test -p ide-ssh --test
//! os_credential_store -- --ignored`

use ide_ssh::secrets::SecretFile;

#[test]
#[ignore = "uses the OS credential store"]
fn saves_moves_and_forgets_in_the_os_store() {
    assert!(keyring::Entry::store_status().is_ok(), "no OS credential store");
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("git-credentials.json");
    std::fs::write(&path, r#"{"https://old.example": "me\nold-os-pw"}"#).unwrap();
    let file = SecretFile::new(path.clone());
    file.set("https://new.example", "me\nnew-os-pw").unwrap();
    let on_disk = std::fs::read_to_string(&path).unwrap();
    assert!(!on_disk.contains("old-os-pw") && !on_disk.contains("new-os-pw"), "{on_disk}");

    let reopened = SecretFile::new(path);
    assert_eq!(reopened.get("https://old.example").as_deref(), Some("me\nold-os-pw"));
    assert_eq!(reopened.get("https://new.example").as_deref(), Some("me\nnew-os-pw"));
    #[cfg(windows)]
    {
        let listed = std::process::Command::new("cmdkey").arg("/list").output().unwrap();
        let listed = String::from_utf8_lossy(&listed.stdout);
        assert_eq!(listed.matches("ai.l0ng.openidea/").count(), 2, "{listed}");
    }
    for key in reopened.keys() {
        reopened.delete(&key);
    }
    assert_eq!(reopened.keys(), Vec::<String>::new());
    assert_eq!(reopened.get("https://old.example"), None);
}
