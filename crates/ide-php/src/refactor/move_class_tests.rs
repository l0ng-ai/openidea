//! Move class: the file created for the class and what is left of the old
//! one.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use ide_core::{DocId, FileEdit, IdeEvent, Pos, Range, SharedSink};

use super::move_class::MOVE_CLASS;
use crate::engine::{CACHE_SUBDIR, EngineConfig, PhpEngine};
use crate::imports::{ACTION_KINDS, ImportAction};
use crate::project::LayoutConfig;
use crate::stubs::{PhpVersion, StubFilter};

const WAIT: Duration = Duration::from_secs(60);
const CARET: &str = "/*|*/";
const COMPOSER: &str = r#"{"autoload": {"psr-4": {"App\\": "src/"}}}"#;

struct Fixture {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    engine: Arc<PhpEngine>,
}

/// A project with `files` (paths under the root); `composer` is written as
/// `composer.json` when given.
fn fixture(composer: Option<&str>, files: &[(&str, &str)]) -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(tmp.path()).unwrap();
    let root = base.join("project");
    std::fs::create_dir_all(root.join("src")).unwrap();
    if let Some(composer) = composer {
        std::fs::write(root.join("composer.json"), composer).unwrap();
    }
    for (name, text) in files {
        let path = root.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
    let sink: SharedSink = Arc::new(|_: IdeEvent| {});
    let config = EngineConfig {
        cache_dir: base.join("cache").join(CACHE_SUBDIR),
        layout: LayoutConfig { root: root.clone(), ..LayoutConfig::default() },
        stubs: StubFilter::all_extensions(PhpVersion::LATEST),
    };
    let engine = PhpEngine::open(config, sink).unwrap();
    assert!(engine.wait_idle(WAIT));
    Fixture { _tmp: tmp, root, engine }
}

fn pos(text: &str, at: usize) -> Pos {
    let before = &text[..at];
    let line = before.matches('\n').count() as u32;
    let col = before.rsplit('\n').next().unwrap().encode_utf16().count() as u32;
    Pos::new(line, col)
}

impl Fixture {
    /// The Move class actions with the caret marked in `marked`, opened as
    /// `name`.
    fn actions(&self, name: &str, marked: &str) -> (String, Vec<ImportAction>) {
        let at = marked.find(CARET).expect("a caret");
        let text = marked.replacen(CARET, "", 1);
        let caret = pos(&text, at);
        let doc = DocId(1);
        self.engine.document_opened(doc, &self.root.join(name), 1, &text);
        let actions = self.engine.code_actions(doc, Range::new(caret, caret), &[MOVE_CLASS.to_owned()]).expect("open");
        self.engine.document_closed(doc);
        (text, actions)
    }

    fn relative(&self, path: &Path) -> String {
        path.strip_prefix(&self.root).unwrap().to_string_lossy().replace('\\', "/")
    }
}

/// The created file (relative path and text) and the old file's new text.
fn applied(fixture: &Fixture, old: &str, action: &ImportAction) -> (String, String, String) {
    let [
        FileEdit::Create { path: created, overwrite: false },
        FileEdit::Edit { path: new_path, edits: new_edits, .. },
        FileEdit::Edit { edits: old_edits, .. },
    ] = action.edit.files.as_slice()
    else {
        panic!("create, fill, edit: {:?}", action.edit.files);
    };
    assert_eq!(created, new_path);
    let mut new_doc = ide_text::Document::new("");
    new_doc.apply_edits(new_edits).unwrap();
    let mut old_doc = ide_text::Document::new(old);
    old_doc.apply_edits(old_edits).unwrap();
    (fixture.relative(&PathBuf::from(created.clone())), new_doc.text().to_string(), old_doc.text().to_string())
}

#[test]
fn moves_a_class_into_its_psr4_file() {
    let models = r"<?php

declare(strict_types=1);

namespace App\Models;

use App\Support\Clock;
use App\Support\Money;
use Carbon\Carbon as Date;

class User
{
    public function born(): Date
    {
        return new Date();
    }

    public function clock(): Clock
    {
        return new Clock();
    }
}

/**
 * An invoice.
 */
#[\Attribute]
final class In/*|*/voice
{
    public function total(): Money
    {
        return new Money(Date::now());
    }
}
";
    let f = fixture(Some(COMPOSER), &[("src/Models/User.php", "<?php\n")]);
    let (text, actions) = f.actions("src/Models/User.php", models);
    let [action] = actions.as_slice() else { panic!("one action: {actions:?}") };
    assert_eq!(action.title, "Move class 'Invoice' to src/Models/Invoice.php");
    let (created, new_text, old_text) = applied(&f, &text, action);
    assert_eq!(created, "src/Models/Invoice.php");
    assert_eq!(
        new_text,
        r"<?php

declare(strict_types=1);

namespace App\Models;

use App\Support\Money;
use Carbon\Carbon as Date;

/**
 * An invoice.
 */
#[\Attribute]
final class Invoice
{
    public function total(): Money
    {
        return new Money(Date::now());
    }
}
"
    );
    assert_eq!(
        old_text,
        r"<?php

declare(strict_types=1);

namespace App\Models;

use App\Support\Clock;
use Carbon\Carbon as Date;

class User
{
    public function born(): Date
    {
        return new Date();
    }

    public function clock(): Clock
    {
        return new Clock();
    }
}
"
    );
    let open = action.open.as_ref().expect("opens the new file");
    assert_eq!(open.range.start, Pos::new(13, 12));
}

#[test]
fn the_path_follows_the_namespace_or_the_current_folder() {
    // The namespace's PSR-4 folder, not the file's.
    let text = "<?php\nnamespace App\\Http;\n\nclass Controller\n{\n}\n\nclass Req/*|*/uest\n{\n}\n";
    let f = fixture(Some(COMPOSER), &[]);
    let (_, actions) = f.actions("src/misc.php", text);
    assert_eq!(actions[0].title, "Move class 'Request' to src/Http/Request.php");

    // Outside the autoload roots: next to the file.
    let f = fixture(None, &[]);
    let (text, actions) = f.actions("lib/all.php", "<?php\nclass A\n{\n}\n\ninterface /*|*/B\n{\n}\n");
    let (created, new_text, old_text) = applied(&f, &text, &actions[0]);
    assert_eq!(created, "lib/B.php");
    assert_eq!(new_text, "<?php\n\ninterface B\n{\n}\n");
    assert_eq!(old_text, "<?php\nclass A\n{\n}\n");

    // A braced namespace: the class comes out at column 0.
    let text =
        "<?php\nnamespace App {\n    class A\n    {\n    }\n\n    class /*|*/B\n    {\n        public $x;\n    }\n}\n";
    let (text, actions) = f.actions("lib/all.php", text);
    let (_, new_text, old_text) = applied(&f, &text, &actions[0]);
    assert_eq!(new_text, "<?php\n\nnamespace App;\n\nclass B\n{\n    public $x;\n}\n");
    assert_eq!(old_text, "<?php\nnamespace App {\n    class A\n    {\n    }\n}\n");
}

#[test]
fn not_offered_where_it_would_not_help() {
    let f = fixture(Some(COMPOSER), &[("src/Taken.php", "<?php\nnamespace App;\n\nclass Taken\n{\n}\n")]);
    let none = |name: &str, text: &str| assert!(f.actions(name, text).1.is_empty(), "{text}");
    // One class in the file.
    none("src/Solo.php", "<?php\nnamespace App;\n\nclass /*|*/Solo\n{\n}\n");
    // The class the file is named after.
    none("src/A.php", "<?php\nnamespace App;\n\nclass /*|*/A\n{\n}\n\nclass B\n{\n}\n");
    // Its file exists already.
    none("src/x.php", "<?php\nnamespace App;\n\nclass /*|*/Taken\n{\n}\n\nclass B\n{\n}\n");
    // The caret in the body, and a conditional declaration.
    none("src/x.php", "<?php\nnamespace App;\n\nclass C\n{\n    /*|*/\n}\n\nclass B\n{\n}\n");
    none("src/x.php", "<?php\nnamespace App;\n\nclass C\n{\n}\n\nif (true) {\n    class /*|*/D\n    {\n    }\n}\n");
    // Offered on the other class of the first file.
    let (_, actions) = f.actions("src/A.php", "<?php\nnamespace App;\n\nclass A\n{\n}\n\nclass /*|*/B\n{\n}\n");
    assert_eq!(actions.len(), 1);
    assert!(ACTION_KINDS.contains(&MOVE_CLASS));
}
