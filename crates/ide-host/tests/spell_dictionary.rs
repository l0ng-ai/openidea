//! Appending a word to a custom dictionary file (Typo › Save to '…').
use ide_core::NullSink;
use ide_host::ops;
use ide_host::{Host, HostConfig};
use std::path::Path;
use std::sync::Arc;

fn host(base: &Path) -> Arc<Host> {
    Arc::new(Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    }))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn saves_words_to_project_relative_and_home_dictionaries() {
    let tmp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap().join("project");
    std::fs::create_dir_all(&root).unwrap();
    let host = host(&tmp.path().join("app"));
    host.trust.decide(&root, true, false).unwrap();
    host.open_project("main", &root).unwrap();

    // A missing file is created as a plain word list.
    let file =
        ops::spell::spell_save_to_dictionary(&host, "main", "docs/team.dic".into(), "Pyorm".into()).await.unwrap();
    assert_eq!(file, root.join("docs/team.dic").to_string_lossy());
    assert_eq!(std::fs::read_to_string(root.join("docs/team.dic")).unwrap(), "Pyorm\n");

    // A second word is appended; the first stays.
    ops::spell::spell_save_to_dictionary(&host, "main", "docs/team.dic".into(), "mesage".into()).await.unwrap();
    assert_eq!(std::fs::read_to_string(root.join("docs/team.dic")).unwrap(), "Pyorm\nmesage\n");

    // The same word again changes nothing and reports no file.
    let file =
        ops::spell::spell_save_to_dictionary(&host, "main", "docs/team.dic".into(), "mesage".into()).await.unwrap();
    assert_eq!(file, "");
    assert_eq!(std::fs::read_to_string(root.join("docs/team.dic")).unwrap(), "Pyorm\nmesage\n");

    // A file without a final newline is joined with one.
    std::fs::write(root.join("docs/team.dic"), "Pyorm\nmesage").unwrap();
    ops::spell::spell_save_to_dictionary(&host, "main", "docs/team.dic".into(), "wrng".into()).await.unwrap();
    assert_eq!(std::fs::read_to_string(root.join("docs/team.dic")).unwrap(), "Pyorm\nmesage\nwrng\n");

    // A `~/…` entry resolves against the home folder (`dirs` reads the real
    // profile directory on Windows, so this case runs on Unix only).
    #[cfg(unix)]
    {
        let home = dunce::canonicalize(tmp.path().join("home")).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        // SAFETY: the runtime's worker threads may be parked; no test reads
        // these variables concurrently.
        unsafe {
            std::env::set_var("HOME", &home);
            let file =
                ops::spell::spell_save_to_dictionary(&host, "main", "~/words/personal.txt".into(), "kurz".into())
                    .await
                    .unwrap();
            assert_eq!(file, home.join("words/personal.txt").to_string_lossy());
            assert_eq!(std::fs::read_to_string(home.join("words/personal.txt")).unwrap(), "kurz\n");
            std::env::remove_var("HOME");
        }
    }

    // Not a word: no file is written.
    assert!(
        ops::spell::spell_save_to_dictionary(&host, "main", "docs/team.dic".into(), "two words".into()).await.is_err()
    );
    assert!(ops::spell::spell_save_to_dictionary(&host, "main", "docs/team.dic".into(), "123".into()).await.is_err());
    host.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_hunspell_dictionary_keeps_its_word_count_line() {
    let tmp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap().join("project");
    std::fs::create_dir_all(&root).unwrap();
    let host = host(&tmp.path().join("app"));
    host.trust.decide(&root, true, false).unwrap();
    host.open_project("main", &root).unwrap();

    std::fs::write(root.join("de_TEST.dic"), "2\npyorm\nmesage\n").unwrap();
    std::fs::write(root.join("de_TEST.aff"), "SET UTF-8\n").unwrap();
    ops::spell::spell_save_to_dictionary(&host, "main", "de_TEST.dic".into(), "kurz".into()).await.unwrap();
    // The count line tracks the words, the entries keep their order.
    assert_eq!(std::fs::read_to_string(root.join("de_TEST.dic")).unwrap(), "3\npyorm\nmesage\nkurz\n");

    // Without an .aff beside it, the same file is a word list: no count line.
    std::fs::remove_file(root.join("de_TEST.aff")).unwrap();
    ops::spell::spell_save_to_dictionary(&host, "main", "de_TEST.dic".into(), "wrng".into()).await.unwrap();
    assert_eq!(std::fs::read_to_string(root.join("de_TEST.dic")).unwrap(), "3\npyorm\nmesage\nkurz\nwrng\n");
    host.shutdown().await;
}
