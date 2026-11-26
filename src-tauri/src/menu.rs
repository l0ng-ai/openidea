//! Native application menu.
//!
//! The menu is described by a pure spec table ([`spec`]) and rendered with
//! Tauri's menu API ([`build`]). IDE items carry their *action id* as the menu
//! item id; clicking one emits [`MENU_EVENT`] to the focused window, whose
//! frontend runs `executeAction(id)`.
//!
//! # Accelerators
//! The JS keymap is the only dispatcher of IDE shortcuts (`when` clauses, chords,
//! user overrides). On macOS a focused WKWebView receives every key event before
//! the menu, and the menu performs a key equivalent only when the page did not
//! handle the key. IDE items therefore carry the native accelerator of their first
//! keymap binding ([`MenuConfig::accelerators`]) so the menu draws the shortcut in
//! its own column, and a menu event that such a key equivalent fires is dropped
//! ([`fires_natively`]): the keymap has already declined that key. Bindings with no
//! native form (chords, double modifiers) show no shortcut, as in IDEA. Items with
//! a spec accelerator fire natively for keys the keymap never binds: Quit and
//! window cycling, next to the macOS clipboard/undo roles that text inputs need.

pub use ide_host::menu::*;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashSet;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, MenuItemKind, NativeIcon, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Runtime};

/// Event emitted to the focused window when an IDE menu item is clicked.
pub const MENU_EVENT: &str = "openidea://menu";

/// Payload of [`MENU_EVENT`]: the route, and the window that was in front when the item was
/// chosen if the action runs in another one (a Settings window's project window).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuEvent<'a> {
    #[serde(flatten)]
    pub route: &'a MenuRoute,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub return_to: Option<&'a str>,
}

fn render_dynamic(item: &DynamicItem, config: &MenuConfig) -> RenderedItem {
    RenderedItem::Action {
        id: item.item_id(),
        text: item.label.clone(),
        accel: config.dynamic_accelerator(item).map(Into::into),
        checked: item.checked,
    }
}

#[derive(Default)]
pub struct MenuState {
    pub config: Mutex<MenuConfig>,
    /// Action ids the focused window reports as disabled (no context / not registered).
    pub disabled: Mutex<HashSet<String>>,
    /// Visible menu last installed. Accelerators of actions that are not on the menu
    /// are not part of this, so they must not redraw the macOS menu bar.
    rendered: Mutex<Option<Vec<RenderedMenu>>>,
    /// The Remote Development projects of the frontend's recent list.
    pub remote_recent: Mutex<Vec<RemoteRecent>>,
}

/// Stores the remote recent list; `false` when it is unchanged.
pub fn store_remote_recent(state: &MenuState, next: Vec<RemoteRecent>) -> bool {
    let mut current = state.remote_recent.lock();
    if *current == next {
        return false;
    }
    *current = next;
    true
}

/// Stores `next` when it differs from the config last used to build the menu.
/// Callers must not replace the menu on `false`: `set_menu` redraws the macOS menu bar.
pub fn store_config(state: &MenuState, next: MenuConfig) -> bool {
    let mut current = state.config.lock();
    if *current == next {
        return false;
    }
    *current = next;
    true
}

/// Whether the item `id` performs its own key equivalent: only items with a spec accelerator.
/// A keymap accelerator is drawn for display, and its key reached the menu because the
/// keymap declined it, so an event it fires is dropped.
#[cfg(any(target_os = "macos", test))]
pub fn fires_natively(spec: &[Entry], id: &str) -> bool {
    spec.iter().any(|entry| match entry {
        Entry::Submenu { children, .. } => fires_natively(children, id),
        Entry::Action { id: action, accel, .. } => *action == id && accel.is_some(),
        _ => false,
    })
}

/// The action an item id stands for, if it is an IDE action item.
fn item_action(id: &str) -> Option<&str> {
    if id.starts_with(RECENT_PREFIX) || id == "recent.none" || id.starts_with("submenu:") {
        return None;
    }
    Some(id.strip_prefix(DYNAMIC_PREFIX).map_or(id, |rest| rest.split_once('|').map_or(rest, |(a, _)| a)))
}

/// Whether the item `id` is enabled given the disabled action ids.
pub fn item_enabled(id: &str, disabled: &HashSet<String>) -> bool {
    id != "recent.none" && item_action(id).is_none_or(|a| !disabled.contains(a))
}

/// Updates the enabled state of the installed menu's items in place (no rebuild).
pub fn apply_disabled<R: Runtime>(app: &AppHandle<R>, disabled: &HashSet<String>) {
    fn walk<R: Runtime>(items: Vec<MenuItemKind<R>>, disabled: &HashSet<String>) {
        for item in items {
            match item {
                MenuItemKind::MenuItem(i) => {
                    let enabled = item_enabled(i.id().as_ref(), disabled);
                    if i.is_enabled().is_ok_and(|e| e != enabled) {
                        let _ = i.set_enabled(enabled);
                    }
                }
                MenuItemKind::Check(i) => {
                    let enabled = item_enabled(i.id().as_ref(), disabled);
                    if i.is_enabled().is_ok_and(|e| e != enabled) {
                        let _ = i.set_enabled(enabled);
                    }
                }
                MenuItemKind::Submenu(s) => {
                    if let Ok(children) = s.items() {
                        walk(children, disabled)
                    }
                }
                _ => {}
            }
        }
    }
    if let Some(menu) = app.menu()
        && let Ok(items) = menu.items()
    {
        walk(items, disabled);
    }
}

/// One top-level menu, as it will actually be drawn.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RenderedMenu {
    id: &'static str,
    title: String,
    items: Vec<RenderedItem>,
}

/// A visible menu row. Unused keymap accelerators are intentionally absent.
#[derive(Debug, Clone, PartialEq, Eq)]
enum RenderedItem {
    Submenu {
        id: String,
        title: String,
        current: bool,
        items: Vec<RenderedItem>,
    },
    /// `accel` is the spec's accelerator, or else the keymap's from [`MenuConfig::accelerators`].
    /// `checked` is set for a toggle, drawn as a check item.
    Action {
        id: String,
        text: String,
        accel: Option<String>,
        checked: Option<bool>,
    },
    /// Always disabled (`No Recent Projects`).
    Placeholder {
        id: String,
        text: String,
    },
    Native {
        kind: Native,
        text: String,
    },
    Separator,
}

fn prepared_spec<R: Runtime>(app: &AppHandle<R>, os: Os) -> Vec<Entry> {
    let mut entries = spec(os);
    if !crate::commands::window::updates_configured(app) {
        entries = without_action(entries, "app.checkForUpdates");
    }
    entries
}

/// Visible items for `entries`. Accelerators that no item displays do not affect the result.
fn render_bar(entries: &[Entry], config: &MenuConfig, recent: &[RecentItem]) -> Vec<RenderedMenu> {
    entries
        .iter()
        .filter_map(|entry| match entry {
            Entry::Submenu { id, label, children } => {
                Some(RenderedMenu { id, title: config.label(id, label), items: render_items(children, config, recent) })
            }
            _ => None,
        })
        .collect()
}

fn render_items(entries: &[Entry], config: &MenuConfig, recent: &[RecentItem]) -> Vec<RenderedItem> {
    let mut out = Vec::new();
    for entry in entries {
        match entry {
            Entry::Submenu { id, label, children } => out.push(RenderedItem::Submenu {
                id: (*id).into(),
                title: config.label(id, label),
                current: false,
                items: render_items(children, config, recent),
            }),
            Entry::Action { id, label, accel, hint, check } => out.push(RenderedItem::Action {
                id: (*id).into(),
                text: config.item_text(id, label, *hint),
                accel: accel.or_else(|| config.accelerator(id)).map(Into::into),
                checked: check.then(|| config.checked.iter().any(|c| c == id)),
            }),
            Entry::Dynamic(DYNAMIC_LAYOUTS) => {
                let layouts = config.layout_menus();
                if !layouts.is_empty() {
                    out.push(RenderedItem::Separator);
                }
                out.extend(layouts.into_iter().map(|layout| {
                    RenderedItem::Submenu {
                        id: layout.id,
                        title: layout.name.replace('&', "&&"),
                        current: layout.current,
                        items: layout
                            .items
                            .into_iter()
                            .map(|item| item.map_or(RenderedItem::Separator, |item| render_dynamic(&item, config)))
                            .collect(),
                    }
                }));
            }
            Entry::Dynamic(DYNAMIC_FLUTTER_BUILD) => {
                let items = config.dynamic_items(DYNAMIC_FLUTTER_BUILD);
                if !items.is_empty() {
                    out.push(RenderedItem::Submenu {
                        id: FLUTTER_BUILD_MENU.into(),
                        title: config.label(FLUTTER_BUILD_MENU, "Flutter"),
                        current: false,
                        items: items.iter().map(|item| render_dynamic(item, config)).collect(),
                    });
                    out.push(RenderedItem::Separator);
                }
            }
            Entry::Dynamic(slot) => {
                out.extend(config.dynamic_items(slot).iter().map(|item| render_dynamic(item, config)))
            }
            Entry::Native(kind) => {
                out.push(RenderedItem::Native { kind: *kind, text: config.label(kind.key(), kind.default_label()) })
            }
            Entry::Separator => out.push(RenderedItem::Separator),
            Entry::RecentProjects if recent.is_empty() => out.push(RenderedItem::Placeholder {
                id: "recent.none".into(),
                text: config.label("recent.none", "No Recent Projects"),
            }),
            Entry::RecentProjects => {
                for item in recent {
                    out.push(RenderedItem::Action {
                        id: format!("{RECENT_PREFIX}{}", item.path),
                        text: item.label.clone(),
                        accel: None,
                        checked: None,
                    });
                }
            }
        }
    }
    out
}

fn structure_key(item: &RenderedItem) -> (u8, &str) {
    match item {
        RenderedItem::Submenu { id, .. } => (0, id.as_str()),
        RenderedItem::Action { id, checked: None, .. } => (1, id.as_str()),
        RenderedItem::Action { id, checked: Some(_), .. } => (5, id.as_str()),
        RenderedItem::Placeholder { id, .. } => (2, id.as_str()),
        RenderedItem::Native { kind, .. } => (3, kind.key()),
        RenderedItem::Separator => (4, ""),
    }
}

fn same_structure(previous: &[RenderedItem], next: &[RenderedItem]) -> bool {
    previous.len() == next.len()
        && previous.iter().zip(next).all(|(left, right)| structure_key(left) == structure_key(right))
}

fn same_toplevel(previous: &[RenderedMenu], next: &[RenderedMenu]) -> bool {
    previous.len() == next.len() && previous.iter().zip(next).all(|(left, right)| left.id == right.id)
}

/// Renders the spec into a Tauri menu.
pub fn build<R: Runtime>(
    app: &AppHandle<R>,
    os: Os,
    config: &MenuConfig,
    recent: &[RecentItem],
    disabled: &HashSet<String>,
) -> tauri::Result<Menu<R>> {
    build_rendered(app, &render_bar(&prepared_spec(app, os), config, recent), disabled)
}

fn build_rendered<R: Runtime>(
    app: &AppHandle<R>,
    menus: &[RenderedMenu],
    disabled: &HashSet<String>,
) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    for rendered in menus {
        let submenu = Submenu::with_id(app, format!("submenu:{}", rendered.id), &rendered.title, true)?;
        append_rendered(app, &submenu, &rendered.items, disabled)?;
        // The Window menu is registered after `set_menu`: doing it here cannot see the submenu
        // on NSApp, so AppKit never adds the open-window list.
        #[cfg(target_os = "macos")]
        if rendered.id == "help" {
            submenu.set_as_help_menu_for_nsapp()?;
        }
        menu.append(&submenu)?;
    }
    Ok(menu)
}

fn append_rendered<R: Runtime>(
    app: &AppHandle<R>,
    parent: &Submenu<R>,
    items: &[RenderedItem],
    disabled: &HashSet<String>,
) -> tauri::Result<()> {
    for item in items {
        match item {
            RenderedItem::Submenu { id, title, current, items } => {
                let child = Submenu::with_id_and_native_icon(
                    app,
                    format!("submenu:{id}"),
                    title,
                    true,
                    current.then_some(NativeIcon::MenuOnState),
                )?;
                append_rendered(app, &child, items, disabled)?;
                parent.append(&child)?;
            }
            RenderedItem::Action { id, text, accel, checked: None } => {
                let enabled = item_enabled(id, disabled);
                parent.append(&MenuItem::with_id(app, id, text, enabled, accel.as_deref())?)?;
            }
            RenderedItem::Action { id, text, accel, checked: Some(checked) } => {
                let enabled = item_enabled(id, disabled);
                parent.append(&CheckMenuItem::with_id(app, id, text, enabled, *checked, accel.as_deref())?)?;
            }
            RenderedItem::Placeholder { id, text } => {
                parent.append(&MenuItem::with_id(app, id, text, false, None::<&str>)?)?;
            }
            RenderedItem::Native { kind, text } => parent.append(native_text(app, *kind, text)?.as_ref())?,
            RenderedItem::Separator => parent.append(&PredefinedMenuItem::separator(app)?)?,
        }
    }
    Ok(())
}

fn native_text<R: Runtime>(app: &AppHandle<R>, n: Native, text: &str) -> tauri::Result<Box<dyn IsMenuItem<R>>> {
    let t = Some(text);
    let item = match n {
        Native::Undo => PredefinedMenuItem::undo(app, t)?,
        Native::Redo => PredefinedMenuItem::redo(app, t)?,
        Native::Cut => PredefinedMenuItem::cut(app, t)?,
        Native::Copy => PredefinedMenuItem::copy(app, t)?,
        Native::Paste => PredefinedMenuItem::paste(app, t)?,
        Native::SelectAll => PredefinedMenuItem::select_all(app, t)?,
        Native::Services => PredefinedMenuItem::services(app, t)?,
        Native::Hide => PredefinedMenuItem::hide(app, t)?,
        Native::HideOthers => PredefinedMenuItem::hide_others(app, t)?,
        Native::ShowAll => PredefinedMenuItem::show_all(app, t)?,
        Native::Minimize => PredefinedMenuItem::minimize(app, t)?,
        Native::Zoom => PredefinedMenuItem::maximize(app, t)?,
        Native::BringAllToFront => PredefinedMenuItem::bring_all_to_front(app, t)?,
    };
    Ok(Box::new(item))
}

fn clear_submenu<R: Runtime>(submenu: &Submenu<R>) -> tauri::Result<()> {
    let len = submenu.items()?.len();
    for index in (0..len).rev() {
        submenu.remove_at(index)?;
    }
    Ok(())
}

fn existing_matches<R: Runtime>(existing: &MenuItemKind<R>, desired: &RenderedItem) -> bool {
    match (existing, desired) {
        (MenuItemKind::Submenu(submenu), RenderedItem::Submenu { id, .. }) => {
            submenu.id().as_ref() == format!("submenu:{id}").as_str()
        }
        (
            MenuItemKind::MenuItem(item),
            RenderedItem::Action { id, checked: None, .. } | RenderedItem::Placeholder { id, .. },
        ) => item.id().as_ref() == id.as_str(),
        (MenuItemKind::Check(item), RenderedItem::Action { id, checked: Some(_), .. }) => {
            item.id().as_ref() == id.as_str()
        }
        (MenuItemKind::Predefined(_), RenderedItem::Native { .. } | RenderedItem::Separator) => true,
        _ => false,
    }
}

/// Updates `submenu` to `next` without replacing the menu bar.
///
/// `allow_rebuild` is false for the macOS Window menu: AppKit appends the open-window
/// list to it, and clearing that menu drops the list. A structural change there falls
/// back to installing a new menu bar.
fn sync_children<R: Runtime>(
    app: &AppHandle<R>,
    submenu: &Submenu<R>,
    previous: &[RenderedItem],
    next: &[RenderedItem],
    disabled: &HashSet<String>,
    allow_rebuild: bool,
) -> bool {
    if !same_structure(previous, next) {
        return allow_rebuild
            && clear_submenu(submenu).is_ok()
            && append_rendered(app, submenu, next, disabled).is_ok();
    }
    let Ok(existing) = submenu.items() else { return false };
    let extras = !allow_rebuild && existing.len() > next.len();
    if existing.len() != next.len() && !extras {
        return allow_rebuild
            && clear_submenu(submenu).is_ok()
            && append_rendered(app, submenu, next, disabled).is_ok();
    }
    if existing.len() < next.len() {
        return false;
    }
    for (index, item) in next.iter().enumerate() {
        if &previous[index] == item {
            continue;
        }
        if !existing_matches(&existing[index], item)
            || !sync_item(app, &existing[index], &previous[index], item, disabled)
        {
            return false;
        }
    }
    true
}

fn sync_item<R: Runtime>(
    app: &AppHandle<R>,
    existing: &MenuItemKind<R>,
    previous: &RenderedItem,
    next: &RenderedItem,
    disabled: &HashSet<String>,
) -> bool {
    match (existing, previous, next) {
        (
            MenuItemKind::Submenu(submenu),
            RenderedItem::Submenu { title: previous_title, current: previous_current, items: previous_items, .. },
            RenderedItem::Submenu { title, current, items, .. },
        ) => {
            if previous_title != title && submenu.set_text(title).is_err() {
                return false;
            }
            if previous_current != current
                && submenu.set_native_icon(current.then_some(NativeIcon::MenuOnState)).is_err()
            {
                return false;
            }
            sync_children(app, submenu, previous_items, items, disabled, true)
        }
        (
            MenuItemKind::MenuItem(item),
            RenderedItem::Action { text: previous_text, accel: previous_accel, .. },
            RenderedItem::Action { text, accel, .. },
        ) => {
            accelerator_patchable(previous_accel.as_deref(), accel.as_deref())
                && (previous_text == text || item.set_text(text).is_ok())
                && (previous_accel == accel || item.set_accelerator(accel.as_deref()).is_ok())
        }
        (
            MenuItemKind::Check(item),
            RenderedItem::Action { text: previous_text, accel: previous_accel, checked: previous_checked, .. },
            RenderedItem::Action { text, accel, checked: Some(checked), .. },
        ) => {
            accelerator_patchable(previous_accel.as_deref(), accel.as_deref())
                && (previous_text == text || item.set_text(text).is_ok())
                && (previous_accel == accel || item.set_accelerator(accel.as_deref()).is_ok())
                && (*previous_checked == Some(*checked) || item.set_checked(*checked).is_ok())
        }
        (MenuItemKind::MenuItem(item), _, RenderedItem::Placeholder { text, .. }) => item.set_text(text).is_ok(),
        (MenuItemKind::Predefined(item), _, RenderedItem::Native { text, .. }) => item.set_text(text).is_ok(),
        _ => false,
    }
}

/// Whether an item's accelerator can change in place. On macOS muda's `set_accelerator(None)`
/// keeps the old key equivalent, so an item that loses its accelerator is built again.
fn accelerator_patchable(previous: Option<&str>, next: Option<&str>) -> bool {
    previous == next || next.is_some()
}

fn patch_menu<R: Runtime>(
    app: &AppHandle<R>,
    menu: &Menu<R>,
    previous: &[RenderedMenu],
    next: &[RenderedMenu],
    disabled: &HashSet<String>,
) -> bool {
    let Ok(items) = menu.items() else { return false };
    if items.len() != next.len() {
        return false;
    }
    for (index, rendered) in next.iter().enumerate() {
        if &previous[index] == rendered {
            continue;
        }
        let Some(submenu) = items[index].as_submenu() else { return false };
        if submenu.id().as_ref() != format!("submenu:{}", rendered.id).as_str() {
            return false;
        }
        if previous[index].title != rendered.title && submenu.set_text(&rendered.title).is_err() {
            return false;
        }
        if !sync_children(app, submenu, &previous[index].items, &rendered.items, disabled, rendered.id != "window") {
            return false;
        }
    }
    true
}

/// Whether the OS menu bar is used. Windows and Linux project windows are
/// frameless and draw IDEA's hamburger menu in their own title bar instead.
pub fn native_menu_bar() -> bool {
    cfg!(target_os = "macos")
}

/// The check state item `id` was last drawn with; `None` for a plain item.
fn rendered_check(menus: &[RenderedMenu], id: &str) -> Option<bool> {
    fn find(items: &[RenderedItem], id: &str) -> Option<bool> {
        items.iter().find_map(|item| match item {
            RenderedItem::Submenu { items, .. } => find(items, id),
            RenderedItem::Action { id: item_id, checked, .. } if item_id == id => *checked,
            _ => None,
        })
    }
    menus.iter().find_map(|menu| find(&menu.items, id))
}

/// Puts a clicked check item back to the state it was drawn with. muda flips it before the
/// event arrives, but the frontend owns the state: a click it ignores (a modal Settings
/// window, a failed save) must not leave a stale mark, and one it accepts comes back as a new
/// config that sets the mark through [`sync_item`].
pub fn restore_check<R: Runtime>(app: &AppHandle<R>, menu_state: &MenuState, id: &str) {
    fn walk<R: Runtime>(items: Vec<MenuItemKind<R>>, id: &str, checked: bool) -> bool {
        items.into_iter().any(|item| match item {
            MenuItemKind::Check(i) if i.id().as_ref() == id => {
                if i.is_checked().is_ok_and(|c| c != checked) {
                    let _ = i.set_checked(checked);
                }
                true
            }
            MenuItemKind::Submenu(s) => s.items().is_ok_and(|children| walk(children, id, checked)),
            _ => false,
        })
    }
    let Some(checked) = menu_state.rendered.lock().as_deref().and_then(|menus| rendered_check(menus, id)) else {
        return;
    };
    if let Some(menu) = app.menu()
        && let Ok(items) = menu.items()
    {
        walk(items, id, checked);
    }
}

/// Installs the app menu from the current config and recent list.
///
/// The first install, and a change of the top-level menu ids, calls `set_menu`.
/// On macOS that removes the menu bar and draws it again. Later updates compare the
/// visible items and edit only the submenus that changed, so switching project tabs
/// does not flash the menu bar.
pub fn install<R: Runtime>(app: &AppHandle<R>, menu_state: &MenuState, recent: &[ide_workspace::RecentProject]) {
    if !native_menu_bar() {
        return;
    }
    let home = dirs::home_dir();
    let items = recent_items(recent, &menu_state.remote_recent.lock(), home.as_deref());
    let config = menu_state.config.lock().clone();
    let disabled = menu_state.disabled.lock().clone();
    let rendered = render_bar(&prepared_spec(app, Os::current()), &config, &items);
    let mut slot = menu_state.rendered.lock();
    if slot.as_ref() == Some(&rendered) {
        return;
    }
    let patched = match slot.as_ref() {
        Some(previous) if same_toplevel(previous, &rendered) => {
            app.menu().is_some_and(|menu| patch_menu(app, &menu, previous, &rendered, &disabled))
        }
        _ => false,
    };
    if patched {
        *slot = Some(rendered);
        return;
    }
    let installed = match build(app, Os::current(), &config, &items, &disabled).and_then(|menu| app.set_menu(menu)) {
        Ok(_) => {
            *slot = Some(rendered);
            true
        }
        Err(e) => {
            tracing::warn!("failed to build the app menu: {e}");
            false
        }
    };
    drop(slot);
    if installed {
        // After the menu bar is installed. Holding `rendered` across this would deadlock a menu
        // click on the main thread, which also takes that lock.
        #[cfg(target_os = "macos")]
        register_macos_windows_menu(app);
    }
}

/// Makes the Window submenu the macOS windows menu, so AppKit lists open windows under it.
///
/// Each item uses the window title (`project – file`, or the workspace name). muda can only
/// resolve the submenu once `set_menu` has attached it, and Tauri itself only does this for
/// the id `__tauri_window_menu__`.
#[cfg(target_os = "macos")]
fn register_macos_windows_menu<R: Runtime>(app: &AppHandle<R>) {
    let Some(menu) = app.menu() else { return };
    let Ok(items) = menu.items() else { return };
    for item in items {
        let Some(submenu) = item.as_submenu() else { continue };
        if submenu.id().as_ref() != "submenu:window" {
            continue;
        }
        if let Err(error) = submenu.set_as_windows_menu_for_nsapp() {
            tracing::warn!("failed to register the macOS Window menu: {error}");
        }
        return;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeSet, HashSet};
    use std::path::Path;

    const ALL_OS: [Os; 3] = [Os::Mac, Os::Windows, Os::Linux];

    fn ids_with_accel(entries: &[Entry], out: &mut Vec<(&'static str, &'static str)>) {
        for e in entries {
            match e {
                Entry::Submenu { children, .. } => ids_with_accel(children, out),
                Entry::Action { id, accel: Some(a), .. } => out.push((id, a)),
                _ => {}
            }
        }
    }

    fn natives(entries: &[Entry], out: &mut Vec<Native>) {
        for e in entries {
            match e {
                Entry::Submenu { children, .. } => natives(children, out),
                Entry::Native(n) => out.push(*n),
                _ => {}
            }
        }
    }

    /// Tauri accelerator → keymap binding syntax (`CmdOrCtrl+Shift+Q` → `Meta+Shift+Q`).
    fn to_binding(accel: &str, os: Os) -> String {
        accel
            .split('+')
            .map(|p| match p {
                "CmdOrCtrl" if os == Os::Mac => "Meta",
                "CmdOrCtrl" | "Ctrl" => "Ctrl",
                "Cmd" => "Meta",
                other => other,
            })
            .collect::<Vec<_>>()
            .join("+")
    }

    fn keymap_bindings() -> HashSet<String> {
        let src = include_str!("../../src/platform/keymaps/intellij-macos.ts");
        let mut out = HashSet::new();
        for line in src.lines() {
            let Some((_, rest)) = line.split_once(": [") else { continue };
            for b in rest.split(',') {
                let b = b.trim().trim_end_matches("],").trim_end_matches(']').trim().trim_matches('"');
                if !b.is_empty() {
                    out.insert(b.to_owned());
                }
            }
        }
        out
    }

    #[test]
    fn every_action_item_routes_to_its_action_id() {
        for os in ALL_OS {
            let spec = spec(os);
            for id in action_ids(&spec) {
                assert_eq!(route(&spec, id), Some(MenuRoute { action: id.into(), arg: None }), "{id} on {os:?}");
            }
        }
    }

    #[test]
    fn soft_wrap_is_available_under_view_active_editor_on_every_os() {
        for os in ALL_OS {
            let menus = spec(os);
            let Entry::Submenu { children: view, .. } =
                menus.iter().find(|e| matches!(e, Entry::Submenu { id: "view", .. })).unwrap()
            else {
                panic!("View menu missing")
            };
            let Entry::Submenu { children: active, .. } =
                view.iter().find(|e| matches!(e, Entry::Submenu { id: "activeEditor", .. })).unwrap()
            else {
                panic!("Active Editor menu missing")
            };
            assert!(action_ids(active).contains(&"editor.toggleSoftWrap"), "{os:?}");
        }
    }

    #[test]
    fn unchanged_menu_config_is_not_rebuilt() {
        let state = MenuState::default();
        let mut config = MenuConfig { locale: "en".into(), ..MenuConfig::default() };
        assert!(store_config(&state, config.clone()));
        assert!(!store_config(&state, config.clone()));
        config.labels.insert("menu.file".into(), "File".into());
        assert!(store_config(&state, config));
    }

    fn changed_menus(left: &[RenderedMenu], right: &[RenderedMenu]) -> Vec<&'static str> {
        assert_eq!(
            left.iter().map(|menu| menu.id).collect::<Vec<_>>(),
            right.iter().map(|menu| menu.id).collect::<Vec<_>>()
        );
        left.iter().zip(right).filter(|(a, b)| a != b).map(|(menu, _)| menu.id).collect()
    }

    #[test]
    fn unused_shortcuts_do_not_change_the_rendered_menu() {
        let entries = spec(Os::Mac);
        let base = MenuConfig::default();
        let mut extra = base.clone();
        // Registered by a large project's language actions, but not a menu item.
        extra.accelerators.insert("java.compile".into(), "Meta+K".into());
        // The spec's accelerator wins over the keymap's.
        extra.accelerators.insert("window.next".into(), "Meta+Alt+N".into());
        assert_eq!(render_bar(&entries, &base, &[]), render_bar(&entries, &extra, &[]));
    }

    #[test]
    fn tool_windows_change_only_the_view_menu() {
        let entries = spec(Os::Mac);
        let base = MenuConfig::default();
        let mut with_maven = base.clone();
        with_maven.accelerators.insert("toolwindow.maven".into(), "Meta+9".into());
        assert_eq!(render_bar(&entries, &base, &[]), render_bar(&entries, &with_maven, &[]));
        with_maven.dynamic.insert(DYNAMIC_TOOL_WINDOWS.into(), vec![dynamic_item("toolwindow.maven", None, "Maven")]);
        assert_eq!(changed_menus(&render_bar(&entries, &base, &[]), &render_bar(&entries, &with_maven, &[])), ["view"]);
    }

    #[test]
    fn recent_projects_change_only_the_file_menu() {
        let entries = spec(Os::Mac);
        let config = MenuConfig::default();
        let recent = [RecentItem { path: "/p/a".into(), label: "a  —  ~/a".into() }];
        assert_eq!(
            changed_menus(&render_bar(&entries, &config, &[]), &render_bar(&entries, &config, &recent)),
            ["file"]
        );
    }

    #[test]
    fn visible_label_or_shortcut_changes_only_its_menu() {
        let entries = spec(Os::Mac);
        let base = MenuConfig::default();
        let mut accelerators = base.clone();
        accelerators.accelerators.insert("file.save".into(), "Meta+S".into());
        assert_eq!(
            changed_menus(&render_bar(&entries, &base, &[]), &render_bar(&entries, &accelerators, &[])),
            ["file"]
        );

        let mut labels = base.clone();
        labels.labels.insert("menu.view".into(), "视图".into());
        let rendered = render_bar(&entries, &labels, &[]);
        assert_eq!(changed_menus(&render_bar(&entries, &base, &[]), &rendered), ["view"]);
        assert_eq!(rendered.iter().find(|menu| menu.id == "view").unwrap().title, "视图");
    }

    #[test]
    fn recent_items_route_to_open_recent_with_path() {
        let spec = spec(Os::Mac);
        assert_eq!(
            route(&spec, "recent:/Users/me/My Project"),
            Some(MenuRoute { action: OPEN_RECENT_ACTION.into(), arg: Some("/Users/me/My Project".into()) })
        );
    }

    #[test]
    fn non_action_ids_do_not_route() {
        let spec = spec(Os::Mac);
        assert_eq!(route(&spec, "submenu:file"), None);
        assert_eq!(route(&spec, "recent.none"), None);
        assert_eq!(route(&spec, "nonexistent.action"), None);
    }

    #[test]
    fn standard_menus_exist_in_order() {
        let top = |os| {
            spec(os)
                .into_iter()
                .filter_map(|e| match e {
                    Entry::Submenu { id, .. } => Some(id),
                    _ => None,
                })
                .collect::<Vec<_>>()
        };
        let common =
            ["file", "edit", "view", "navigate", "code", "refactor", "build", "run", "git", "tools", "window", "help"];
        assert_eq!(top(Os::Mac), [&["app"][..], &common[..]].concat());
        assert_eq!(top(Os::Windows), common.to_vec());
    }

    #[test]
    fn required_items_are_present() {
        for os in ALL_OS {
            let ids = action_ids(&spec(os));
            for required in [
                "app.about",
                "app.quit",
                "file.openProject",
                "file.openFile",
                "file.openInNewWindow",
                "file.closeProject",
                "file.save",
                "file.projectStructure",
                "file.settings",
                "file.newProjectsSettings",
                "window.new",
                "window.next",
                "window.previous",
                "window.toggleFullScreen",
                "view.toggleTheme",
                "editor.toggleZen",
                "view.toggleToolbar",
                "view.toggleToolWindowBars",
                "view.toggleStatusBar",
                "help.keymapReference",
                "help.showLog",
                "find.inFile",
            ] {
                assert!(ids.contains(&required), "{required} missing on {os:?}");
            }
        }
    }

    #[test]
    fn edit_roles_are_native_only_on_macos() {
        let mut mac = Vec::new();
        natives(&spec(Os::Mac), &mut mac);
        assert!(mac.contains(&Native::Copy) && mac.contains(&Native::Undo));
        for os in [Os::Windows, Os::Linux] {
            let mut n = Vec::new();
            natives(&spec(os), &mut n);
            assert!(n.is_empty(), "{os:?} must not use native roles: {n:?}");
            assert!(action_ids(&spec(os)).contains(&"edit.copy"));
        }
    }

    /// Native accelerators bypass the JS dispatcher, so they must never claim a
    /// key the keymap binds. The macOS clipboard roles are the one exception
    /// (text inputs need them); the project view's ⌘C/⌘X/⌘V overlap there.
    #[test]
    fn native_accelerators_do_not_shadow_the_keymap() {
        let keymap = keymap_bindings();
        assert!(keymap.contains("Meta+Shift+O"), "keymap parse failed");
        for os in ALL_OS {
            let mut accels = Vec::new();
            ids_with_accel(&spec(os), &mut accels);
            for (id, a) in accels {
                assert!(!keymap.contains(&to_binding(a, os)), "{id} accelerator {a} shadows the keymap on {os:?}");
            }
        }
        let mut n = Vec::new();
        natives(&spec(Os::Mac), &mut n);
        let allowed = ["Meta+C", "Meta+X", "Meta+V"];
        for native in n {
            if let Some(b) = native.implicit_accelerator() {
                assert!(!keymap.contains(b) || allowed.contains(&b), "{native:?} ({b}) shadows the keymap");
            }
        }
    }

    #[test]
    fn labels_come_from_config() {
        let mut config = MenuConfig::default();
        assert_eq!(config.item_text("file.save", "Save All", None), "Save All");
        assert_eq!(config.item_text("edit.copy", "Copy", Some("Ctrl+C")), "Copy\tCtrl+C");
        config.labels.insert("menu.file.save".into(), "全部保存".into());
        assert_eq!(config.item_text("file.save", "Save All", None), "全部保存");
        assert_eq!(config.label("file", "File"), "File");
    }

    fn rendered_action<'a>(items: &'a [RenderedItem], id: &str) -> Option<&'a RenderedItem> {
        items.iter().find_map(|item| match item {
            RenderedItem::Submenu { items, .. } => rendered_action(items, id),
            RenderedItem::Action { id: item_id, .. } if item_id == id => Some(item),
            _ => None,
        })
    }

    /// The macOS menu draws a key equivalent in its own column; text after a tab is drawn
    /// right after the label instead.
    #[test]
    fn keymap_shortcuts_are_native_accelerators_not_label_text() {
        let mut config = MenuConfig::default();
        config.accelerators.insert("file.save".into(), "Meta+S".into());
        config.accelerators.insert("app.quit".into(), "Meta+Alt+Q".into());
        let bar = render_bar(&spec(Os::Mac), &config, &[]);
        let items: Vec<RenderedItem> = bar.into_iter().flat_map(|menu| menu.items).collect();
        let item = |id| rendered_action(&items, id).cloned();
        assert_eq!(
            item("file.save"),
            Some(RenderedItem::Action {
                id: "file.save".into(),
                text: "Save All".into(),
                accel: Some("Meta+S".into()),
                checked: None,
            })
        );
        assert!(matches!(item("app.quit"), Some(RenderedItem::Action { accel: Some(a), .. }) if a == "CmdOrCtrl+Q"));
        assert!(
            matches!(item("navigate.searchEverywhere"), Some(RenderedItem::Action { accel: None, text, .. }) if !text.contains('\t'))
        );
    }

    #[test]
    fn an_item_that_loses_its_accelerator_is_built_again() {
        assert!(!accelerator_patchable(Some("Meta+L"), None));
        assert!(accelerator_patchable(Some("Meta+L"), Some("Ctrl+Alt+G")));
        assert!(accelerator_patchable(None, Some("Meta+L")));
        assert!(accelerator_patchable(None, None));
    }

    #[test]
    fn only_spec_accelerators_fire_natively() {
        let spec = spec(Os::Mac);
        assert!(fires_natively(&spec, "app.quit"));
        assert!(fires_natively(&spec, "window.next"));
        assert!(!fires_natively(&spec, "file.save"));
        assert!(!fires_natively(&spec, "dyn:toolwindow.project"));
    }

    #[test]
    fn without_action_drops_item_and_dangling_separators() {
        for os in ALL_OS {
            let spec = without_action(spec(os), "app.checkForUpdates");
            assert!(!action_ids(&spec).contains(&"app.checkForUpdates"));
            assert!(action_ids(&spec).contains(&"app.about"));
            fn check(entries: &[Entry]) {
                assert!(!matches!(entries.first(), Some(Entry::Separator)));
                assert!(!matches!(entries.last(), Some(Entry::Separator)));
                assert!(!entries.windows(2).any(|w| matches!(w, [Entry::Separator, Entry::Separator])));
                for e in entries {
                    if let Entry::Submenu { children, .. } = e {
                        check(children);
                    }
                }
            }
            check(&spec);
        }
    }

    #[test]
    fn action_ids_are_unique_per_menu_bar() {
        for os in ALL_OS {
            let mut seen = HashSet::new();
            for id in action_ids(&spec(os)) {
                assert!(seen.insert(id), "{id} appears twice on {os:?}");
            }
        }
    }

    #[test]
    fn submenu_ids_are_unique() {
        fn walk(entries: &[Entry], seen: &mut HashSet<&'static str>) {
            for e in entries {
                if let Entry::Submenu { id, children, .. } = e {
                    assert!(seen.insert(id), "duplicate submenu {id}");
                    walk(children, seen);
                }
            }
        }
        for os in ALL_OS {
            walk(&spec(os), &mut HashSet::new());
        }
    }

    #[test]
    fn file_menu_starts_with_a_new_submenu() {
        for os in ALL_OS {
            let menus = spec(os);
            let Some(Entry::Submenu { children: file, .. }) =
                menus.iter().find(|e| matches!(e, Entry::Submenu { id: "file", .. }))
            else {
                panic!("File menu missing on {os:?}")
            };
            let Some(Entry::Submenu { id: "new", children: new, .. }) = file.first() else {
                panic!("File menu does not start with New on {os:?}")
            };
            assert_eq!(
                action_ids(new),
                [
                    "file.newProject",
                    "workspace.create",
                    "vcs.cloneProject",
                    "file.new",
                    "file.newScratchFile",
                    "file.newUntitled"
                ],
                "{os:?}"
            );
        }
    }

    #[test]
    fn every_menu_item_has_a_catalog_label() {
        fn walk(entries: &[Entry], out: &mut BTreeSet<&'static str>) {
            for e in entries {
                match e {
                    Entry::Submenu { id, children, .. } => {
                        out.insert(id);
                        walk(children, out);
                    }
                    Entry::Action { id, .. } => {
                        out.insert(id);
                    }
                    _ => {}
                }
            }
        }
        let mut ids = BTreeSet::new();
        for os in ALL_OS {
            walk(&spec(os), &mut ids);
        }
        for (locale, catalog) in [
            ("en", include_str!("../../src/platform/locales/en.json")),
            ("zh", include_str!("../../src/platform/locales/zh.json")),
        ] {
            let catalog: serde_json::Map<String, serde_json::Value> = serde_json::from_str(catalog).unwrap();
            let missing: Vec<_> = ids.iter().filter(|id| !catalog.contains_key(&format!("menu.{id}"))).collect();
            assert!(missing.is_empty(), "{locale}.json lacks menu labels for {missing:?}");
        }
    }

    #[test]
    fn recent_labels_tildify_home() {
        let recent = vec![ide_workspace::RecentProject {
            path: "/home/me/code/openidea".into(),
            name: "openidea".into(),
            opened_at_ms: 0.0,
            branch: None,
            missing: false,
        }];
        let items = recent_items(&recent, &[], Some(Path::new("/home/me")));
        assert_eq!(items[0].label, "openidea  —  ~/code/openidea");
        assert_eq!(items[0].path, "/home/me/code/openidea");
    }

    #[test]
    fn remote_projects_join_the_recent_list_by_when_they_were_opened() {
        let local = |path: &str, at: f64| ide_workspace::RecentProject {
            path: path.into(),
            name: path.rsplit('/').next().unwrap().into(),
            opened_at_ms: at,
            branch: None,
            missing: false,
        };
        let recent = vec![local("/home/me/new", 30.0), local("/home/me/old", 10.0)];
        let remote = [RemoteRecent {
            location: "wsl://Ubuntu/home/me/api".into(),
            name: "api".into(),
            detail: "Ubuntu:/home/me/api".into(),
            opened_at_ms: 20.0,
        }];
        let items = recent_items(&recent, &remote, Some(Path::new("/home/me")));
        let paths: Vec<&str> = items.iter().map(|i| i.path.as_str()).collect();
        assert_eq!(paths, ["/home/me/new", "wsl://Ubuntu/home/me/api", "/home/me/old"]);
        assert_eq!(items[1].label, "api  —  Ubuntu:/home/me/api");

        let many: Vec<_> = (0..20).map(|i| local(&format!("/p/{i}"), f64::from(i))).collect();
        let items = recent_items(&many, &remote, None);
        assert_eq!(items.len(), MAX_RECENT);
        assert_eq!([items[0].path.as_str(), items[1].path.as_str()], ["wsl://Ubuntu/home/me/api", "/p/19"]);
        assert_eq!(items[MAX_RECENT - 1].path, format!("/p/{}", 20 - MAX_RECENT + 1), "the remote one takes a slot");
    }

    #[test]
    fn model_drops_native_roles_and_fills_recent() {
        let spec = vec![sub(
            "file",
            "File",
            vec![Entry::Native(Native::Undo), act("file.save", "Save All"), SEP, Entry::RecentProjects],
        )];
        let recent = [RecentItem { path: "/p/a".into(), label: "a  —  ~/a".into() }];
        let MenuNode::Submenu { children, .. } = &model(&spec, &recent, &MenuConfig::default())[0] else {
            panic!("not a submenu")
        };
        assert_eq!(children.len(), 3);
        assert!(matches!(&children[0], MenuNode::Action { id, arg: None, .. } if id == "file.save"));
        assert!(
            matches!(&children[2], MenuNode::Action { id, arg: Some(p), .. } if id == OPEN_RECENT_ACTION && p == "/p/a")
        );

        let MenuNode::Submenu { children, .. } = &model(&spec, &[], &MenuConfig::default())[0] else {
            panic!("not a submenu")
        };
        assert!(matches!(&children[2], MenuNode::Placeholder { id, .. } if id == "recent.none"));
    }

    fn dynamic_item(action: &str, arg: Option<&str>, label: &str) -> DynamicItem {
        DynamicItem { action: action.into(), arg: arg.map(Into::into), label: label.into(), checked: None }
    }

    #[test]
    fn appearance_toggles_are_checks_that_change_only_the_view_menu() {
        let entries = spec(Os::Mac);
        let base = MenuConfig::default();
        let checked = |config: &MenuConfig, id: &str| {
            let items: Vec<RenderedItem> =
                render_bar(&entries, config, &[]).into_iter().flat_map(|menu| menu.items).collect();
            match rendered_action(&items, id) {
                Some(RenderedItem::Action { checked, .. }) => *checked,
                other => panic!("{id}: {other:?}"),
            }
        };
        for id in ["view.toggleCompactMode", "view.toggleToolbar", "view.toggleToolWindowBars", "view.toggleStatusBar"]
        {
            assert_eq!(checked(&base, id), Some(false), "{id}");
        }
        assert_eq!(checked(&base, "view.zoomIn"), None);

        let mut on = base.clone();
        on.checked = vec!["view.toggleToolbar".into(), "view.zoomIn".into()];
        assert_eq!(checked(&on, "view.toggleToolbar"), Some(true));
        assert_eq!(checked(&on, "view.toggleStatusBar"), Some(false));
        assert_eq!(checked(&on, "view.zoomIn"), None, "plain items stay plain");
        assert_eq!(changed_menus(&render_bar(&entries, &base, &[]), &render_bar(&entries, &on, &[])), ["view"]);
    }

    #[test]
    fn a_clicked_check_returns_to_its_rendered_state() {
        let mut config = MenuConfig { checked: vec!["view.toggleToolbar".into()], ..MenuConfig::default() };
        config.dynamic.insert(
            DYNAMIC_STATUS_BAR_WIDGETS.into(),
            vec![DynamicItem {
                action: "view.toggleStatusBarWidget".into(),
                arg: Some("perf.memory".into()),
                label: "Memory Indicator".into(),
                checked: Some(false),
            }],
        );
        let menus = render_bar(&spec(Os::Mac), &config, &[]);
        assert_eq!(rendered_check(&menus, "view.toggleToolbar"), Some(true));
        assert_eq!(rendered_check(&menus, "view.toggleStatusBar"), Some(false));
        let widget = config.dynamic[DYNAMIC_STATUS_BAR_WIDGETS][0].item_id();
        assert_eq!(rendered_check(&menus, &widget), Some(false));
        assert_eq!(rendered_check(&menus, "view.zoomIn"), None, "plain items have no state");
        assert_eq!(rendered_check(&menus, "missing"), None);
    }

    #[test]
    fn status_bar_widgets_are_listed_with_their_state() {
        let mut config = MenuConfig::default();
        config.dynamic.insert(
            DYNAMIC_STATUS_BAR_WIDGETS.into(),
            vec![DynamicItem {
                action: "view.toggleStatusBarWidget".into(),
                arg: Some("perf.memory".into()),
                label: "Memory Indicator".into(),
                checked: Some(true),
            }],
        );
        let id = config.dynamic[DYNAMIC_STATUS_BAR_WIDGETS][0].item_id();
        let items: Vec<RenderedItem> =
            render_bar(&spec(Os::Mac), &config, &[]).into_iter().flat_map(|menu| menu.items).collect();
        assert!(matches!(rendered_action(&items, &id), Some(RenderedItem::Action { checked: Some(true), .. })));
        assert_eq!(
            route(&spec(Os::Mac), &id),
            Some(MenuRoute { action: "view.toggleStatusBarWidget".into(), arg: Some("perf.memory".into()) })
        );

        let spec =
            vec![sub("statusBarWidgets", "Status Bar Widgets", vec![Entry::Dynamic(DYNAMIC_STATUS_BAR_WIDGETS)])];
        let MenuNode::Submenu { children, .. } = &model(&spec, &[], &config)[0] else { panic!("not a submenu") };
        assert!(
            matches!(&children[0], MenuNode::Action { checked: Some(true), arg: Some(a), .. } if a == "perf.memory")
        );
    }

    #[test]
    fn dynamic_items_route_with_their_argument() {
        let spec = spec(Os::Mac);
        let plain = dynamic_item("toolwindow.project", None, "Project");
        let named = dynamic_item("layout.restore", Some("Review | wide"), "Review | wide");
        assert_eq!(route(&spec, &plain.item_id()), Some(MenuRoute { action: "toolwindow.project".into(), arg: None }));
        assert_eq!(
            route(&spec, &named.item_id()),
            Some(MenuRoute { action: "layout.restore".into(), arg: Some("Review | wide".into()) })
        );
        assert_eq!(route(&spec, "dyn:"), None);
    }

    #[test]
    fn saved_layout_submenus_group_commands_by_selection() {
        let mut config = MenuConfig::default();
        let mut review = dynamic_item("layout.restore", Some("Review | wide"), "Review | wide");
        review.checked = Some(true);
        config
            .dynamic
            .insert(DYNAMIC_LAYOUTS.into(), vec![dynamic_item("layout.restore", Some("Focus"), "Focus"), review]);
        config.labels.insert("menu.layout.applyNamed".into(), "Apply layout".into());
        let layout_spec = [act("layout.restoreDefault", "Restore Default Layout"), Entry::Dynamic(DYNAMIC_LAYOUTS)];
        let nodes = model(&layout_spec, &[], &config);
        assert!(matches!(&nodes[0], MenuNode::Action { id, .. } if id == "layout.restoreDefault"));
        assert!(matches!(&nodes[1], MenuNode::Separator));
        let MenuNode::Submenu { label, current: Some(false), children, .. } = &nodes[2] else {
            panic!("expected an inactive named layout");
        };
        assert_eq!(label, "Focus");
        assert!(matches!(&children[0], MenuNode::Action { label, .. } if label == "Apply layout"));
        assert_eq!(children.len(), 4);
        let MenuNode::Submenu { label, current: Some(true), children, .. } = &nodes[3] else {
            panic!("expected an active named layout");
        };
        assert_eq!(label, "Review | wide");
        let ids: Vec<_> = children
            .iter()
            .filter_map(|node| match node {
                MenuNode::Action { id, arg: Some(name), .. } => {
                    assert_eq!(name, "Review | wide");
                    Some(id.as_str())
                }
                _ => None,
            })
            .collect();
        assert_eq!(ids, ["layout.restore", "layout.saveCurrent", "layout.rename", "layout.delete"]);

        let rendered = render_items(&layout_spec, &config, &[]);
        let RenderedItem::Submenu { current: true, items, .. } = &rendered[3] else {
            panic!("expected an active native named layout");
        };
        let RenderedItem::Action { id, .. } = &items[2] else { panic!("expected Rename") };
        assert_eq!(
            route(&layout_spec, id),
            Some(MenuRoute { action: "layout.rename".into(), arg: Some("Review | wide".into()) }),
        );
        assert_eq!(model(&layout_spec, &[], &MenuConfig::default()).len(), 1);
    }

    #[test]
    fn tool_windows_and_layouts_are_listed_by_the_frontend() {
        fn slots(entries: &[Entry], out: &mut Vec<&'static str>) {
            for e in entries {
                match e {
                    Entry::Submenu { children, .. } => slots(children, out),
                    Entry::Dynamic(slot) => out.push(slot),
                    _ => {}
                }
            }
        }
        for os in ALL_OS {
            let spec = spec(os);
            let mut found = Vec::new();
            slots(&spec, &mut found);
            assert_eq!(
                found,
                [
                    DYNAMIC_TOOL_WINDOWS,
                    DYNAMIC_STATUS_BAR_WIDGETS,
                    DYNAMIC_FLUTTER_BUILD,
                    DYNAMIC_PLUGIN_TOOLS,
                    DYNAMIC_LAYOUTS
                ],
                "{os:?}"
            );
            assert!(!action_ids(&spec).iter().any(|id| {
                id.starts_with("toolwindow.")
                    && *id != "toolwindow.hideAll"
                    && ![
                        "toolwindow.hideActive",
                        "toolwindow.hideSide",
                        "toolwindow.maximize",
                        "toolwindow.closeContent",
                        "toolwindow.jumpToLast",
                        "toolwindow.focusEditor",
                        "toolwindow.resizeLeft",
                        "toolwindow.resizeRight",
                        "toolwindow.resizeUp",
                        "toolwindow.resizeDown",
                    ]
                    .contains(id)
            }));
        }
        let mut config = MenuConfig::default();
        config.dynamic.insert(
            DYNAMIC_TOOL_WINDOWS.into(),
            vec![dynamic_item("toolwindow.project", None, "Project"), dynamic_item("toolwindow.git", None, "Git")],
        );
        config.accelerators.insert("toolwindow.project".into(), "Meta+1".into());
        assert_eq!(config.dynamic_accelerator(&config.dynamic[DYNAMIC_TOOL_WINDOWS][0]), Some("Meta+1"));
        assert_eq!(config.dynamic_accelerator(&dynamic_item("toolwindow.project", Some("x"), "X")), None);
        let spec = vec![sub("toolWindows", "Tool Windows", vec![Entry::Dynamic(DYNAMIC_TOOL_WINDOWS), SEP])];
        let MenuNode::Submenu { children, .. } = &model(&spec, &[], &config)[0] else { panic!("not a submenu") };
        assert!(
            matches!(&children[1], MenuNode::Action { id, arg: None, label, .. } if id == "toolwindow.git" && label == "Git")
        );
        let MenuNode::Submenu { children, .. } = &model(&spec, &[], &MenuConfig::default())[0] else { panic!() };
        assert_eq!(children, &[MenuNode::Separator]);
    }

    #[test]
    fn disabled_actions_disable_their_items_only() {
        let disabled: HashSet<String> = ["refactor.rename".to_owned(), "layout.restore".to_owned()].into();
        assert!(!item_enabled("refactor.rename", &disabled));
        assert!(item_enabled("refactor.inline", &disabled));
        assert!(!item_enabled("dyn:layout.restore|Review", &disabled));
        assert!(item_enabled("dyn:toolwindow.git", &disabled));
        assert!(item_enabled("recent:/p/refactor.rename", &disabled));
        assert!(item_enabled("submenu:refactor", &disabled));
        assert!(!item_enabled("recent.none", &disabled));
        assert!(!item_enabled("recent.none", &HashSet::new()));
    }

    #[test]
    fn git_menu_follows_idea_order() {
        let spec = spec(Os::Mac);
        let Some(Entry::Submenu { children, .. }) = spec.iter().find(|e| matches!(e, Entry::Submenu { id: "git", .. }))
        else {
            panic!("Git menu missing");
        };
        let top: Vec<&str> = children
            .iter()
            .map(|e| match e {
                Entry::Action { id, .. } | Entry::Submenu { id, .. } => *id,
                Entry::Separator => "|",
                _ => "?",
            })
            .collect();
        assert_eq!(
            top,
            [
                "vcs.commit",
                "vcs.push",
                "vcs.update",
                "vcs.pull",
                "vcs.fetch",
                "vcs.unshallow",
                "|",
                "vcs.merge",
                "vcs.merge.abort",
                "vcs.rebase",
                "vcs.rebase.abort",
                "vcs.rebase.continue",
                "vcs.rebase.skip",
                "vcs.resolveConflicts",
                "|",
                "vcs.branches",
                "vcs.newBranch",
                "vcs.newTag",
                "vcs.resetHead",
                "|",
                "vcs.newWorktree",
                "vcs.worktrees",
                "|",
                "vcs.showLog",
                "gitPatch",
                "gitUncommittedChanges",
                "gitCurrentFile",
                "|",
                "gitHub",
                "vcs.manageRemotes",
                "vcs.clone",
                "|",
                "vcs.operations",
                "|",
                "vcs.revert.continue",
                "vcs.revert.abort",
                "vcs.cherryPick.continue",
                "vcs.cherryPick.abort",
            ]
        );
        let ids = action_ids(children);
        for moved in ["vcs.showDiff", "vcs.rollback", "vcs.annotate", "vcs.localHistory", "localHistory.putLabel"] {
            assert!(ids.contains(&moved), "{moved} missing from the Git menu");
        }
    }

    #[test]
    fn idea_menu_items_are_present() {
        for os in ALL_OS {
            let ids = action_ids(&spec(os));
            for required in [
                "file.newProject",
                "file.renameProject",
                "file.reloadAllFromDisk",
                "file.exportSettings",
                "file.importSettings",
                "file.importJetBrainsSettings",
                "file.togglePowerSave",
                "macro.startRecording",
                "macro.stopRecording",
                "macro.playBack",
                "macro.playSaved",
                "macro.edit",
                "navigate.toggleBookmark",
                "navigate.showBookmarks",
                "code.quickDefinition",
                "code.quickTypeDefinition",
                "localHistory.recentChanges",
                "vim.toggle",
                "editor.resetFontSize",
                "diff.compareWithClipboard",
                "view.quickSwitchScheme",
                "code.cleanup",
                "runAnything.show",
                "layout.saveCurrent",
                "layout.restoreCurrent",
                "layout.save",
                "layout.restoreDefault",
                "toolwindow.hideActive",
                "editor.closeOtherTabs",
                "toolbar.customize",
                "build.compileFile",
            ] {
                assert!(ids.contains(&required), "{required} missing on {os:?}");
            }
        }
    }

    #[test]
    fn flutter_build_submenu_leads_build_only_when_filled() {
        let build_items = |config: &MenuConfig| {
            render_bar(&spec(Os::Mac), config, &[]).into_iter().find(|m| m.id == "build").expect("Build menu").items
        };
        let mut config = MenuConfig::default();
        assert!(matches!(&build_items(&config)[0], RenderedItem::Action { id, .. } if id == "build.buildProject"));

        config.labels.insert("menu.build.flutter".into(), "Flutter".into());
        config.dynamic.insert(
            DYNAMIC_FLUTTER_BUILD.into(),
            vec![
                dynamic_item("flutter.build.apk", None, "Build APK"),
                dynamic_item("flutter.build.web", None, "Build Web"),
            ],
        );
        let items = build_items(&config);
        let RenderedItem::Submenu { id, title, items: flutter, .. } = &items[0] else { panic!("no Flutter submenu") };
        assert_eq!((id.as_str(), title.as_str(), flutter.len()), ("build.flutter", "Flutter", 2));
        assert!(matches!(items[1], RenderedItem::Separator));
        let model = model(&spec(Os::Mac), &[], &config);
        let build = model.iter().find_map(|n| match n {
            MenuNode::Submenu { id, children, .. } if id == "build" => Some(children),
            _ => None,
        });
        assert!(
            matches!(&build.unwrap()[0], MenuNode::Submenu { id, children, .. } if id == "build.flutter" && children.len() == 2)
        );
    }

    #[test]
    fn build_menu_lists_recompile_and_patches_its_label() {
        for os in ALL_OS {
            let entries = spec(os);
            let Entry::Submenu { children, .. } =
                entries.iter().find(|e| matches!(e, Entry::Submenu { id: "build", .. })).unwrap()
            else {
                panic!("Build menu missing")
            };
            assert_eq!(
                action_ids(children),
                [
                    "build.buildProject",
                    "build.buildModule",
                    "build.compileFile",
                    "build.rebuildProject",
                    "build.buildArtifacts",
                ],
                "{os:?}"
            );
            assert!(!fires_natively(&entries, "build.compileFile"));
        }
        let entries = spec(Os::Mac);
        let mut base = MenuConfig::default();
        base.labels.insert("menu.build.compileFile".into(), "Recompile".into());
        let mut active = base.clone();
        active.labels.insert("menu.build.compileFile".into(), "Recompile 'Main.java'".into());
        assert_eq!(changed_menus(&render_bar(&entries, &base, &[]), &render_bar(&entries, &active, &[])), ["build"]);
    }
}
