//! Cancellable, non-interactive Search Everywhere providers.
use super::PluginHost;
use ide_command::command;
use ide_core::{IdeError, IdeResult, RequestId, ipc_path::to_ipc};
use ide_extension::{Capability, Package, UiDecl, decode, validate_item_id};
use ide_plugin::{
    Invocation,
    search::{SearchPage, SearchTarget},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    sync::Arc,
    time::Duration,
};

pub(super) const POINT: &str = "searchCategories";
pub const MAX_RESULTS: u32 = 200;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Decl {
    id: String,
    title: String,
}

pub(super) fn declaration(pkg: &Package, value: toml::Value) -> Result<UiDecl, String> {
    let d: Decl = decode(POINT, value)?;
    pkg.manifest.needs_api("contributes.searchCategories", 13)?;
    validate_item_id(&d.id, "search category id")?;
    if pkg.manifest.wasm.is_none()
        || d.title.trim().is_empty()
        || d.title.len() > 256
        || d.title.chars().any(char::is_control)
    {
        return Err("search categories need code and a title of 1–256 bytes".into());
    }
    Ok(UiDecl::new(d.id.clone(), d.title.clone(), serde_json::to_value(d).map_err(|e| e.to_string())?))
}

#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum PluginSearchTarget {
    Location(ide_core::Location),
    Command { id: String, arg: Option<String> },
}
#[derive(Clone, Debug, Serialize, specta::Type)]
pub struct PluginSearchItem {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub target: PluginSearchTarget,
}
#[derive(Clone, Debug, Default, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginSearchPage {
    pub items: Vec<PluginSearchItem>,
    pub has_more: bool,
}

/// One page of `plugin_id`'s results for its search `category`. Cancellable with
/// `cancel_request(request)`.
#[allow(clippy::too_many_arguments)]
#[command(trust = trusted)]
pub async fn plugin_search(
    host: &crate::Host,
    plugins: &Arc<PluginHost>,
    window: &str,
    plugin_id: String,
    category: String,
    query: String,
    limit: u32,
    request: RequestId,
) -> IdeResult<PluginSearchPage> {
    if query.len() > 1024 || !(1..=MAX_RESULTS).contains(&limit) {
        return Err(IdeError::invalid("search query exceeds 1024 bytes or limit is outside 1–200"));
    }
    let root = host.project(window).ok().map(|p| p.root.clone());
    let invocation = Invocation { workspace_root: root, client: Some(window.to_owned()), ..Default::default() };
    let cancel = host.begin_project_request(window, request);
    let worker_cancel = cancel.clone();
    let plugins = plugins.clone();
    // Startup and file reads can outlive a provider call. The request still returns
    // promptly; the worker checks this token before doing or publishing more work.
    let result = tokio::select! {
        _ = cancel.cancelled() => Err(IdeError::cancelled()),
        result = tokio::time::timeout(Duration::from_secs(2), host.blocking(move || {
            plugins.search_category(&plugin_id, &category, query, limit, invocation, &worker_cancel)
        })) => match result {
            Ok(result) => result,
            Err(_) => Err(IdeError::new(ide_core::error::ErrorKind::TimedOut, "plugin search timed out")),
        },
    };
    cancel.cancel();
    host.end_request(request);
    result
}

impl PluginHost {
    fn search_category(
        &self,
        plugin: &str,
        category: &str,
        query: String,
        limit: u32,
        invocation: Invocation,
        cancel: &ide_core::CancellationToken,
    ) -> IdeResult<PluginSearchPage> {
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        let loaded = self.get(plugin)?;
        let workspace = self.shared.workspace();
        let eligible = || {
            loaded.status().is_live()
                && loaded.meta.lock().pending.is_empty()
                && self.ui.items(POINT, Some(plugin)).iter().any(|d| d.key == category)
                && loaded.dev_root.as_deref().is_none_or(|r| invocation.workspace_root.as_deref() == Some(r))
                && invocation
                    .workspace_root
                    .as_ref()
                    .is_none_or(|r| workspace.as_ref().is_some_and(|w| w.projects().contains(r) && w.trusted(r)))
        };
        if !eligible() {
            return Err(IdeError::unavailable("search category is no longer available"));
        }
        let id = category.to_owned();
        let page = self.code_call_with_budget(
            plugin,
            invocation.clone(),
            "searching",
            Some(cancel),
            Some(Duration::from_secs(2)),
            move |rt, ctx| rt.search(&id, &query, limit, ctx),
        )?;
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        if !eligible() || !self.plugins.read().get(plugin).is_some_and(|p| Arc::ptr_eq(p, &loaded)) {
            return Err(IdeError::cancelled());
        }
        let commands = self.ui.items(super::points::COMMANDS, Some(plugin)).into_iter().map(|d| d.key).collect();
        let can_read = loaded.meta.lock().granted.contains(&Capability::ProjectRead);
        let check = || {
            if cancel.is_cancelled()
                || !eligible()
                || !self.plugins.read().get(plugin).is_some_and(|p| Arc::ptr_eq(p, &loaded))
            {
                Err(IdeError::cancelled())
            } else {
                Ok(())
            }
        };
        let page = validate(page, limit, &commands, |location| {
            check()?;
            if !can_read {
                return Err(IdeError::invalid("search locations require project.read"));
            }
            let root = invocation
                .workspace_root
                .as_deref()
                .ok_or_else(|| IdeError::invalid("search locations need a project"))?;
            let path =
                ide_plugin::resolve_in_root(root, &location.path.to_string_lossy()).map_err(IdeError::invalid)?;
            let w = workspace.as_ref().ok_or_else(|| IdeError::unavailable("project closed"))?;
            let text = w
                .buffer_text_in(invocation.client.as_deref(), &path)
                .map(Ok)
                .unwrap_or_else(|| ide_plugin::read_text(&path).map_err(IdeError::invalid))?;
            check()?;
            Ok((path, text))
        })?;
        check()?;
        Ok(page)
    }
}

fn validate(
    page: SearchPage,
    limit: u32,
    commands: &BTreeSet<String>,
    mut document: impl FnMut(&ide_plugin::Location) -> IdeResult<(std::path::PathBuf, String)>,
) -> IdeResult<PluginSearchPage> {
    if page.items.len() > limit as usize {
        return Err(IdeError::invalid("search provider exceeded its result limit"));
    }
    let mut ids = BTreeSet::new();
    let mut bytes = 0;
    let mut document_bytes = 0;
    let mut texts = BTreeMap::new();
    let mut items = Vec::with_capacity(page.items.len());
    for item in page.items {
        bytes += item.id.len() + item.title.len() + item.description.as_ref().map_or(0, String::len);
        if item.id.is_empty()
            || item.id.len() > 256
            || !ids.insert(item.id.clone())
            || item.title.trim().is_empty()
            || item.title.len() > 1024
            || item.title.chars().any(char::is_control)
            || item.description.as_ref().is_some_and(|s| s.len() > 4096 || s.chars().any(char::is_control))
        {
            return Err(IdeError::invalid("invalid or duplicate search result"));
        }
        let target = match item.target {
            SearchTarget::Command { id, arg } => {
                bytes += id.len() + arg.as_ref().map_or(0, String::len);
                if !commands.contains(&id) || arg.as_ref().is_some_and(|s| s.len() > 16 << 10) {
                    return Err(IdeError::invalid(
                        "search results may only run their plugin's declared commands, with at most 16 KiB of arguments",
                    ));
                }
                PluginSearchTarget::Command { id, arg }
            }
            SearchTarget::Location(location) => {
                bytes += location.path.as_os_str().len();
                if !texts.contains_key(&location.path) {
                    let (path, text) = document(&location)?;
                    document_bytes += text.len();
                    if document_bytes > 16 << 20 {
                        return Err(IdeError::invalid("search documents exceed 16 MiB"));
                    }
                    let lines: Vec<usize> =
                        text.split('\n').map(|s| s.trim_end_matches('\r').encode_utf16().count()).collect();
                    texts.insert(location.path.clone(), (path, lines));
                }
                let (path, lines) = &texts[&location.path];
                let range = location.range;
                if range.start > range.end
                    || [range.start, range.end]
                        .iter()
                        .any(|p| lines.get(p.line as usize).is_none_or(|len| p.col as usize > *len))
                {
                    return Err(IdeError::invalid("search location is outside its UTF-16 document range"));
                }
                PluginSearchTarget::Location(ide_core::Location {
                    path: to_ipc(Path::new(path)).into(),
                    range,
                    uri: None,
                })
            }
        };
        if bytes > 1 << 20 {
            return Err(IdeError::invalid("search results exceed 1 MiB"));
        }
        items.push(PluginSearchItem { id: item.id, title: item.title, description: item.description, target });
    }
    Ok(PluginSearchPage { items, has_more: page.has_more && limit < MAX_RESULTS })
}

ide_command::domain!(plugins_search: plugin_search);

#[cfg(test)]
mod tests {
    use super::*;
    use ide_plugin::search::SearchItem;
    fn command(id: &str) -> SearchItem {
        SearchItem {
            id: "one".into(),
            title: "Open route".into(),
            description: None,
            target: SearchTarget::Command { id: id.into(), arg: Some("/users/:id".into()) },
        }
    }
    #[test]
    fn bounded_results_and_only_own_declared_commands() {
        let declared = BTreeSet::from(["open".into()]);
        let check = |items, limit| validate(SearchPage { items, has_more: true }, limit, &declared, |_| unreachable!());
        assert!(check(vec![command("open")], 1).unwrap().has_more);
        assert!(!check(vec![command("open")], MAX_RESULTS).unwrap().has_more);
        assert!(check(vec![command("other.plugin.command")], 1).is_err());
        assert!(check(vec![command("open"), command("open")], 2).is_err());
        assert!(check(vec![command("open")], 0).is_err());
        let mut bad = command("open");
        bad.title = "bad\nresult".into();
        assert!(check(vec![bad], 1).is_err());
    }
    #[test]
    fn source_locations_use_utf16_and_validate_whole_page() {
        let item = |end| SearchItem {
            id: "source".into(),
            title: "Handler".into(),
            description: None,
            target: SearchTarget::Location(ide_plugin::Location {
                path: "routes.txt".into(),
                range: ide_core::Range::new(ide_core::Pos::new(0, 2), ide_core::Pos::new(0, end)),
            }),
        };
        let check = |end| {
            validate(SearchPage { items: vec![item(end)], has_more: false }, 50, &BTreeSet::new(), |_| {
                Ok(("/project/routes.txt".into(), "😀x\n".into()))
            })
        };
        assert!(check(3).is_ok());
        assert!(check(4).is_err());
        assert!(check(1).is_err());
    }
}
