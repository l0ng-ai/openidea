//! SimpleCov's `coverage/.resultset.json`:
//!
//! ```json
//! { "RSpec": { "timestamp": 1, "coverage": {
//!     "/abs/lib/a.rb": { "lines": [null, 1, 0],
//!                        "branches": { "[:if, 0, 3, 4, 3, 20]": { "[:then, 1, 4, 6, 4, 9]": 1, "[:else, 2, 6, 6, 6, 9]": 0 } } },
//!     "/abs/lib/legacy.rb": [null, 1] } } }
//! ```
//!
//! `lines[i]` is line `i + 1` (`null` = not relevant), so the index is already 0-based.
//! A branch belongs to the line its condition starts on (third number of its key).

use crate::Accumulator;
use ide_core::{IdeError, IdeResult};
use serde_json::Value;
use std::path::Path;

/// Start line (1-based) of a `"[:if, 0, 3, 4, 3, 20]"` branch key.
fn start_line(key: &str) -> Option<u32> {
    key.trim_matches(['[', ']']).split(',').nth(2)?.trim().parse().ok()
}

pub(crate) fn parse(text: &str, base: &Path) -> IdeResult<Accumulator> {
    let json: Value = serde_json::from_str(text).map_err(|e| IdeError::invalid(format!("SimpleCov resultset: {e}")))?;
    let mut acc = Accumulator::default();
    // One entry per test command ("RSpec", "Minitest", …); their coverage is merged.
    for suite in json.as_object().into_iter().flat_map(|o| o.values()) {
        let Some(files) = suite.get("coverage").and_then(Value::as_object) else { continue };
        for (name, data) in files {
            let p = Path::new(name);
            let path = if p.is_absolute() { p.to_path_buf() } else { base.join(p) };
            acc.file(&path);
            let lines = data.get("lines").or(Some(data)).and_then(Value::as_array);
            for (i, hits) in lines.into_iter().flatten().enumerate() {
                if let Some(hits) = hits.as_u64() {
                    acc.line(&path, i as u32, hits);
                }
            }
            for (cond, branches) in data.get("branches").and_then(Value::as_object).into_iter().flatten() {
                let Some(line) = start_line(cond) else { continue };
                for (branch, hits) in branches.as_object().into_iter().flatten() {
                    acc.has_branches = true;
                    acc.branch(&path, line.saturating_sub(1), format!("{cond}/{branch}"), hits.as_u64() > Some(0));
                }
            }
        }
    }
    Ok(acc)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_lines_branches_and_merges_suites() {
        let text = r#"{
          "RSpec": {"coverage": {"/p/lib/a.rb": {"lines": [null, 1, 0],
            "branches": {"[:if, 0, 2, 4, 2, 20]": {"[:then, 1, 2, 6, 2, 9]": 1, "[:else, 2, 2, 6, 2, 9]": 0}}}}},
          "Minitest": {"coverage": {"/p/lib/a.rb": {"lines": [null, 2, 3]}, "lib/old.rb": [1, null]}}
        }"#;
        let suite = parse(text, Path::new("/p")).unwrap().finish("SimpleCov");
        assert_eq!(suite.files.len(), 2);
        let a = suite.files.iter().find(|f| (f.path.as_ref() as &Path).ends_with("a.rb")).unwrap();
        assert_eq!(a.lines.iter().map(|l| (l.line, l.hits)).collect::<Vec<_>>(), [(1, 3), (2, 3)]);
        assert_eq!((a.branches_total, a.branches_covered), (2, 1));
        assert_eq!(a.lines[0].branches_total, 2);
        let old = suite.files.iter().find(|f| (f.path.as_ref() as &Path).ends_with("lib/old.rb")).unwrap();
        assert_eq!(old.path.as_ref() as &Path, Path::new("/p/lib/old.rb"));
        assert_eq!(old.lines[0].hits, 1);
        assert!(suite.has_branches);
        assert!(parse("nope", Path::new("/p")).is_err());
    }
}
