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

pub fn display_name(tool: &str) -> &str {
    crate::registry::find(tool).map_or(tool, |t| t.display)
}

fn package_bin(package: &Path, tool: &str) -> IdeResult<PathBuf> {
    let name = display_name(tool);
    let json: serde_json::Value = serde_json::from_slice(&std::fs::read(package.join("package.json"))?)
        .map_err(|e| IdeError::invalid(format!("{name}: {e}")))?;
    let bin = json["bin"]
        .as_str()
        .or_else(|| json["bin"][tool].as_str())
        .ok_or_else(|| IdeError::invalid(format!("{name}: package has no CLI entry point")))?;
    let path = package.join(bin);
    if !path.is_file() {
        return Err(IdeError::unavailable(format!("{name}: CLI does not exist: {}", path.display())));
    }
    Ok(path)
}

/// Prettier formats a range for some languages (`config.range`); oxfmt formats whole files only.
pub fn supports_range(tool: &str, config: &FormatterConfig) -> bool {
    tool == "prettier" && config.range
}

impl Tools {
    /// Explicit executable/script, then the nearest project package, then managed tools and PATH.
    pub fn formatter_command(&self, tool: &str, file: &Path, custom: Option<&Path>) -> IdeResult<Command> {
        self.resolve_formatter_command(tool, file, custom).map_err(|e| e.with_tool(tool))
    }

    fn resolve_formatter_command(&self, tool: &str, file: &Path, custom: Option<&Path>) -> IdeResult<Command> {
        if crate::registry::find(tool).is_none_or(|t| t.kind != crate::ToolKind::Formatter) {
            return Err(IdeError::unavailable(format!("Unknown external formatter: {tool}")));
        }
        let package = Path::new("node_modules").join(tool);
        let manifest = package.join("package.json");
        let (path, node) = if let Some(custom) = custom.filter(|p| p.is_dir()) {
            (package_bin(custom, tool)?, true)
        } else if let Some(custom) = custom {
            (custom.to_path_buf(), matches!(custom.extension().and_then(|s| s.to_str()), Some("js" | "cjs" | "mjs")))
        } else if let Some(manifest) = find_up(file, &manifest) {
            (package_bin(manifest.parent().unwrap(), tool)?, true)
        } else if self.root.join(&manifest).is_file() {
            (package_bin(&self.root.join(&package), tool)?, true)
        } else {
            (self.which(tool).ok_or_else(|| IdeError::missing_tool(tool))?, false)
        };
        if node {
            let name = display_name(tool);
            let node =
                self.which("node").ok_or_else(|| IdeError::unavailable(format!("{name}: Node.js is required")))?;
            let mut cmd = self.command(node);
            cmd.arg(path);
            Ok(cmd)
        } else {
            Ok(self.command(path))
        }
    }
}

/// Both tools resolve their configuration and plugins themselves. Prettier's
/// project configuration overrides the editor indentation passed here; oxfmt has
/// no such flags and reads its configuration and `.editorconfig` only.
pub fn arguments(
    tool: &str,
    config: &FormatterConfig,
    file: &Path,
    tab_size: u32,
    insert_spaces: bool,
    range: Option<(u32, u32)>,
) -> Vec<OsString> {
    let mut args: Vec<OsString> = Vec::new();
    if tool == "prettier" {
        let parser = if config.parser == "markdown" && file.extension().is_some_and(|s| s == "mdx") {
            "mdx"
        } else {
            &config.parser
        };
        args.extend(
            [
                "--parser",
                parser,
                "--config-precedence",
                "file-override",
                "--tab-width",
                &tab_size.max(1).to_string(),
                "--use-tabs",
                if insert_spaces { "false" } else { "true" },
            ]
            .map(OsString::from),
        );
    }
    args.extend(["--stdin-filepath".into(), file.as_os_str().to_owned()]);
    if supports_range(tool, config)
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

pub fn run(tool: &str, mut command: Command, text: &str, cancel: &CancellationToken) -> IdeResult<String> {
    crate::process::run_input(&mut command, text, Duration::from_secs(15), cancel).map_err(|e| e.with_tool(tool))
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
        let failure = run("prettier", custom, "text", &Default::default()).unwrap_err();
        assert_eq!(failure.data, Some(ErrorData::Tool { tool: "prettier".into(), missing: false }));
    }

    #[cfg(unix)]
    #[test]
    fn stderr_is_preserved_verbatim_even_when_longer_than_four_thousand_characters() {
        let mut command = Command::new("sh");
        command.args(["-c", "i=0; while [ $i -lt 1000 ]; do printf 'error\\n' >&2; i=$((i+1)); done; exit 1"]);
        let failure = run("prettier", command, "", &Default::default()).unwrap_err();
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
            let args =
                arguments("prettier", &config, Path::new("/project with spaces/file.md"), 4, false, Some((3, 9)));
            let args: Vec<_> = args.iter().map(|a| a.to_string_lossy()).collect();
            assert!(args.windows(2).any(|a| a == ["--config-precedence", "file-override"]));
            assert!(args.windows(2).any(|a| a == ["--stdin-filepath", "/project with spaces/file.md"]));
            assert!(args.windows(2).any(|a| a == ["--tab-width", "4"]));
            assert!(args.windows(2).any(|a| a == ["--use-tabs", "true"]));
            assert_eq!(args.contains(&"--range-start".into()), supports_range);
            assert!(!args.contains(&"--write".into()));
        }
    }

    #[test]
    fn oxfmt_runs_the_nearest_package_without_prettier_flags() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("node_modules/oxfmt/bin")).unwrap();
        std::fs::write(root.join("node_modules/oxfmt/package.json"), r#"{"bin":{"oxfmt":"bin/oxfmt"}}"#).unwrap();
        std::fs::write(root.join("node_modules/oxfmt/bin/oxfmt"), "").unwrap();
        std::fs::write(root.join(".prettierignore"), "dist").unwrap();
        let file = root.join("packages/web/src/app.ts");
        let path = std::env::var_os("PATH").unwrap_or_default();
        let tools = Tools::with_paths(root.join("tools"), path, crate::platform::Platform::current());

        let command = tools.formatter_command("oxfmt", &file, None).unwrap();
        let program = Path::new(command.get_program()).file_stem().unwrap().to_string_lossy().into_owned();
        assert_eq!(program, "node");
        let script: Vec<_> = command.get_args().collect();
        assert_eq!(script, [root.join("node_modules/oxfmt/bin/oxfmt").as_os_str()]);

        let config = FormatterConfig { tool: "prettier".into(), parser: "typescript".into(), range: true };
        let args = arguments("oxfmt", &config, &file, 4, false, Some((3, 9)));
        let ignore = root.join(".prettierignore").into_os_string();
        assert_eq!(
            args[..4],
            ["--stdin-filepath".into(), file.clone().into_os_string(), "--ignore-path".into(), ignore]
        );
        assert!(args[4..].chunks(2).all(|pair| pair[0] == "--ignore-path"), "{args:?}");
        assert!(!supports_range("oxfmt", &config));

        let unknown = tools.formatter_command("rust-analyzer", &file, None).unwrap_err();
        assert!(unknown.message.contains("Unknown external formatter"), "{}", unknown.message);
    }
}
