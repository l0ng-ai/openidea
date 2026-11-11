//! Laravel find usages and rename from files that aren't PHP, while the
//! native PHP engine runs (`ide_php::frameworks::laravel::refs::files`):
//!
//! - [`DotenvService`] (`dotenv`): on a key of the project's `.env` or
//!   `.env.example`, its `env('KEY')` usages, and renaming it in both files
//!   and every usage.
//! - [`TranslationJsonService`] (`json`): on a key of one of the project's
//!   JSON locale files (`lang/fr.json`), its `__('…')` usages and the key in
//!   the other locales, and renaming it in all of them.
//! - [`InertiaPageService`] (Vue, Svelte, TSX and JSX): on the word naming
//!   an Inertia page's file (`Index` in `Posts/Index.vue`, the component's
//!   name), the page's `Inertia::render('Posts/Index')` usages, and renaming
//!   the page (its file, that word and every usage).
//!
//! Anywhere else both answer "not handled", so the requests go to the
//! language servers as before.

use std::path::Path;
use std::sync::Arc;

use ide_core::{CancellationToken, DocId, FileEdit, Location, Pos, Range, TextEdit};
use ide_lsp::types::{References, Renamed};
use ide_workspace::{DocumentInfo, Documents};

use crate::language_service::{Answer, LanguageService};
use crate::php::PhpEngineSlot;

/// The languages of Inertia page files.
pub(crate) const PAGE_LANGUAGES: [&str; 4] = ["vue", "svelte", "typescriptreact", "javascriptreact"];

/// An open local document (not a virtual or oversized one).
fn local(documents: &Documents, doc: DocId) -> Option<DocumentInfo> {
    let info = documents.snapshot(doc).ok()?;
    (info.uri.is_none() && !info.large).then_some(info)
}

fn locations(usages: Vec<ide_php::navigate::Usage>) -> References {
    let locations = usages.into_iter().map(|usage| Location::file(usage.path, usage.range)).collect();
    References { locations, ..References::default() }
}

/// See the module documentation.
pub(crate) struct DotenvService {
    pub(crate) documents: Arc<Documents>,
    pub(crate) php: Arc<PhpEngineSlot>,
}

impl LanguageService for DotenvService {
    fn references(
        &self,
        doc: DocId,
        pos: Pos,
        include_declaration: bool,
        _project_wide: bool,
        cancel: &CancellationToken,
    ) -> Answer<References> {
        let info = local(&self.documents, doc)?;
        let engine = self.php.engine()?;
        let found = engine.laravel_env_references(&info.path, &info.text, pos, include_declaration, cancel)?;
        Some(found.map(locations))
    }

    fn prepare_rename(&self, doc: DocId, pos: Pos) -> Answer<Option<Range>> {
        let info = local(&self.documents, doc)?;
        let engine = self.php.engine()?;
        engine.laravel_env_prepare_rename(&info.path, &info.text, pos).map(|range| Ok(Some(range)))
    }

    fn rename(&self, doc: DocId, pos: Pos, new_name: &str, cancel: &CancellationToken) -> Answer<Renamed> {
        let info = local(&self.documents, doc)?;
        let engine = self.php.engine()?;
        let edit = engine.laravel_env_rename(&info.path, &info.text, pos, new_name, cancel)?;
        Some(edit.map(|edit| Renamed { edit, ..Renamed::default() }))
    }
}

/// See the module documentation.
pub(crate) struct TranslationJsonService {
    pub(crate) documents: Arc<Documents>,
    pub(crate) php: Arc<PhpEngineSlot>,
}

impl LanguageService for TranslationJsonService {
    fn references(
        &self,
        doc: DocId,
        pos: Pos,
        include_declaration: bool,
        _project_wide: bool,
        cancel: &CancellationToken,
    ) -> Answer<References> {
        let info = local(&self.documents, doc)?;
        let engine = self.php.engine()?;
        let found =
            engine.laravel_translation_json_references(&info.path, &info.text, pos, include_declaration, cancel)?;
        Some(found.map(locations))
    }

    fn prepare_rename(&self, doc: DocId, pos: Pos) -> Answer<Option<Range>> {
        let info = local(&self.documents, doc)?;
        let engine = self.php.engine()?;
        engine.laravel_translation_json_prepare_rename(&info.path, &info.text, pos).map(|range| Ok(Some(range)))
    }

    fn rename(&self, doc: DocId, pos: Pos, new_name: &str, cancel: &CancellationToken) -> Answer<Renamed> {
        let info = local(&self.documents, doc)?;
        let engine = self.php.engine()?;
        let edit = engine.laravel_translation_json_rename(&info.path, &info.text, pos, new_name, cancel)?;
        Some(edit.map(|edit| Renamed { edit, ..Renamed::default() }))
    }
}

/// See the module documentation.
pub(crate) struct InertiaPageService {
    pub(crate) documents: Arc<Documents>,
    pub(crate) php: Arc<PhpEngineSlot>,
}

/// The range of the word at `pos` of `text` when it is the name of the file
/// at `path` (its name up to the first `.`).
pub(crate) fn page_word_at(path: &Path, text: &str, pos: Pos) -> Option<Range> {
    let stem = path.file_name()?.to_str()?.split('.').next()?;
    let line = text.split('\n').nth(pos.line as usize)?;
    // UTF-16 columns to bytes; identifiers are ASCII here.
    let mut col = 0u32;
    let mut at = line.len();
    for (byte, ch) in line.char_indices() {
        if col >= pos.col {
            at = byte;
            break;
        }
        col += ch.len_utf16() as u32;
    }
    let is_word = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'$';
    let bytes = line.as_bytes();
    let start = (0..at).rev().take_while(|&i| is_word(bytes[i])).last().unwrap_or(at);
    let end = (at..bytes.len()).find(|&i| !is_word(bytes[i])).unwrap_or(bytes.len());
    if start == end || &line[start..end] != stem || !line.is_char_boundary(start) {
        return None;
    }
    let utf16 = |byte: usize| line[..byte].encode_utf16().count() as u32;
    Some(Range::new(Pos::new(pos.line, utf16(start)), Pos::new(pos.line, utf16(end))))
}

impl InertiaPageService {
    /// The document and the page word at `pos`, when the document is an
    /// Inertia page.
    fn page(&self, doc: DocId, pos: Pos) -> Option<(DocumentInfo, Range, Arc<ide_php::engine::PhpEngine>)> {
        let info = local(&self.documents, doc)?;
        let range = page_word_at(&info.path, &info.text, pos)?;
        let engine = self.php.engine()?;
        engine.laravel_inertia_page_name(&info.path)?;
        Some((info, range, engine))
    }
}

impl LanguageService for InertiaPageService {
    fn references(
        &self,
        doc: DocId,
        pos: Pos,
        include_declaration: bool,
        _project_wide: bool,
        cancel: &CancellationToken,
    ) -> Answer<References> {
        let (info, _, engine) = self.page(doc, pos)?;
        let found = engine.laravel_inertia_page_references(&info.path, include_declaration, cancel)?;
        Some(found.map(locations))
    }

    fn prepare_rename(&self, doc: DocId, pos: Pos) -> Answer<Option<Range>> {
        let (_, range, _) = self.page(doc, pos)?;
        Some(Ok(Some(range)))
    }

    /// The page's rename, with the word itself edited before the file moves.
    fn rename(&self, doc: DocId, pos: Pos, new_name: &str, cancel: &CancellationToken) -> Answer<Renamed> {
        let (info, range, engine) = self.page(doc, pos)?;
        let edit = engine.laravel_inertia_page_rename(&info.path, new_name, cancel)?;
        Some(edit.map(|mut edit| {
            let word = TextEdit { range, new_text: new_name.to_owned() };
            edit.files.insert(0, FileEdit::Edit { path: info.path.clone(), edits: vec![word], version: None });
            Renamed { edit, ..Renamed::default() }
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::{IdeEvent, LanguageId, SharedSink};

    #[test]
    fn the_page_word_is_the_files_name() {
        let path = Path::new("/app/resources/js/Pages/Posts/Index.vue");
        let text = "<script setup>\ndefineOptions({ name: 'Index' })\n</script>\n";
        assert_eq!(page_word_at(path, text, Pos::new(1, 25)), Some(Range::new(Pos::new(1, 23), Pos::new(1, 28))));
        // At either end of the word too.
        assert!(page_word_at(path, text, Pos::new(1, 23)).is_some());
        assert!(page_word_at(path, text, Pos::new(1, 28)).is_some());
        // Other words, and other files.
        assert_eq!(page_word_at(path, text, Pos::new(1, 18)), None);
        assert_eq!(page_word_at(path, text, Pos::new(0, 3)), None);
        let tsx = Path::new("/app/resources/js/Pages/Show.page.tsx");
        let text = "export default function Show() {}\n";
        assert_eq!(page_word_at(tsx, text, Pos::new(0, 26)), Some(Range::new(Pos::new(0, 24), Pos::new(0, 28))));
    }

    #[test]
    fn finds_usages_of_and_renames_env_keys_from_env_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let write = |rel: &str, text: &str| {
            let path = root.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, text).unwrap();
            path
        };
        write("composer.json", r#"{"require": {"laravel/framework": "^11.0"}}"#);
        let config = write("config/app.php", "<?php\nreturn [\n    'name' => env('APP_NAME', 'Laravel'),\n];\n");
        let env = write(".env", "APP_NAME=Blog\nAPP_ENV=local\n");
        let example = write(".env.example", "APP_NAME=Laravel\n");
        let documents = Arc::new(Documents::new(
            Arc::new(|_: IdeEvent| {}),
            Box::new(|path: &Path, _| {
                LanguageId::new(if path.file_name().is_some_and(|n| n.to_string_lossy().starts_with(".env")) {
                    "dotenv"
                } else {
                    "php"
                })
            }),
        ));
        let sink: SharedSink = Arc::new(|_: IdeEvent| {});
        let php = Arc::new(PhpEngineSlot::new(&root, &root.join(".cache"), sink, documents.clone()));
        let service = DotenvService { documents: documents.clone(), php: php.clone() };
        let doc = documents.open(&env).unwrap().id;
        let cancel = CancellationToken::new();
        // Without the engine: not handled.
        assert!(service.references(doc, Pos::new(0, 2), true, true, &cancel).is_none());

        let mut settings = ide_core::settings::Settings::default();
        settings.languages.php.engine = ide_core::settings::PhpEngineKind::Native;
        php.apply(&settings);
        let engine = php.engine().expect("the engine");
        assert!(engine.wait_idle(std::time::Duration::from_secs(60)));

        let refs = service.references(doc, Pos::new(0, 2), true, true, &cancel).unwrap().unwrap();
        let mut found: Vec<(std::path::PathBuf, u32)> = refs
            .locations
            .into_iter()
            .map(|l| (std::path::PathBuf::from(l.path.clone()), l.range.start.line))
            .collect();
        found.sort();
        let mut expected = vec![(env.clone(), 0), (example.clone(), 0), (config.clone(), 2)];
        expected.sort();
        assert_eq!(found, expected);
        // On a value: left to the language servers.
        assert!(service.references(doc, Pos::new(0, 11), true, true, &cancel).is_none());

        assert_eq!(
            service.prepare_rename(doc, Pos::new(0, 2)).unwrap().unwrap(),
            Some(Range::new(Pos::new(0, 0), Pos::new(0, 8)))
        );
        let renamed = service.rename(doc, Pos::new(0, 2), "SITE_NAME", &cancel).unwrap().unwrap();
        let mut files: Vec<std::path::PathBuf> = renamed
            .edit
            .files
            .iter()
            .map(|file| match file {
                FileEdit::Edit { path, edits, .. } => {
                    assert!(edits.iter().all(|edit| edit.new_text == "SITE_NAME"));
                    std::path::PathBuf::from(path.clone())
                }
                other => panic!("{other:?}"),
            })
            .collect();
        files.sort();
        let mut expected = vec![env, example, config];
        expected.sort();
        assert_eq!(files, expected);
        php.shutdown();
    }

    #[test]
    fn finds_usages_of_and_renames_translation_keys_from_json_locale_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let write = |rel: &str, text: &str| {
            let path = root.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, text).unwrap();
            path
        };
        write("composer.json", r#"{"require": {"laravel/framework": "^11.0"}}"#);
        let view = write("app/Http/Home.php", "<?php\n\nfunction home()\n{\n    return __('Read more');\n}\n");
        let en = write("lang/en.json", "{\n    \"Read more\": \"Read more\"\n}\n");
        let fr = write("lang/fr.json", "{\n    \"Read more\": \"Lire la suite\"\n}\n");
        let other = write("package.json", "{\n    \"Read more\": \"x\"\n}\n");
        let documents = Arc::new(Documents::new(
            Arc::new(|_: IdeEvent| {}),
            Box::new(|path: &Path, _| {
                LanguageId::new(if path.extension().is_some_and(|e| e == "json") { "json" } else { "php" })
            }),
        ));
        let sink: SharedSink = Arc::new(|_: IdeEvent| {});
        let php = Arc::new(PhpEngineSlot::new(&root, &root.join(".cache"), sink, documents.clone()));
        let service = TranslationJsonService { documents: documents.clone(), php: php.clone() };
        let doc = documents.open(&fr).unwrap().id;
        let other_doc = documents.open(&other).unwrap().id;
        let cancel = CancellationToken::new();
        // Without the engine: not handled.
        assert!(service.references(doc, Pos::new(1, 8), true, true, &cancel).is_none());

        let mut settings = ide_core::settings::Settings::default();
        settings.languages.php.engine = ide_core::settings::PhpEngineKind::Native;
        php.apply(&settings);
        let engine = php.engine().expect("the engine");
        assert!(engine.wait_idle(std::time::Duration::from_secs(60)));

        let refs = service.references(doc, Pos::new(1, 8), true, true, &cancel).unwrap().unwrap();
        let mut found: Vec<(std::path::PathBuf, u32)> = refs
            .locations
            .into_iter()
            .map(|l| (std::path::PathBuf::from(l.path.clone()), l.range.start.line))
            .collect();
        found.sort();
        let mut expected = vec![(en.clone(), 1), (fr.clone(), 1), (view.clone(), 4)];
        expected.sort();
        assert_eq!(found, expected);
        // On a translation, or in a JSON file that isn't a locale's: left to
        // the language servers.
        assert!(service.references(doc, Pos::new(1, 22), true, true, &cancel).is_none());
        assert!(service.references(other_doc, Pos::new(1, 8), true, true, &cancel).is_none());

        assert_eq!(
            service.prepare_rename(doc, Pos::new(1, 8)).unwrap().unwrap(),
            Some(Range::new(Pos::new(1, 5), Pos::new(1, 14)))
        );
        let renamed = service.rename(doc, Pos::new(1, 8), "Continue", &cancel).unwrap().unwrap();
        let mut files: Vec<std::path::PathBuf> = renamed
            .edit
            .files
            .iter()
            .map(|file| match file {
                FileEdit::Edit { path, edits, .. } => {
                    assert!(edits.iter().all(|edit| edit.new_text == "Continue"));
                    std::path::PathBuf::from(path.clone())
                }
                other => panic!("{other:?}"),
            })
            .collect();
        files.sort();
        let mut expected = vec![en, fr, view];
        expected.sort();
        assert_eq!(files, expected);
        php.shutdown();
    }
}
