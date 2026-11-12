//! Files that mention an identifier: the candidates a reference search checks.

use crate::{Overlay, PathFilter, SearchContext, SearchQuery, SearchScope};
use ide_core::{CancellationToken, IdeResult};
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Clone, Debug)]
pub struct WordQuery {
    /// Matched as a whole word, case-sensitively.
    pub word: String,
    /// Directory searched (absolute, or relative to the search root).
    pub dir: PathBuf,
    /// File masks never searched (excluded roots, ignored names).
    pub exclude: Vec<String>,
    /// Files returned at most.
    pub limit: usize,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WordFiles {
    pub files: Vec<PathBuf>,
    /// More files matched than `limit`; the search stopped early.
    pub limit_hit: bool,
}

/// Files under `query.dir` containing `query.word` as a whole word, in walk
/// order (unsaved buffers through `overlay`; ignored folders skipped, ignored
/// and hidden files searched, like Find in Files). Stops at `query.limit` files or when cancelled.
pub fn files_with_word(
    root: &std::path::Path,
    query: &WordQuery,
    filter: Option<PathFilter<'_>>,
    overlay: Overlay<'_>,
    cancel: &CancellationToken,
) -> IdeResult<WordFiles> {
    let search = SearchQuery {
        pattern: query.word.clone(),
        is_regex: false,
        case_sensitive: true,
        whole_word: true,
        include: Vec::new(),
        exclude: query.exclude.clone(),
        scope: SearchScope::Directory { path: query.dir.clone().into() },
        max_matches: u32::MAX,
        context: SearchContext::Any,
    };
    let stop = cancel.child_token();
    let found = Mutex::new(WordFiles::default());
    crate::search_filtered(root, &search, filter, overlay, &stop, &|file| {
        let mut found = found.lock().unwrap_or_else(|e| e.into_inner());
        if found.files.len() < query.limit {
            found.files.push(file.path.into_path_buf());
        } else {
            found.limit_hit = true;
            stop.cancel();
        }
    })?;
    Ok(found.into_inner().unwrap_or_else(|e| e.into_inner()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn query(word: &str, limit: usize) -> WordQuery {
        WordQuery { word: word.into(), dir: PathBuf::from("."), exclude: vec!["build/**".into()], limit }
    }

    #[test]
    fn whole_word_matches_in_kept_files_only() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("pkg/ignored")).unwrap();
        fs::create_dir_all(root.join("build")).unwrap();
        fs::write(root.join(".gitignore"), "ignored/\nlocal.py\n").unwrap();
        // An ignored file outside ignored folders is still a candidate, as in IDEA.
        fs::write(root.join("pkg/local.py"), "get_value\n").unwrap();
        fs::write(root.join("pkg/use.py"), "x.get_value(1)\n").unwrap();
        fs::write(root.join("pkg/longer.py"), "get_values()\n").unwrap();
        fs::write(root.join("pkg/case.py"), "Get_Value()\n").unwrap();
        fs::write(root.join("pkg/notes.txt"), "get_value\n").unwrap();
        fs::write(root.join("pkg/ignored/gen.py"), "get_value\n").unwrap();
        fs::write(root.join("build/out.py"), "get_value\n").unwrap();
        fs::write(root.join("pkg/open.py"), "nothing on disk\n").unwrap();
        let unsaved = root.join("pkg/open.py");
        let overlay = |p: &std::path::Path| (p == unsaved).then(|| "get_value()".to_owned());
        let py = |rel: &str| rel.ends_with(".py");
        let mut found =
            files_with_word(root, &query("get_value", 10), Some(&py), &overlay, &CancellationToken::new()).unwrap();
        found.files.sort();
        assert_eq!(
            found,
            WordFiles {
                files: vec![root.join("pkg/local.py"), root.join("pkg/open.py"), root.join("pkg/use.py")],
                limit_hit: false
            }
        );
    }

    #[test]
    fn stops_at_the_limit() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..5 {
            fs::write(dir.path().join(format!("f{i}.py")), "name\n").unwrap();
        }
        let found = files_with_word(dir.path(), &query("name", 2), None, &|_| None, &CancellationToken::new()).unwrap();
        assert_eq!((found.files.len(), found.limit_hit), (2, true));
        let all = files_with_word(dir.path(), &query("name", 5), None, &|_| None, &CancellationToken::new()).unwrap();
        assert_eq!((all.files.len(), all.limit_hit), (5, false));
    }

    #[test]
    fn a_cancelled_search_finds_nothing() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.py"), "name\n").unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();
        let found = files_with_word(dir.path(), &query("name", 5), None, &|_| None, &cancel).unwrap();
        assert!(found.files.is_empty());
    }
}
