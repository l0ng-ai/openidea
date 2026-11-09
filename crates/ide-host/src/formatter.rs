//! Select the document's formatting provider before executing it on this host.

use crate::Host;
use ide_core::event::NotifyLevel;
use ide_core::settings::{ExternalFormatter, LanguagesSettings};
use ide_core::{DocId, IdeError, IdeEvent, IdeResult, Pos, Range, TextEdit};
use ide_language::LanguageConfig;
use ide_lsp::types::FormatOptions;
use ide_tools::{Tools, formatter};
use std::path::Path;

const OXFMT_CONFIGS: [&str; 4] = [".oxfmtrc.json", ".oxfmtrc.jsonc", "oxfmt.config.ts", "oxfmt.config.mts"];

fn supports_external_format(language: &LanguageConfig, tool: ExternalFormatter) -> bool {
    match language.formatter.as_ref().map(|f| f.tool.as_str()) {
        Some("prettier") => matches!(tool, ExternalFormatter::Prettier | ExternalFormatter::Oxfmt),
        Some("ruff") => tool == ExternalFormatter::Ruff,
        _ => false,
    }
}

/// The external formatter of a file, for a language with an external formatter.
/// `forced` names the tool (Reformat with Prettier, oxfmt, or Ruff). Ruff is
/// the base formatter for Python; oxfmt can replace Prettier for its languages
/// when configured or selected. A tool that cannot format the language is
/// rejected even when explicitly requested.
fn external_tool(
    forced: Option<ExternalFormatter>,
    language: Option<&LanguageConfig>,
    file: &Path,
    settings: &LanguagesSettings,
) -> IdeResult<Option<ExternalFormatter>> {
    use ExternalFormatter::{Oxfmt, Prettier, Ruff};
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
    let oxfmt_config = || OXFMT_CONFIGS.iter().any(|name| formatter::find_up(file, Path::new(name)).is_some());
    Ok(if enabled(Oxfmt) && (settings.oxfmt.prefer || oxfmt_config()) {
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

pub async fn format(
    host: &Host,
    window: &str,
    doc: DocId,
    range: Option<Range>,
    options: FormatOptions,
) -> IdeResult<Vec<TextEdit>> {
    let project = host.project(window)?;
    let snap = project.documents.snapshot(doc)?;
    let settings = project.settings.effective();
    let language = project.languages.get(&snap.language);
    if options.tool.is_none()
        && let Some(id) = settings.languages.plugin_formatters.get(snap.language.as_str()).filter(|s| !s.is_empty())
    {
        if options.on_save && !settings.editor.format_on_save {
            return Ok(Vec::new());
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
        .map_err(|e| IdeError::internal(e.to_string()))?;
    }
    // A committed PHP-CS-Fixer configuration takes over Reformat Code for `.php` files.
    if options.tool.is_none()
        && snap.path.extension().is_some_and(|e| e == "php")
        && let Some(fixer) = formatter::php_cs_fixer(&snap.path)
    {
        if options.on_save && !settings.editor.format_on_save {
            return Ok(Vec::new());
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
        return Ok(edits);
    }
    let mut selected = external_tool(options.tool, language.as_ref(), &snap.path, &settings.languages)?;
    if let Some(tool) = selected
        && options.tool.is_none()
        && !settings.languages.formatter(tool).prefer
        && project.lsp.can_format(doc).await?
    {
        selected = None;
    }
    let Some(selected) = selected else {
        if options.on_save && !settings.editor.format_on_save {
            return Ok(Vec::new());
        }
        return project.lsp.format(doc, range, options).await;
    };
    let tool_settings = settings.languages.formatter(selected);
    if options.on_save && !tool_settings.run_on_save {
        return Ok(Vec::new());
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
    edits.map_err(|e| e.with_tool(tool))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ExternalFormatter::{Oxfmt, Prettier, Ruff};
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
