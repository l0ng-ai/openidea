//! The `scope` argument of the query tools: the directory their results are limited to, a
//! folder of the project or a project attached to it.

use crate::mcp::tool::{Call, Param, ParamType};
use ide_core::{IdeError, IdeResult};
use std::path::{Path, PathBuf};

pub fn param() -> Param {
    Param::optional(
        "scope",
        ParamType::String,
        "Directory to limit results to: relative to the project root, or absolute",
    )
}

/// No `scope`: everything.
pub struct Scope(Option<PathBuf>);

impl Scope {
    pub fn of(call: &Call) -> IdeResult<Self> {
        let Some(raw) = call.opt_str("scope")?.filter(|s| !s.trim().is_empty()) else { return Ok(Self(None)) };
        let given = Path::new(raw.trim());
        let path = crate::mcp::tool::normalize(&if given.is_absolute() {
            given.to_path_buf()
        } else {
            call.root().join(given)
        });
        let path = dunce::canonicalize(&path).unwrap_or(path);
        if !path.is_dir() {
            return Err(IdeError::not_found(format!("scope {raw} is not a directory")));
        }
        let roots = std::iter::once(call.root().to_path_buf()).chain(call.project().content_roots());
        if !roots.into_iter().any(|root| path.starts_with(root)) {
            return Err(IdeError::invalid(format!("scope {raw} is outside the project")));
        }
        Ok(Self(Some(path)))
    }

    pub fn dir(&self) -> Option<&Path> {
        self.0.as_deref()
    }

    pub fn contains(&self, path: &Path) -> bool {
        self.0.as_ref().is_none_or(|dir| path.starts_with(dir))
    }

    /// For a path the tools return: project-relative with `/`, or absolute.
    pub fn contains_shown(&self, root: &Path, path: &str) -> bool {
        self.0.is_none() || self.contains(&root.join(path))
    }
}
