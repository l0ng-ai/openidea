//! External formatting: resolve a tool, pass unsaved text on stdin, return text without writing files.

use crate::Tools;
use ide_core::{CancellationToken, IdeError, IdeResult};
use ide_language::FormatterConfig;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

/// Walk from the file's directory upward, including workspace parents (monorepos).
pub fn find_up(file: &Path, relative: &Path) -> Option<PathBuf> {
    file.parent()?.ancestors().map(|dir| dir.join(relative)).find(|p| p.is_file())
}

fn package_bin(package: &Path) -> IdeResult<PathBuf> {
    let json: serde_json::Value = serde_json::from_slice(&std::fs::read(package.join("package.json"))?)
        .map_err(|e| IdeError::invalid(format!("Prettier: {e}")))?;
    let bin = json["bin"]
        .as_str()
        .or_else(|| json["bin"]["prettier"].as_str())
        .ok_or_else(|| IdeError::invalid("Prettier: package has no CLI entry point"))?;
    let path = package.join(bin);
    if !path.is_file() {
        return Err(IdeError::unavailable(format!("Prettier: CLI does not exist: {}", path.display())));
    }
    Ok(path)
}

impl Tools {
    /// Explicit executable/script, then the nearest project package, then managed tools and PATH.
    pub fn formatter_command(&self, tool: &str, file: &Path, custom: Option<&Path>) -> IdeResult<Command> {
        self.resolve_formatter_command(tool, file, custom).map_err(|e| e.with_tool(tool))
    }

    fn resolve_formatter_command(&self, tool: &str, file: &Path, custom: Option<&Path>) -> IdeResult<Command> {
        if tool != "prettier" {
            return Err(IdeError::unavailable(format!("Unknown external formatter: {tool}")));
        }
        let (path, node) = if let Some(custom) = custom.filter(|p| p.is_dir()) {
            (package_bin(custom)?, true)
        } else if let Some(custom) = custom {
            (custom.to_path_buf(), matches!(custom.extension().and_then(|s| s.to_str()), Some("js" | "cjs" | "mjs")))
        } else if let Some(manifest) = find_up(file, Path::new("node_modules/prettier/package.json")) {
            (package_bin(manifest.parent().unwrap())?, true)
        } else if self.root.join("node_modules/prettier/package.json").is_file() {
            (package_bin(&self.root.join("node_modules/prettier"))?, true)
        } else {
            (self.which("prettier").ok_or_else(|| IdeError::missing_tool("prettier"))?, false)
        };
        if node {
            let node = self.which("node").ok_or_else(|| IdeError::unavailable("Prettier: Node.js is required"))?;
            let mut cmd = self.command(node);
            cmd.arg(path);
            Ok(cmd)
        } else {
            Ok(self.command(path))
        }
    }
}

/// Project configuration overrides these defaults; Prettier resolves config and plugins itself.
pub fn arguments(
    config: &FormatterConfig,
    file: &Path,
    tab_size: u32,
    insert_spaces: bool,
    range: Option<(u32, u32)>,
) -> Vec<OsString> {
    let parser = if config.parser == "markdown" && file.extension().is_some_and(|s| s == "mdx") {
        "mdx"
    } else {
        &config.parser
    };
    let mut args: Vec<OsString> = [
        "--parser",
        parser,
        "--config-precedence",
        "file-override",
        "--tab-width",
        &tab_size.max(1).to_string(),
        "--use-tabs",
        if insert_spaces { "false" } else { "true" },
    ]
    .into_iter()
    .map(Into::into)
    .collect();
    args.extend(["--stdin-filepath".into(), file.as_os_str().to_owned()]);
    if config.range
        && let Some((start, end)) = range
    {
        args.extend(["--range-start".into(), start.to_string().into(), "--range-end".into(), end.to_string().into()]);
    }
    // CLI defaults only find ignores in cwd; explicitly pass the nearest ancestor's files.
    for name in [".prettierignore", ".gitignore"] {
        if let Some(path) = find_up(file, Path::new(name)) {
            args.extend(["--ignore-path".into(), path.into_os_string()]);
        }
    }
    args
}

pub fn run(mut command: Command, text: &str, cancel: &CancellationToken) -> IdeResult<String> {
    crate::process::run_input(&mut command, text, Duration::from_secs(15), cancel).map_err(|e| e.with_tool("prettier"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_formatter_is_structured_but_invalid_custom_path_is_not_an_install_prompt() {
        use ide_core::error::{ErrorData, ErrorKind};
        let dir = tempfile::tempdir().unwrap();
        let tools = Tools::with_paths(dir.path().join("tools"), OsString::new(), crate::platform::Platform::current());
        let file = dir.path().join("file.md");
        let missing = tools.formatter_command("prettier", &file, None).unwrap_err();
        assert_eq!(missing.kind, ErrorKind::NotFound);
        assert_eq!(missing.data, Some(ErrorData::Tool { tool: "prettier".into(), missing: true }));
        let custom = tools.formatter_command("prettier", &file, Some(&dir.path().join("absent-prettier"))).unwrap();
        let failure = run(custom, "text", &Default::default()).unwrap_err();
        assert_eq!(failure.data, Some(ErrorData::Tool { tool: "prettier".into(), missing: false }));
    }

    #[cfg(unix)]
    #[test]
    fn stderr_is_preserved_verbatim_even_when_longer_than_four_thousand_characters() {
        let mut command = Command::new("sh");
        command.args(["-c", "i=0; while [ $i -lt 1000 ]; do printf 'error\\n' >&2; i=$((i+1)); done; exit 1"]);
        let failure = run(command, "", &Default::default()).unwrap_err();
        assert_eq!(failure.message, "error\n".repeat(1000));
        assert_eq!(failure.data, Some(ide_core::error::ErrorData::Tool { tool: "prettier".into(), missing: false }));
    }

    #[test]
    fn discovers_nearest_package_and_ignore_above_nested_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("packages/web/src")).unwrap();
        std::fs::write(root.join(".prettierignore"), "ignored.md").unwrap();
        std::fs::create_dir_all(root.join("node_modules/prettier")).unwrap();
        std::fs::write(root.join("node_modules/prettier/package.json"), "{}").unwrap();
        let file = root.join("packages/web/src/readme.md");
        assert_eq!(find_up(&file, Path::new(".prettierignore")), Some(root.join(".prettierignore")));
        std::fs::write(root.join("packages/web/.prettierignore"), "src/ignored.md").unwrap();
        assert_eq!(find_up(&file, Path::new(".prettierignore")), Some(root.join("packages/web/.prettierignore")));
        assert_eq!(
            find_up(&file, Path::new("node_modules/prettier/package.json")),
            Some(root.join("node_modules/prettier/package.json"))
        );
    }

    #[test]
    fn arguments_use_stdin_config_precedence_and_only_supported_ranges() {
        for (parser, supports_range) in [
            ("markdown", false),
            ("css", false),
            ("yaml", false),
            ("typescript", true),
            ("graphql", true),
            ("vue", true),
        ] {
            let config = FormatterConfig { tool: "prettier".into(), parser: parser.into(), range: supports_range };
            let args = arguments(&config, Path::new("/project with spaces/file.md"), 4, false, Some((3, 9)));
            let args: Vec<_> = args.iter().map(|a| a.to_string_lossy()).collect();
            assert!(args.windows(2).any(|a| a == ["--config-precedence", "file-override"]));
            assert!(args.windows(2).any(|a| a == ["--stdin-filepath", "/project with spaces/file.md"]));
            assert!(args.windows(2).any(|a| a == ["--tab-width", "4"]));
            assert!(args.windows(2).any(|a| a == ["--use-tabs", "true"]));
            assert_eq!(args.contains(&"--range-start".into()), supports_range);
            assert!(!args.contains(&"--write".into()));
        }
    }
}
