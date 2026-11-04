//! Select the document's formatting provider before executing it on this host.

use crate::Host;
use ide_core::event::NotifyLevel;
use ide_core::settings::{ExternalFormatter, LanguagesSettings};
use ide_core::{DocId, IdeError, IdeEvent, IdeResult, Range, TextEdit};
use ide_language::LanguageConfig;
use ide_lsp::types::FormatOptions;
use ide_tools::{Tools, formatter};
use std::path::Path;

const OXFMT_CONFIGS: [&str; 4] = [".oxfmtrc.json", ".oxfmtrc.jsonc", "oxfmt.config.ts", "oxfmt.config.mts"];

/// The external formatter of a file, for a language with an external formatter.
/// `forced` names the tool (Reformat with Prettier/oxfmt). Otherwise oxfmt
/// applies when it is enabled for the language and either an oxfmt
/// configuration is found above the file or oxfmt is the selected provider;
/// else Prettier, when it is enabled. Turning Prettier off for a language
/// leaves it to the language server, not to oxfmt.
fn external_tool(
    forced: Option<ExternalFormatter>,
    language: Option<&LanguageConfig>,
    file: &Path,
    settings: &LanguagesSettings,
) -> IdeResult<Option<ExternalFormatter>> {
    use ExternalFormatter::{Oxfmt, Prettier};
    let Some(language) = language.filter(|l| l.formatter.as_ref().is_some_and(|f| f.tool == "prettier")) else {
        return match forced {
            Some(tool) => Err(IdeError::invalid(format!(
                "{} cannot format {} files",
                formatter::display_name(tool.name()),
                language.map_or("these", |l| l.name.as_str())
            ))),
            None => Ok(None),
        };
    };
    if forced.is_some() {
        return Ok(forced);
    }
    let enabled = |tool| settings.formatter(tool).languages.iter().any(|l| l == language.id.as_str());
    let oxfmt_config = || OXFMT_CONFIGS.iter().any(|name| formatter::find_up(file, Path::new(name)).is_some());
    Ok(if enabled(Oxfmt) && (settings.oxfmt.prefer || oxfmt_config()) {
        Some(Oxfmt)
    } else {
        enabled(Prettier).then_some(Prettier)
    })
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
    let edits: IdeResult<Vec<TextEdit>> = tokio::task::spawn_blocking(move || {
        let text = ide_text::Document::new(&snap.text);
        let offsets = range.map(|r| (text.pos_to_offset(r.start), text.pos_to_offset(r.end)));
        let mut command = tools.formatter_command(tool, &snap.path, custom.as_deref())?;
        let dir = snap.path.parent().ok_or_else(|| IdeError::invalid(format!("{name}: file has no directory")))?;
        command.current_dir(dir);
        command.args(formatter::arguments(tool, &config, &snap.path, options.tab_size, options.insert_spaces, offsets));
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
    use ExternalFormatter::{Oxfmt, Prettier};
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
    fn default_settings_give_every_external_formatter_language_to_prettier() {
        let settings = LanguagesSettings::default();
        let file = Path::new("/project/file");
        for lang in LanguageRegistry::load(None).unwrap().all() {
            let configured = lang.formatter.as_ref().is_some_and(|f| f.tool == "prettier");
            let selected = external_tool(None, Some(&lang), file, &settings).unwrap();
            assert_eq!(selected, configured.then_some(Prettier), "{}", lang.id);
        }
        assert_eq!(external_tool(None, None, file, &settings).unwrap(), None);
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
}
