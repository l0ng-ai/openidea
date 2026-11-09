//! Find usages and rename starting from files that aren't PHP: a line of
//! `.env` or `.env.example` (the `envKey` it sets) and an Inertia page file
//! (the `inertiaPage` it is). The host's services for those languages ask
//! these ([`PhpEngine::laravel_env_references`],
//! [`PhpEngine::laravel_inertia_page_references`], and the rename
//! counterparts); the usages and edits are the kinds' own
//! ([`PhpEngine::kind_usages`], [`PhpEngine::kind_rename`]).

use std::path::Path;

use ide_core::{CancellationToken, IdeError, IdeResult, Pos, Range, WorkspaceEdit};

use super::{EnvKey, InertiaPageKind, RefContext, ReferenceKind, RenameTarget};
use crate::engine::PhpEngine;
use crate::frameworks::laravel::env::{ENV_FILES, parse_line};
use crate::navigate::Usage;
use crate::project::normalize;

/// The key a line of an environment file sets, when `pos` is on it: the
/// key and its range.
pub fn env_key_at(text: &str, pos: Pos) -> Option<(String, Range)> {
    let line = text.split('\n').nth(pos.line as usize)?.trim_end_matches('\r');
    let (key, _, start, end) = parse_line(line)?;
    // The text before the key is ASCII (white space, `export`): its bytes
    // are its UTF-16 columns.
    let (start, end) = (start as u32, end as u32);
    (start..=end).contains(&pos.col).then(|| (key, Range::new(Pos::new(pos.line, start), Pos::new(pos.line, end))))
}

impl PhpEngine {
    /// The key at `pos` of `text`, the text of `path`, when `path` is the
    /// project's `.env` or `.env.example`, with the reference context.
    fn env_subject(&self, path: &Path, text: &str, pos: Pos) -> Option<(RefContext<'_>, String, Range)> {
        let cx = self.ref_context()?;
        let path = normalize(path);
        if !ENV_FILES.iter().any(|file| normalize(&cx.project.root.join(file)) == path) {
            return None;
        }
        let (key, range) = env_key_at(text, pos)?;
        Some((cx, key, range))
    }

    /// The usages of the key at `pos` of the environment file `path` (its
    /// text is `text`): `env('KEY')` and `Env::get('KEY')` calls, with its
    /// lines in both files when `include_declaration`. `None` when `path`
    /// isn't the project's `.env` or `.env.example` or the caret isn't on a
    /// key.
    pub fn laravel_env_references(
        &self,
        path: &Path,
        text: &str,
        pos: Pos,
        include_declaration: bool,
        cancel: &CancellationToken,
    ) -> Option<IdeResult<Vec<Usage>>> {
        let (cx, key, _) = self.env_subject(path, text, pos)?;
        Some(self.kind_usages(&cx, &EnvKey, &key, &key, include_declaration, cancel))
    }

    /// The range a rename at `pos` of the environment file `path` changes:
    /// the key. `None` where [`Self::laravel_env_references`] answers
    /// nothing.
    pub fn laravel_env_prepare_rename(&self, path: &Path, text: &str, pos: Pos) -> Option<Range> {
        self.env_subject(path, text, pos).map(|(_, _, range)| range)
    }

    /// Renames the key at `pos` of the environment file `path`: its lines
    /// in `.env` and `.env.example` (this one included, also when it isn't
    /// saved yet) and every usage.
    pub fn laravel_env_rename(
        &self,
        path: &Path,
        text: &str,
        pos: Pos,
        new_name: &str,
        cancel: &CancellationToken,
    ) -> Option<IdeResult<WorkspaceEdit>> {
        let (cx, key, range) = self.env_subject(path, text, pos)?;
        let mut target = EnvKey.rename_target(&cx, &key, 0).unwrap_or_else(|| RenameTarget {
            key: key.clone(),
            range: (0, key.len()),
            declarations: Vec::new(),
        });
        let here = (normalize(path), range);
        if !target.declarations.iter().any(|(path, range)| normalize(path) == here.0 && *range == here.1) {
            target.declarations.retain(|(path, _)| normalize(path) != here.0);
            target.declarations.push(here);
        }
        Some(self.kind_rename(&cx, &EnvKey, target, new_name, cancel))
    }

    /// The name of the Inertia page whose file is `path` (`Posts/Index`).
    pub fn laravel_inertia_page_name(&self, path: &Path) -> Option<String> {
        self.ref_context()?;
        let path = normalize(path);
        let pages = self.laravel_inertia()?;
        pages.pages.iter().find(|page| page.path == path).map(|page| page.name.clone())
    }

    /// The usages of the Inertia page whose file is `path`
    /// (`Inertia::render('Posts/Index')`, `inertia(…)`, `Route::inertia`,
    /// `->component(…)` in tests), with the file itself when
    /// `include_declaration`. `None` when `path` is no page.
    pub fn laravel_inertia_page_references(
        &self,
        path: &Path,
        include_declaration: bool,
        cancel: &CancellationToken,
    ) -> Option<IdeResult<Vec<Usage>>> {
        let name = self.laravel_inertia_page_name(path)?;
        let cx = self.ref_context()?;
        Some(self.kind_usages(&cx, &InertiaPageKind, &name, &name, include_declaration, cancel))
    }

    /// Renames the Inertia page whose file is `path` to `new_name` (the last
    /// segment of its name, `Index` of `Posts/Index`): the file and every
    /// usage. `None` when `path` is no page.
    pub fn laravel_inertia_page_rename(
        &self,
        path: &Path,
        new_name: &str,
        cancel: &CancellationToken,
    ) -> Option<IdeResult<WorkspaceEdit>> {
        let name = self.laravel_inertia_page_name(path)?;
        let cx = self.ref_context()?;
        let Some(target) = InertiaPageKind.rename_target(&cx, &name, name.len()) else {
            return Some(Err(IdeError::invalid("this page can't be renamed")));
        };
        Some(self.kind_rename(&cx, &InertiaPageKind, target, new_name, cancel))
    }
}
