//! Managed virtual environments only work where they were created: their launchers
//! (uv's `.exe` trampolines, script shebangs) name the interpreter by absolute path.
//! One moved from outside the IDE (a copied data directory, a relocated AppData) fails
//! to start, so it is removed and installed afresh when next needed.

use crate::registry::{Method, TOOLS};
use std::path::{Path, PathBuf};

/// Removes the managed virtual-environment tools under `tools_root` that no longer sit
/// where they were created. Call at start-up, before language servers start.
pub fn drop_moved_venvs(tools_root: &Path) {
    for spec in TOOLS.iter().filter(|spec| matches!(spec.method, Method::PipVenv { .. })) {
        let dir = tools_root.join(spec.name);
        if !venv_moved(&dir.join("venv")) {
            continue;
        }
        tracing::info!(?dir, "virtual environment was moved from where it was created; removing it to reinstall");
        if let Err(error) = std::fs::remove_dir_all(&dir) {
            tracing::warn!(?dir, %error, "cannot remove the moved virtual environment");
        }
    }
}

fn venv_moved(venv: &Path) -> bool {
    let Some(created) = venv_origin(venv) else { return false };
    match (std::fs::canonicalize(&created), std::fs::canonicalize(venv)) {
        (Ok(created), Ok(venv)) => created != venv,
        // The interpreter path its launchers hold is gone.
        (Err(_), Ok(_)) => true,
        _ => false,
    }
}

/// Where a virtual environment was created: the `VIRTUAL_ENV` its activation script sets.
fn venv_origin(venv: &Path) -> Option<PathBuf> {
    let script =
        if cfg!(windows) { venv.join("Scripts").join("activate.bat") } else { venv.join("bin").join("activate") };
    let text = std::fs::read_to_string(script).ok()?;
    text.lines().find_map(virtual_env).map(PathBuf::from)
}

/// The path a line of an activation script assigns to `VIRTUAL_ENV`, as uv and CPython write them:
/// `VIRTUAL_ENV='/v'`, `VIRTUAL_ENV="/v"`, `export VIRTUAL_ENV=$(cygpath "/v")`,
/// `set "VIRTUAL_ENV=C:\v"`, and uv's `@for %%i in ("C:\v") do @set "VIRTUAL_ENV=%%~fi"`.
fn virtual_env(line: &str) -> Option<&str> {
    let at = line.find("VIRTUAL_ENV=")?;
    if let Some(start) = line[..at].find("in (\"") {
        let rest = &line[start + 5..];
        return rest.find('"').map(|end| &rest[..end]).filter(|value| !value.is_empty());
    }
    let rest = line[at + "VIRTUAL_ENV=".len()..].trim_start_matches("$(cygpath ");
    let value = match rest.chars().next()? {
        quote @ ('"' | '\'') => rest[1..].split(quote).next()?,
        _ if line[..at].ends_with('"') => rest.split('"').next()?,
        _ => rest.split_whitespace().next()?.trim_end_matches(')'),
    };
    (!value.is_empty() && !value.starts_with(['$', '%'])).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_virtual_env_as_uv_and_cpython_write_it() {
        assert_eq!(virtual_env("VIRTUAL_ENV='/data/tools/ty/venv'"), Some("/data/tools/ty/venv"));
        assert_eq!(virtual_env("VIRTUAL_ENV=\"/a b/venv\""), Some("/a b/venv"));
        assert_eq!(virtual_env("    export VIRTUAL_ENV=$(cygpath \"/a/venv\")"), Some("/a/venv"));
        assert_eq!(virtual_env("    export VIRTUAL_ENV=$(cygpath /a/venv)"), Some("/a/venv"));
        assert_eq!(virtual_env(r#"set "VIRTUAL_ENV=E:\App Data\tools\ty\venv""#), Some(r"E:\App Data\tools\ty\venv"));
        assert_eq!(
            virtual_env(r#"@for %%i in ("E:\data\tools\ty\venv") do @set "VIRTUAL_ENV=%%~fi""#),
            Some(r"E:\data\tools\ty\venv")
        );
        assert_eq!(virtual_env("    export VIRTUAL_ENV"), None);
        assert_eq!(virtual_env("unset VIRTUAL_ENV_PROMPT"), None);
        assert_eq!(virtual_env("set VIRTUAL_ENV=%~dp0.."), None);
    }

    fn venv_created_at(tools: &Path, name: &str, origin: &Path) {
        let venv = tools.join(name).join("venv");
        let script =
            if cfg!(windows) { venv.join("Scripts").join("activate.bat") } else { venv.join("bin").join("activate") };
        std::fs::create_dir_all(script.parent().unwrap()).unwrap();
        let line = if cfg!(windows) {
            format!("@for %%i in (\"{}\") do @set \"VIRTUAL_ENV=%%~fi\"\r\n", origin.display())
        } else {
            format!("VIRTUAL_ENV='{}'\nexport VIRTUAL_ENV\n", origin.display())
        };
        std::fs::write(script, line).unwrap();
    }

    #[test]
    fn removes_only_virtual_environments_moved_from_where_they_were_created() {
        let tmp = tempfile::tempdir().unwrap();
        let tools = tmp.path().join("tools");
        // Created here.
        venv_created_at(&tools, "ty", &tools.join("ty").join("venv"));
        // Copied from another data directory that is gone.
        venv_created_at(&tools, "basedpyright", &tmp.path().join("old/tools/basedpyright/venv"));
        // Copied, the original still in place.
        let old_ruff = tmp.path().join("old-kept/tools/ruff/venv");
        std::fs::create_dir_all(&old_ruff).unwrap();
        venv_created_at(&tools, "ruff", &old_ruff);
        // No activation script to tell.
        std::fs::create_dir_all(tools.join("pyrefly").join("venv")).unwrap();
        // Not a virtual-environment tool.
        std::fs::create_dir_all(tools.join("gopls").join("bin")).unwrap();

        drop_moved_venvs(&tools);

        assert!(tools.join("ty").exists());
        assert!(!tools.join("basedpyright").exists());
        assert!(!tools.join("ruff").exists());
        assert!(tools.join("pyrefly").exists());
        assert!(tools.join("gopls").exists());
    }

    #[test]
    fn a_missing_tools_directory_is_left_alone() {
        let tmp = tempfile::tempdir().unwrap();
        drop_moved_venvs(&tmp.path().join("missing"));
    }
}
