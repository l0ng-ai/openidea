//! Twig templates (`ide_php::twig`) as the `twig` [`LanguageService`]: the
//! Structure view, completion of variables, tags, filters, functions,
//! tests and template names, and goto definition of the templates a
//! template loads. Twig has no language server, so the service answers
//! whether or not the PHP engine runs; everything is computed from the open
//! document's text and the project's template directories.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use ide_core::{CancellationToken, DocId, Location, OutlineItem, Pos, ServerId};
use ide_lsp::types::{CompletionItem, CompletionKind, CompletionList, GotoKind, Markup};
use ide_php::twig::{self, TemplatePaths, TwigCompletion, TwigCompletionKind};
use ide_workspace::Documents;

use crate::language_service::{Answer, LanguageService};

pub(crate) struct TwigService {
    root: PathBuf,
    documents: Arc<Documents>,
    server: ServerId,
}

impl TwigService {
    pub(crate) fn new(root: &Path, documents: Arc<Documents>) -> Self {
        Self { root: root.to_path_buf(), documents, server: ServerId::next() }
    }

    /// The text of an open local Twig document (not a virtual or oversized one).
    fn text(&self, doc: DocId) -> Option<String> {
        let info = self.documents.snapshot(doc).ok()?;
        (info.language.as_str() == "twig" && info.uri.is_none() && !info.large).then_some(info.text)
    }

    /// Whether the Symfony Twig bridge is installed (its filters and functions apply).
    fn symfony(&self) -> bool {
        ["vendor/symfony/twig-bridge", "vendor/symfony/twig-bundle", "vendor/symfony/symfony"]
            .iter()
            .any(|dir| self.root.join(dir).is_dir())
    }
}

impl LanguageService for TwigService {
    fn document_symbols(&self, doc: DocId) -> Answer<Option<Vec<OutlineItem>>> {
        let text = self.text(doc)?;
        Some(Ok(Some(twig::outline(&text))))
    }

    fn completion(
        &self,
        doc: DocId,
        pos: Pos,
        _trigger: Option<&str>,
        _cancel: &CancellationToken,
    ) -> Answer<CompletionList> {
        let text = self.text(doc)?;
        let paths = TemplatePaths::discover(&self.root);
        let items = twig::completions(&text, pos, self.symfony(), &paths)
            .into_iter()
            .map(|item| completion_item(item, self.server))
            .collect();
        Some(Ok(CompletionList { is_incomplete: false, items }))
    }

    fn goto(&self, doc: DocId, pos: Pos, kind: GotoKind) -> Answer<Vec<Location>> {
        let text = self.text(doc)?;
        if !matches!(kind, GotoKind::Definition | GotoKind::Declaration) {
            return Some(Ok(Vec::new()));
        }
        let paths = TemplatePaths::discover(&self.root);
        let targets = twig::goto_template(&text, pos, &paths)
            .map(|(path, _)| Location::file(path, Default::default()))
            .into_iter()
            .collect();
        Some(Ok(targets))
    }
}

fn completion_item(item: TwigCompletion, server: ServerId) -> CompletionItem {
    let kind = match item.kind {
        TwigCompletionKind::Variable => CompletionKind::Variable,
        TwigCompletionKind::Macro | TwigCompletionKind::Function => CompletionKind::Function,
        TwigCompletionKind::Filter => CompletionKind::Method,
        TwigCompletionKind::Test => CompletionKind::Operator,
        TwigCompletionKind::Tag => CompletionKind::Keyword,
        TwigCompletionKind::Template => CompletionKind::File,
    };
    CompletionItem {
        label: item.label,
        label_detail: None,
        detail: item.detail,
        kind: Some(kind),
        documentation: item.documentation.map(|value| Markup { kind: "markdown".into(), value }),
        sort_text: Some(item.sort_text),
        filter_text: None,
        preselect: false,
        deprecated: false,
        insert_text: item.insert_text,
        is_snippet: false,
        replace_range: Some(item.replace),
        replace_range_tab: None,
        additional_edits: Vec::new(),
        commit_characters: Vec::new(),
        command: None,
        data: None,
        server,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::{IdeEvent, LanguageId};

    fn service(root: &Path) -> (TwigService, Arc<Documents>) {
        let documents = Arc::new(Documents::new(Arc::new(|_: IdeEvent| {}), Box::new(|_, _| LanguageId::new("twig"))));
        (TwigService::new(root, documents.clone()), documents)
    }

    #[test]
    fn answers_open_twig_documents() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        std::fs::create_dir_all(root.join("templates")).unwrap();
        std::fs::write(root.join("templates/base.html.twig"), "{% block body %}{% endblock %}").unwrap();
        std::fs::create_dir_all(root.join("vendor/symfony/twig-bridge")).unwrap();
        let page = root.join("templates/page.html.twig");
        let text = "{% extends 'base.html.twig' %}\n{% block body %}{{ pa }}{% endblock %}\n";
        std::fs::write(&page, text).unwrap();
        let (service, documents) = service(&root);
        let doc = documents.open(&page).unwrap().id;

        let outline = service.document_symbols(doc).unwrap().unwrap().unwrap();
        let names: Vec<&str> = outline.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(names, ["base.html.twig", "body"]);

        let list = service.completion(doc, Pos { line: 1, col: 21 }, None, &CancellationToken::new()).unwrap().unwrap();
        let path = list.items.iter().find(|i| i.label == "path").expect("Symfony's path()");
        assert_eq!(path.kind, Some(CompletionKind::Function));
        assert_eq!(path.server, service.server);

        let targets = service.goto(doc, Pos { line: 0, col: 14 }, GotoKind::Definition).unwrap().unwrap();
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].path.as_ref() as &Path, root.join("templates").join("base.html.twig").as_path());
        let none = service.goto(doc, Pos { line: 1, col: 21 }, GotoKind::Definition).unwrap().unwrap();
        assert!(none.is_empty());
    }
}
