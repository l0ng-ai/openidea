//! Select the document's formatting provider before executing it on this host.

use crate::Host;
use ide_core::event::NotifyLevel;
use ide_core::settings::{BIOME_LANGUAGES, ExternalFormatter, LanguagesSettings, Settings};
use ide_core::{ChangeSet, DocId, IdeError, IdeEvent, IdeResult, IpcPath, LanguageId, Pos, Range, TextEdit};
use ide_language::{LanguageConfig, PhpAlignment, Syntax};
use ide_lsp::types::FormatOptions;
use ide_tools::{Tools, formatter};
use std::path::{Path, PathBuf};

const OXFMT_CONFIGS: [&str; 4] = [".oxfmtrc.json", ".oxfmtrc.jsonc", "oxfmt.config.ts", "oxfmt.config.mts"];
/// A Biome configuration, or Biome installed as a project dependency (it then uses its defaults).
const BIOME_MARKERS: [&str; 3] = ["biome.json", "biome.jsonc", "node_modules/@biomejs/biome/package.json"];

/// Reformat Code uses Biome below a Biome configuration or installation, unless the nearest
/// configuration turns its formatter off (Biome lints, another tool formats).
fn biome_formats(file: &Path) -> bool {
    let config = ["biome.json", "biome.jsonc"]
        .iter()
        .filter_map(|name| formatter::find_up(file, Path::new(name)))
        .max_by_key(|path| path.components().count());
    match config {
        Some(config) => !std::fs::read_to_string(&config)
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&ide_core::jsonc::strip(&text)).ok())
            .is_some_and(|v| v.pointer("/formatter/enabled") == Some(&serde_json::Value::Bool(false))),
        None => BIOME_MARKERS.iter().any(|name| formatter::find_up(file, Path::new(name)).is_some()),
    }
}

fn supports_external_format(language: &LanguageConfig, tool: ExternalFormatter) -> bool {
    match language.formatter.as_ref().map(|f| f.tool.as_str()) {
        Some("prettier") if tool == ExternalFormatter::Biome => BIOME_LANGUAGES.contains(&language.id.as_str()),
        Some("prettier") => matches!(tool, ExternalFormatter::Prettier | ExternalFormatter::Oxfmt),
        Some("ruff") => tool == ExternalFormatter::Ruff,
        _ => false,
    }
}

/// The external formatter of a file, for a language with an external formatter.
/// `forced` names the tool (Reformat with Prettier, oxfmt, Biome, or Ruff). Ruff is
/// the base formatter for Python; Biome, then oxfmt, can replace Prettier for their
/// languages when configured or selected. A tool that cannot format the language is
/// rejected even when explicitly requested.
fn external_tool(
    forced: Option<ExternalFormatter>,
    language: Option<&LanguageConfig>,
    file: &Path,
    settings: &LanguagesSettings,
) -> IdeResult<Option<ExternalFormatter>> {
    use ExternalFormatter::{Biome, Oxfmt, Prettier, Ruff};
    let Some(language) = language.filter(|l| l.formatter.is_some()) else {
        return match forced {
            Some(tool) => Err(IdeError::invalid(format!(
                "{} cannot format {} files",
                formatter::display_name(tool.name()),
                language.map_or("these", |l| l.name.as_str())
            ))),
            None => Ok(None),
        };
    };
    if let Some(tool) = forced {
        return if supports_external_format(language, tool) {
            Ok(Some(tool))
        } else {
            Err(IdeError::invalid(format!(
                "{} cannot format {} files",
                formatter::display_name(tool.name()),
                language.name
            )))
        };
    }
    let enabled = |tool| settings.formatter(tool).languages.iter().any(|l| l == language.id.as_str());
    if language.formatter.as_ref().is_some_and(|f| f.tool == "ruff") {
        return Ok(enabled(Ruff).then_some(Ruff));
    }
    let found = |names: &[&str]| names.iter().any(|name| formatter::find_up(file, Path::new(name)).is_some());
    let biome = enabled(Biome) && supports_external_format(language, Biome);
    Ok(if biome && (settings.biome.prefer || biome_formats(file)) {
        Some(Biome)
    } else if enabled(Oxfmt) && (settings.oxfmt.prefer || found(&OXFMT_CONFIGS)) {
        Some(Oxfmt)
    } else {
        enabled(Prettier).then_some(Prettier)
    })
}

fn codepoint_col(line: &str, utf16_col: u32) -> u32 {
    let mut units = 0;
    for (index, ch) in line.chars().enumerate() {
        if units >= utf16_col {
            return index as u32;
        }
        units += ch.len_utf16() as u32;
    }
    line.chars().count() as u32
}

fn format_range(text: &ide_text::Document, range: Range) -> formatter::FormatRange {
    let position = |pos: Pos| {
        let line = text.line(pos.line).unwrap_or_default();
        (pos.line + 1, codepoint_col(&line, pos.col) + 1)
    };
    let (start_line, start_col) = position(range.start);
    let (end_line, end_col) = position(range.end);
    formatter::FormatRange {
        start_offset: text.pos_to_offset(range.start),
        end_offset: text.pos_to_offset(range.end),
        start_line,
        start_col,
        end_line,
        end_col,
    }
}

/// The edits PHP-CS-Fixer makes to the unsaved text: it fixes a temporary copy with the file's
/// name (from stdin it doesn't fix anything), so the file on disk stays as it is.
fn php_cs_fixer_edits(
    tools: &Tools,
    php: Option<&Path>,
    fixer: &formatter::PhpCsFixer,
    path: &Path,
    unsaved: &str,
) -> IdeResult<Vec<TextEdit>> {
    let name = path.file_name().ok_or_else(|| IdeError::invalid("PHP-CS-Fixer: file has no name"))?;
    let dir = tempfile::tempdir()?;
    let copy = dir.path().join(name);
    std::fs::write(&copy, unsaved)?;
    formatter::run_php_cs_fixer(tools.php_cs_fixer_command(php, fixer, &copy)?, &Default::default())?;
    let formatted = std::fs::read_to_string(&copy)?;
    let text = ide_text::Document::new(unsaved);
    Ok(text
        .diff(&formatted)
        .changes
        .into_iter()
        .map(|c| TextEdit {
            range: Range::new(text.offset_to_pos(c.from), text.offset_to_pos(c.to)),
            new_text: c.insert,
        })
        .collect())
}

/// Some language servers (Vue's, for one) answer Reformat Code with one edit replacing the
/// whole file; applied as is, it moves the caret and the view to the top of the file. The same
/// result as one edit per changed region keeps them where they were.
fn minimal_edits(text: &str, edits: Vec<TextEdit>) -> Vec<TextEdit> {
    if !edits.iter().any(|e| e.range.end.line > e.range.start.line) {
        return edits;
    }
    let original = ide_text::Document::new(text);
    let mut formatted = original.clone();
    if formatted.apply_edits(&edits).is_err() {
        return edits;
    }
    original
        .diff(&formatted.text())
        .changes
        .into_iter()
        .map(|c| TextEdit {
            range: Range::new(original.offset_to_pos(c.from), original.offset_to_pos(c.to)),
            new_text: c.insert,
        })
        .collect()
}

pub async fn format(
    host: &Host,
    window: &str,
    doc: DocId,
    range: Option<Range>,
    options: FormatOptions,
) -> IdeResult<Vec<TextEdit>> {
    let project = host.project(window)?;
    let snap = project.documents.snapshot(doc)?;
    let source = FormatSource {
        path: snap.path,
        language: snap.language,
        text: snap.text,
        doc: Some(doc),
        version: snap.version,
        read_only: snap.read_only,
    };
    format_source(host, window, &project, source, range, options).await
}

/// Format a separate snapshot using the file's language, settings and formatter.
pub async fn format_text(
    host: &Host,
    window: &str,
    path: PathBuf,
    text: String,
    options: FormatOptions,
) -> IdeResult<Vec<TextEdit>> {
    let project = host.project(window)?;
    if !path.is_absolute() || path.file_name().is_none() {
        return Err(IdeError::invalid("formatting requires a file path"));
    }
    if text.len() as u64 > ide_vfs::LARGE_FILE_THRESHOLD {
        return Ok(Vec::new());
    }
    let language = project.documents.language_of(&path, text.lines().next()).language;
    let source = FormatSource { path: path.into(), language, text, doc: None, version: 0, read_only: false };
    format_source(host, window, &project, source, None, options).await
}

struct FormatSource {
    path: IpcPath,
    language: LanguageId,
    text: String,
    doc: Option<DocId>,
    version: u32,
    read_only: bool,
}

async fn format_source(
    host: &Host,
    window: &str,
    project: &crate::Project,
    snap: FormatSource,
    range: Option<Range>,
    options: FormatOptions,
) -> IdeResult<Vec<TextEdit>> {
    let settings = project.settings.effective();
    let alignment = php_alignment(&settings, &snap.language);
    let original = alignment.any().then(|| (snap.language.clone(), snap.text.clone()));
    let Some(edits) = provider_edits(host, window, project, snap, settings, range, options).await? else {
        return Ok(Vec::new());
    };
    let Some((language, text)) = original else {
        return Ok(edits);
    };
    let syntax = host.syntax();
    tokio::task::spawn_blocking(move || align_formatted(&syntax, &language, &text, edits, range, alignment))
        .await
        .map_err(|e| IdeError::internal(e.to_string()))?
}

/// PHP Code Style › Align key-value pairs / Align consecutive assignments (off by default, as in PhpStorm).
fn php_alignment(settings: &Settings, language: &LanguageId) -> PhpAlignment {
    let style = settings.editor.code_style.languages.get(language.as_str());
    PhpAlignment {
        key_value_pairs: style.and_then(|s| s.align_key_value_pairs).unwrap_or(false),
        assignments: style.and_then(|s| s.align_consecutive_assignments).unwrap_or(false),
    }
}

/// The formatter's `edits` to `text` followed by the alignment, as one set of edits to `text`.
/// With a `range`, only its lines (where the formatter left them) are aligned.
fn align_formatted(
    syntax: &Syntax,
    language: &LanguageId,
    text: &str,
    edits: Vec<TextEdit>,
    range: Option<Range>,
    alignment: PhpAlignment,
) -> IdeResult<Vec<TextEdit>> {
    let mut formatted = ide_text::Document::new(text);
    // Edits the editor has to sort out itself (overlapping ones) are passed on unaligned.
    let Ok((changes, _)) = formatted.apply_edits(&edits) else {
        return Ok(edits);
    };
    let lines = range.map(|range| {
        let original = ide_text::Document::new(text);
        let start = formatted.offset_to_pos(map_offset(&changes, original.pos_to_offset(range.start), false));
        let end = formatted.offset_to_pos(map_offset(&changes, original.pos_to_offset(range.end), true));
        let last = if end.col == 0 && end.line > start.line { end.line - 1 } else { end.line };
        (start.line as usize, last as usize)
    });
    let Some(aligned) = syntax.align_php(language, &formatted.text(), lines, alignment) else {
        return Ok(edits);
    };
    let original = ide_text::Document::new(text);
    Ok(original
        .diff(&aligned)
        .changes
        .into_iter()
        .map(|c| TextEdit {
            range: Range::new(original.offset_to_pos(c.from), original.offset_to_pos(c.to)),
            new_text: c.insert,
        })
        .collect())
}

/// Where UTF-16 `offset` of the text before `changes` ends up after them; inside a replaced
/// part, at its start or (`end`) its end.
fn map_offset(changes: &ChangeSet, offset: u32, end: bool) -> u32 {
    let mut shift: i64 = 0;
    for c in &changes.changes {
        let inserted = c.insert.encode_utf16().count() as i64;
        if c.to < offset || (c.to == offset && (c.from < c.to || end)) {
            shift += inserted - i64::from(c.to - c.from);
        } else if c.from < offset {
            return (i64::from(c.from) + shift + if end { inserted } else { 0 }) as u32;
        } else {
            break;
        }
    }
    (i64::from(offset) + shift) as u32
}

/// The edits of the formatter that handles the document; `None` when it doesn't run
/// (formatting on save is off for it).
async fn provider_edits(
    host: &Host,
    window: &str,
    project: &crate::Project,
    snap: FormatSource,
    settings: Settings,
    range: Option<Range>,
    options: FormatOptions,
) -> IdeResult<Option<Vec<TextEdit>>> {
    let doc = snap.doc;
    let language = project.languages.get(&snap.language);
    if options.tool.is_none()
        && let Some(id) = settings.languages.plugin_formatters.get(snap.language.as_str()).filter(|s| !s.is_empty())
    {
        if options.on_save && !settings.editor.format_on_save {
            return Ok(None);
        }
        if snap.read_only {
            return Err(IdeError::invalid("The file is read-only"));
        }
        let plugins = crate::plugins::editor_plugin_host()
            .ok_or_else(|| IdeError::not_found("The selected plugin formatter is unavailable"))?;
        let d = ide_plugin::ProviderDocument {
            path: snap.path.0,
            language: snap.language.0,
            version: u64::from(snap.version),
            text: snap.text,
        };
        let id = id.clone();
        return tokio::task::spawn_blocking(move || {
            plugins.language_format(
                &id,
                &d,
                range,
                ide_plugin::language_features::FormatOptions {
                    tab_size: options.tab_size,
                    insert_spaces: options.insert_spaces,
                },
            )
        })
        .await
        .map_err(|e| IdeError::internal(e.to_string()))?
        .map(Some);
    }
    // A committed PHP-CS-Fixer configuration takes over Reformat Code for `.php` files.
    if options.tool.is_none()
        && snap.path.extension().is_some_and(|e| e == "php")
        && let Some(fixer) = formatter::php_cs_fixer(&snap.path)
    {
        if options.on_save && !settings.editor.format_on_save {
            return Ok(None);
        }
        host.require_trust(window)?;
        if snap.read_only {
            return Err(IdeError::invalid("The file is read-only"));
        }
        let php = ide_sdk::apply::setting_path(&project.root, &settings.languages.php.interpreter);
        let tools = Tools::new(&host.local_data_dir);
        let edits = tokio::task::spawn_blocking(move || {
            php_cs_fixer_edits(&tools, php.as_deref(), &fixer, &snap.path, &snap.text)
        })
        .await
        .map_err(|e| IdeError::internal(e.to_string()))??;
        if range.is_some() {
            project.sink.emit(IdeEvent::Notify {
                level: NotifyLevel::Info,
                title: "PHP-CS-Fixer".into(),
                body: Some("PHP-CS-Fixer does not support selection formatting; formatted the whole file".into()),
            });
        }
        return Ok(Some(edits));
    }
    let mut selected = external_tool(options.tool, language.as_ref(), &snap.path, &settings.languages)?;
    if let Some(tool) = selected
        && options.tool.is_none()
        && !settings.languages.formatter(tool).prefer
        && match doc {
            Some(doc) => project.lsp.can_format(doc).await?,
            None => project.lsp.can_format_text(&snap.path, &snap.language).await,
        }
    {
        selected = None;
    }
    let Some(selected) = selected else {
        if options.on_save && !settings.editor.format_on_save {
            return Ok(None);
        }
        let edits = match doc {
            Some(doc) => project.lsp.format(doc, range, options).await?,
            None => project.lsp.format_text(&snap.path, &snap.language, &snap.text, options).await?,
        };
        let text = snap.text;
        return tokio::task::spawn_blocking(move || Some(minimal_edits(&text, edits)))
            .await
            .map_err(|e| IdeError::internal(e.to_string()));
    };
    let tool_settings = settings.languages.formatter(selected);
    if options.on_save && !tool_settings.run_on_save {
        return Ok(None);
    }
    host.require_trust(window)?;
    if snap.read_only {
        return Err(IdeError::invalid("The file is read-only"));
    }
    let config = language.and_then(|l| l.formatter).expect("external_tool selects languages with a formatter");
    let tool = selected.name();
    let name = formatter::display_name(tool);
    let custom = ide_sdk::apply::setting_path(&project.root, &tool_settings.path);
    let tools = Tools::new(&host.local_data_dir);
    let whole_selection = range.is_some() && !formatter::supports_range(tool, &config);
    let project_root = project.root.clone();
    let configuration_directory = settings.languages.ruff.configuration_directory.clone();
    let edits: IdeResult<Vec<TextEdit>> = tokio::task::spawn_blocking(move || {
        let text = ide_text::Document::new(&snap.text);
        let range = range.map(|range| format_range(&text, range));
        let config_file = if tool == "ruff" {
            ide_sdk::apply::ruff_configuration(&project_root, &configuration_directory)?
        } else {
            None
        };
        let mut command = tools.formatter_command(tool, &snap.path, custom.as_deref())?;
        let dir = snap.path.parent().ok_or_else(|| IdeError::invalid(format!("{name}: file has no directory")))?;
        command.current_dir(dir);
        command.args(formatter::arguments(
            tool,
            &config,
            &snap.path,
            options.tab_size,
            options.insert_spaces,
            range,
            config_file.as_deref(),
        ));
        let formatted = formatter::run(tool, command, &snap.text, &Default::default())?;
        Ok(text
            .diff(&formatted)
            .changes
            .into_iter()
            .map(|c| TextEdit {
                range: Range::new(text.offset_to_pos(c.from), text.offset_to_pos(c.to)),
                new_text: c.insert,
            })
            .collect())
    })
    .await
    .map_err(|e| IdeError::internal(e.to_string()))?;
    if edits.is_ok() && whole_selection {
        project.sink.emit(IdeEvent::Notify {
            level: NotifyLevel::Info,
            title: name.into(),
            body: Some(format!(
                "{name} does not support selection formatting for this language; formatted the whole file"
            )),
        });
    }
    edits.map(Some).map_err(|e| e.with_tool(tool))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ExternalFormatter::{Biome, Oxfmt, Prettier, Ruff};
    use ide_core::LanguageId;
    use ide_language::LanguageRegistry;

    fn tool(
        forced: Option<ExternalFormatter>,
        language: &str,
        file: &Path,
        settings: &LanguagesSettings,
    ) -> IdeResult<Option<ExternalFormatter>> {
        let language = LanguageRegistry::load(None).unwrap().get(&LanguageId::new(language));
        external_tool(forced, language.as_ref(), file, settings)
    }

    #[test]
    fn default_settings_use_ruff_for_python_and_prettier_for_the_web() {
        let settings = LanguagesSettings::default();
        let file = Path::new("/project/file");
        for lang in LanguageRegistry::load(None).unwrap().all() {
            let configured = match lang.formatter.as_ref().map(|f| f.tool.as_str()) {
                Some("prettier") => Some(Prettier),
                Some("ruff") => Some(Ruff),
                _ => None,
            };
            let selected = external_tool(None, Some(&lang), file, &settings).unwrap();
            assert_eq!(selected, configured, "{}", lang.id);
        }
        assert_eq!(external_tool(None, None, file, &settings).unwrap(), None);
    }

    #[test]
    fn ruff_is_the_python_external_formatter_and_is_opt_out() {
        let file = Path::new("/project/src/example.py");
        let mut settings = LanguagesSettings::default();
        assert_eq!(tool(None, "python", file, &settings).unwrap(), Some(Ruff));
        assert_eq!(tool(Some(Ruff), "python", file, &settings).unwrap(), Some(Ruff));
        settings.ruff.languages.clear();
        assert_eq!(tool(None, "python", file, &settings).unwrap(), None);
        assert_eq!(tool(Some(Ruff), "python", file, &settings).unwrap(), Some(Ruff));
        let prettier = tool(Some(Prettier), "python", file, &settings).unwrap_err();
        assert_eq!(prettier.message, "Prettier cannot format Python files");
        let oxfmt = tool(Some(Oxfmt), "python", file, &settings).unwrap_err();
        assert_eq!(oxfmt.message, "oxfmt cannot format Python files");
        let biome = tool(Some(Biome), "python", file, &settings).unwrap_err();
        assert_eq!(biome.message, "Biome cannot format Python files");
    }

    #[test]
    fn biome_config_or_dependency_selects_biome_for_its_languages() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("web/src")).unwrap();
        let (web, api, readme) = (root.join("web/src/app.ts"), root.join("api/main.ts"), root.join("web/README.md"));
        let mut settings = LanguagesSettings::default();
        for marker in BIOME_MARKERS {
            let path = root.join("web").join(marker);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "{}").unwrap();
            assert_eq!(tool(None, "typescript", &web, &settings).unwrap(), Some(Biome), "{marker}");
            assert_eq!(tool(None, "typescript", &api, &settings).unwrap(), Some(Prettier), "{marker}");
            // Biome doesn't format Markdown: Prettier keeps it.
            assert_eq!(tool(None, "markdown", &readme, &settings).unwrap(), Some(Prettier), "{marker}");
            std::fs::remove_file(&path).unwrap();
        }
        std::fs::write(root.join("web/biome.json"), "{}").unwrap();
        std::fs::write(root.join("web/.oxfmtrc.json"), "{}").unwrap();
        assert_eq!(tool(None, "css", &web, &settings).unwrap(), Some(Biome));
        settings.biome.languages.retain(|l| l != "css");
        assert_eq!(tool(None, "css", &web, &settings).unwrap(), Some(Oxfmt));
        // Biome only lints here: Prettier keeps formatting.
        std::fs::remove_file(root.join("web/.oxfmtrc.json")).unwrap();
        std::fs::write(root.join("web/biome.json"), r#"{ "formatter": { "enabled": false } }"#).unwrap();
        assert_eq!(tool(None, "typescript", &web, &settings).unwrap(), Some(Prettier));
        settings.biome.prefer = true;
        assert_eq!(tool(None, "typescript", &api, &settings).unwrap(), Some(Biome));
        let markdown = tool(Some(Biome), "markdown", &readme, &settings).unwrap_err();
        assert_eq!(markdown.message, "Biome cannot format Markdown files");
    }

    #[test]
    fn oxfmt_config_selects_oxfmt_for_its_enabled_languages() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("web/src")).unwrap();
        let (web, api) = (root.join("web/src/app.ts"), root.join("api/main.ts"));
        let mut settings = LanguagesSettings::default();
        assert_eq!(tool(None, "typescript", &web, &settings).unwrap(), Some(Prettier));
        for config in OXFMT_CONFIGS {
            std::fs::write(root.join("web").join(config), "{}").unwrap();
            assert_eq!(tool(None, "typescript", &web, &settings).unwrap(), Some(Oxfmt), "{config}");
            assert_eq!(tool(None, "typescript", &api, &settings).unwrap(), Some(Prettier), "{config}");
            std::fs::remove_file(root.join("web").join(config)).unwrap();
        }
        std::fs::write(root.join("web/.oxfmtrc.json"), "{}").unwrap();
        settings.oxfmt.languages.retain(|l| l != "markdown");
        assert_eq!(tool(None, "markdown", &web, &settings).unwrap(), Some(Prettier));
        assert_eq!(tool(None, "typescript", &web, &settings).unwrap(), Some(Oxfmt));
    }

    #[test]
    fn oxfmt_provider_selects_oxfmt_without_a_config_and_prettier_off_leaves_the_language_server() {
        let file = Path::new("/project/src/app.ts");
        let mut settings = LanguagesSettings::default();
        settings.oxfmt.prefer = true;
        assert_eq!(tool(None, "typescript", file, &settings).unwrap(), Some(Oxfmt));
        settings.oxfmt.prefer = false;
        settings.prettier.languages.clear();
        assert_eq!(tool(None, "typescript", file, &settings).unwrap(), None);
        settings.oxfmt.prefer = true;
        settings.oxfmt.languages.clear();
        assert_eq!(tool(None, "typescript", file, &settings).unwrap(), None);
    }

    #[test]
    fn forced_tool_runs_that_formatter_or_reports_why_not() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".oxfmtrc.json"), "{}").unwrap();
        let file = dir.path().join("app.ts");
        let mut settings = LanguagesSettings::default();
        settings.oxfmt.languages.clear();
        assert_eq!(tool(Some(Prettier), "typescript", &file, &settings).unwrap(), Some(Prettier));
        assert_eq!(tool(Some(Oxfmt), "typescript", &file, &settings).unwrap(), Some(Oxfmt));
        let rust = tool(Some(Oxfmt), "rust", &dir.path().join("main.rs"), &settings).unwrap_err();
        assert_eq!(rust.message, "oxfmt cannot format Rust files");
    }

    #[test]
    fn php_cs_fixer_needs_a_config_and_the_project_binary() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src/Http")).unwrap();
        let file = root.join("src/Http/Kernel.php");
        assert_eq!(formatter::php_cs_fixer(&file), None);
        std::fs::write(root.join(".php-cs-fixer.dist.php"), "<?php").unwrap();
        assert_eq!(formatter::php_cs_fixer(&file), None, "no vendor/bin/php-cs-fixer");
        std::fs::create_dir_all(root.join("vendor/bin")).unwrap();
        std::fs::write(root.join("vendor/bin/php-cs-fixer"), "").unwrap();
        let found = formatter::php_cs_fixer(&file).unwrap();
        assert_eq!(found.config, root.join(".php-cs-fixer.dist.php"));
        assert_eq!(found.bin, root.join("vendor/bin/php-cs-fixer"));
        std::fs::write(root.join(".php-cs-fixer.php"), "<?php").unwrap();
        assert_eq!(formatter::php_cs_fixer(&file).unwrap().config, root.join(".php-cs-fixer.php"));
        std::fs::write(root.join("src/.php-cs-fixer.dist.php"), "<?php").unwrap();
        assert_eq!(formatter::php_cs_fixer(&file).unwrap().config, root.join("src/.php-cs-fixer.dist.php"));
    }

    #[cfg(unix)]
    #[test]
    fn php_cs_fixer_fixes_a_copy_of_the_unsaved_text() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let fixer = formatter::PhpCsFixer { config: root.join(".php-cs-fixer.dist.php"), bin: root.join("fixer") };
        std::fs::write(&fixer.config, "<?php").unwrap();
        let php = root.join("php");
        // Stands in for `php vendor/bin/php-cs-fixer fix … <file>`: rewrites the last argument.
        std::fs::write(
            &php,
            "#!/bin/sh\nfor last; do :; done\ncase \"$last\" in */Kernel.php) ;; *) exit 3 ;; esac\n\
             [ \"$2\" = fix ] || exit 4\nsed 's/  echo/    echo/' \"$last\" > \"$last.new\" && mv \"$last.new\" \"$last\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&php, std::fs::Permissions::from_mode(0o755)).unwrap();
        let file = root.join("src/Kernel.php");
        let tools = Tools::new(&root.join("tools"));
        let edits = php_cs_fixer_edits(&tools, Some(&php), &fixer, &file, "<?php\n  echo 1;\n").unwrap();
        assert_eq!(edits.len(), 1);
        assert_eq!(edits[0].new_text, "  ");
        assert!(!file.exists(), "the file on disk is left alone");

        std::fs::write(&php, "#!/bin/sh\necho 'Configuration file is invalid' >&2\nexit 16\n").unwrap();
        let err = php_cs_fixer_edits(&tools, Some(&php), &fixer, &file, "<?php\n").unwrap_err();
        assert!(
            err.message.starts_with("PHP-CS-Fixer: ") && err.message.contains("Configuration file is invalid"),
            "{}",
            err.message
        );
    }

    fn after(text: &str, edits: &[TextEdit]) -> String {
        let mut doc = ide_text::Document::new(text);
        doc.apply_edits(edits).unwrap();
        doc.text()
    }

    fn whole_file(text: &str, formatted: &str) -> Vec<TextEdit> {
        let doc = ide_text::Document::new(text);
        doc.diff(formatted)
            .changes
            .into_iter()
            .map(|c| TextEdit {
                range: Range::new(doc.offset_to_pos(c.from), doc.offset_to_pos(c.to)),
                new_text: c.insert,
            })
            .collect()
    }

    const ALIGN: PhpAlignment = PhpAlignment { key_value_pairs: true, assignments: true };

    #[test]
    fn a_whole_file_edit_becomes_one_edit_per_changed_region() {
        let text = "a\n  b\nc\nd\n  e\n";
        let formatted = "a\nb\nc\nd\ne\n";
        let whole = vec![TextEdit { range: Range::new(Pos::new(0, 0), Pos::new(5, 0)), new_text: formatted.into() }];
        let edits = minimal_edits(text, whole);
        assert_eq!(
            edits,
            [
                TextEdit { range: Range::new(Pos::new(1, 0), Pos::new(1, 2)), new_text: String::new() },
                TextEdit { range: Range::new(Pos::new(4, 0), Pos::new(4, 2)), new_text: String::new() },
            ]
        );
        assert_eq!(after(text, &edits), formatted);
        // Single-line edits are already minimal and pass through.
        let small = vec![TextEdit { range: Range::new(Pos::new(1, 0), Pos::new(1, 2)), new_text: String::new() }];
        assert_eq!(minimal_edits(text, small.clone()), small);
    }

    #[test]
    fn php_alignment_is_off_unless_the_php_code_style_turns_it_on() {
        let php = LanguageId::new("php");
        let mut settings = Settings::default();
        assert_eq!(php_alignment(&settings, &php), PhpAlignment::default());
        let style =
            ide_core::editor_settings::LanguageCodeStyle { align_key_value_pairs: Some(true), ..Default::default() };
        settings.editor.code_style.languages.insert("php".into(), style);
        assert_eq!(php_alignment(&settings, &php), PhpAlignment { key_value_pairs: true, assignments: false });
        assert_eq!(php_alignment(&settings, &LanguageId::new("javascript")), PhpAlignment::default());
    }

    #[test]
    fn alignment_follows_the_formatter_edits_even_when_there_are_none() {
        let syntax = Syntax::new();
        let php = LanguageId::new("php");
        let text = "<?php\n$a = [\n    'a' => 1,\n    'bbb' => 2,\n];\n";
        let edits = align_formatted(&syntax, &php, text, Vec::new(), None, ALIGN).unwrap();
        assert_eq!(after(text, &edits), "<?php\n$a = [\n    'a'   => 1,\n    'bbb' => 2,\n];\n");

        // The language server re-indents the array: the alignment applies to its result.
        let text = "<?php\n$a = [\n'a' => 1,\n'bbb'   => 2,\n];\n";
        let formatted = "<?php\n$a = [\n    'a' => 1,\n    'bbb' => 2,\n];\n";
        let edits = align_formatted(&syntax, &php, text, whole_file(text, formatted), None, ALIGN).unwrap();
        assert_eq!(after(text, &edits), "<?php\n$a = [\n    'a'   => 1,\n    'bbb' => 2,\n];\n");

        let unchanged = whole_file(text, formatted);
        let off = align_formatted(&syntax, &php, text, unchanged.clone(), None, PhpAlignment::default()).unwrap();
        assert_eq!(off, unchanged);

        let overlapping = vec![
            TextEdit { range: Range::new(Pos::new(1, 0), Pos::new(1, 4)), new_text: "x".into() },
            TextEdit { range: Range::new(Pos::new(1, 2), Pos::new(1, 6)), new_text: "y".into() },
        ];
        let passed = align_formatted(&syntax, &php, text, overlapping.clone(), None, ALIGN).unwrap();
        assert_eq!(passed, overlapping);
    }

    #[test]
    fn a_selection_aligns_only_its_lines_whatever_the_formatter_changed() {
        let syntax = Syntax::new();
        let php = LanguageId::new("php");
        let text = "<?php\n$x = 1;\n$yyy = 2;\n$a = [\n    'a' => 1,\n    'bbb' => 2,\n];\n";
        // PHP-CS-Fixer formats the whole file (here: adds a line at the top) whatever the selection.
        let formatted = format!("<?php\n\ndeclare(strict_types=1);\n{}", &text["<?php\n".len()..]);
        let edits = whole_file(text, &formatted);
        // Lines 3..=6 select the array, up to the start of the line after it.
        let range = Range::new(Pos::new(3, 0), Pos::new(7, 0));
        let aligned = align_formatted(&syntax, &php, text, edits, Some(range), ALIGN).unwrap();
        assert_eq!(aligned.len(), 2, "one edit per changed region: {aligned:?}");
        assert_eq!(
            after(text, &aligned),
            "<?php\n\ndeclare(strict_types=1);\n$x = 1;\n$yyy = 2;\n$a = [\n    'a'   => 1,\n    'bbb' => 2,\n];\n"
        );
        let range = Range::new(Pos::new(1, 0), Pos::new(2, 9));
        let aligned = align_formatted(&syntax, &php, text, Vec::new(), Some(range), ALIGN).unwrap();
        assert_eq!(after(text, &aligned), "<?php\n$x   = 1;\n$yyy = 2;\n$a = [\n    'a' => 1,\n    'bbb' => 2,\n];\n");
    }

    #[test]
    fn offsets_map_through_changes() {
        let changes = ChangeSet {
            changes: vec![
                ide_core::TextChange { from: 2, to: 2, insert: "ab".into() },
                ide_core::TextChange { from: 5, to: 8, insert: "x".into() },
            ],
        };
        assert_eq!(map_offset(&changes, 0, false), 0);
        assert_eq!(map_offset(&changes, 2, false), 2);
        assert_eq!(map_offset(&changes, 2, true), 4);
        assert_eq!(map_offset(&changes, 4, false), 6);
        assert_eq!(map_offset(&changes, 6, false), 7);
        assert_eq!(map_offset(&changes, 6, true), 8);
        assert_eq!(map_offset(&changes, 8, false), 8);
        assert_eq!(map_offset(&changes, 10, false), 10);
    }

    #[test]
    fn ruff_ranges_are_one_based_unicode_columns() {
        let text = ide_text::Document::new("😀x = 1\ny  =  2\n");
        let range = Range::new(Pos::new(0, 2), Pos::new(1, 2));
        assert_eq!(
            format_range(&text, range),
            formatter::FormatRange {
                start_offset: 2,
                end_offset: 10,
                start_line: 1,
                start_col: 2,
                end_line: 2,
                end_col: 3,
            }
        );
    }
}
