//! Select the document's formatting provider before executing it on this host.

use crate::Host;
use ide_core::event::NotifyLevel;
use ide_core::settings::PrettierSettings;
use ide_core::{DocId, IdeError, IdeEvent, IdeResult, Range, TextEdit};
use ide_language::FormatterConfig;
use ide_lsp::types::FormatOptions;
use ide_tools::{Tools, formatter};

fn external_selected(config: Option<&FormatterConfig>, language: &str, settings: &PrettierSettings, lsp: bool) -> bool {
    config.is_some_and(|c| c.tool == "prettier")
        && settings.languages.iter().any(|l| l == language)
        && (settings.prefer || !lsp)
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
    let prettier = &settings.languages.prettier;
    let language = project.languages.get(&snap.language);
    let config = language.as_ref().and_then(|l| l.formatter.as_ref());
    let candidate =
        config.is_some_and(|c| c.tool == "prettier") && prettier.languages.iter().any(|l| l == snap.language.as_str());
    let lsp = if candidate && !prettier.prefer { project.lsp.can_format(doc).await? } else { false };
    if !external_selected(config, snap.language.as_str(), prettier, lsp) {
        if options.on_save && !settings.editor.format_on_save {
            return Ok(Vec::new());
        }
        return project.lsp.format(doc, range, options).await;
    }
    if options.on_save && !prettier.run_on_save {
        return Ok(Vec::new());
    }
    host.require_trust(window)?;
    if snap.read_only {
        return Err(IdeError::invalid("The file is read-only"));
    }
    let config = config.unwrap().clone();
    let custom = ide_sdk::apply::setting_path(&project.root, &prettier.path);
    let tools = Tools::new(&host.local_data_dir);
    let whole_selection = range.is_some() && !config.range;
    let edits: IdeResult<Vec<TextEdit>> = tokio::task::spawn_blocking(move || {
        let text = ide_text::Document::new(&snap.text);
        let offsets = range.map(|r| (text.pos_to_offset(r.start), text.pos_to_offset(r.end)));
        let mut command = tools.formatter_command(&config.tool, &snap.path, custom.as_deref())?;
        command.current_dir(snap.path.parent().ok_or_else(|| IdeError::invalid("Prettier: file has no directory"))?);
        command.args(formatter::arguments(&config, &snap.path, options.tab_size, options.insert_spaces, offsets));
        let formatted = formatter::run(command, &snap.text, &Default::default())?;
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
            title: "Prettier".into(),
            body: Some(
                "Prettier does not support selection formatting for this language; formatted the whole file".into(),
            ),
        });
    }
    edits.map_err(|e| e.with_tool("prettier"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_enablement_and_preference_preserve_lsp_formatters() {
        let languages = ide_language::LanguageRegistry::load(None).unwrap();
        let mut settings = PrettierSettings::default();
        for lang in languages.all() {
            for lsp in [false, true] {
                let configured = lang.formatter.as_ref().is_some_and(|f| f.tool == "prettier");
                assert_eq!(
                    external_selected(lang.formatter.as_ref(), lang.id.as_str(), &settings, lsp),
                    configured && !lsp,
                    "{}",
                    lang.id
                );
            }
        }
        let ts = languages.get(&ide_core::LanguageId::new("typescript")).unwrap();
        settings.prefer = true;
        assert!(external_selected(ts.formatter.as_ref(), "typescript", &settings, true));
        settings.languages.clear();
        assert!(!external_selected(ts.formatter.as_ref(), "typescript", &settings, false));
        assert!(!external_selected(None, "rust", &settings, false));
    }
}
