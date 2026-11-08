//! The `viteAsset` reference kind: the asset paths of the project's Vite
//! build ([`ViteAssets`]) in Blade's `@vite('…')` / `@vite([...])` and in
//! `Vite::asset('…')`, `Vite::content('…')` and `Vite::withEntryPoints([...])`,
//! as Laravel's documentation on asset bundling lists them.
//!
//! Completion goes as a path tree (entry points first), goto opens the
//! file, and a path that is neither a file, an entry point nor in the build
//! manifest is undefined.

use super::{CalleePattern, PlacePattern, Position, RefContext, RefItem, ReferenceKind, Undefined};
use crate::frameworks::laravel::assets::ViteAssets;
use crate::navigate::Target;

/// Laravel's `Vite` facade (and its global alias) and the class behind it.
const VITE: &[&str] = &["Illuminate\\Support\\Facades\\Vite", "Vite", "Illuminate\\Foundation\\Vite"];

const ASSET: CalleePattern = CalleePattern::Method { classes: VITE, names: &["asset", "content"] };
const ENTRY_POINTS: CalleePattern = CalleePattern::Method { classes: VITE, names: &["withEntryPoints"] };
const BLADE_VITE: CalleePattern = CalleePattern::Function("__blade_vite");

static PATTERNS: [PlacePattern; 5] = [
    PlacePattern::argument(ASSET, 0, "asset"),
    PlacePattern::argument(ENTRY_POINTS, 0, "entryPoints").at(Position::ListValue),
    // `@vite('…')` and `@vite([...])` (see `crate::blade::CALL_DIRECTIVES`).
    PlacePattern::argument(BLADE_VITE, 0, "entrypoints"),
    PlacePattern::argument(BLADE_VITE, 0, "entrypoints").at(Position::ListValue),
    PlacePattern::argument(ENTRY_POINTS, 0, "entryPoints"),
];

/// See the module documentation.
pub struct ViteAsset;

impl ViteAsset {
    fn assets(cx: &RefContext<'_>) -> std::sync::Arc<ViteAssets> {
        cx.engine.laravel_assets().unwrap_or_default()
    }
}

impl ReferenceKind for ViteAsset {
    fn id(&self) -> &'static str {
        "viteAsset"
    }

    fn patterns(&self) -> &'static [PlacePattern] {
        &PATTERNS
    }

    fn complete(&self, cx: &RefContext<'_>, value: &str, at: usize) -> Vec<RefItem> {
        let assets = Self::assets(cx);
        let typed = &value[..at.min(value.len())];
        let to = value[at.min(value.len())..].find('/').map_or(value.len(), |slash| at + slash);
        let (parent, from) = match typed.rfind('/') {
            Some(slash) => (Some(&typed[..slash]), slash + 1),
            None => (None, 0),
        };
        assets
            .children(parent)
            .into_iter()
            .map(|child| {
                let detail = if child.entry {
                    "entry point"
                } else if child.file {
                    "asset"
                } else {
                    "folder"
                };
                let insert = if child.file { child.segment.clone() } else { format!("{}/", child.segment) };
                RefItem { label: insert.clone(), insert, detail: Some(detail.to_owned()), from, to }
            })
            .collect()
    }

    fn resolve(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Vec<Target> {
        let assets = Self::assets(cx);
        if let Some(path) = assets.file(value) {
            return vec![Target { path, range: Default::default() }];
        }
        match (&assets.config, assets.entry_range(value)) {
            (Some(config), Some(range)) => vec![Target { path: config.clone(), range }],
            _ => Vec::new(),
        }
    }

    fn is_known(&self, cx: &RefContext<'_>, value: &str) -> bool {
        Self::assets(cx).is_known(value)
    }

    fn undefined(&self, cx: &RefContext<'_>, value: &str) -> Option<Undefined> {
        let assets = Self::assets(cx);
        (!assets.is_known(value)).then(|| Undefined::warning(format!("Vite asset '{value}' is not found")))
    }
}
