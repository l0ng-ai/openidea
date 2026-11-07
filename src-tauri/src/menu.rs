//! Native application menu.
//!
//! The menu is described by a pure spec table ([`spec`]) and rendered with
//! Tauri's menu API ([`build`]). IDE items carry their *action id* as the menu
//! item id; clicking one emits [`MENU_EVENT`] to the focused window, whose
//! frontend runs `executeAction(id)`.
//!
//! # Accelerators
//! A native accelerator (macOS key equivalent, Win32 accelerator table, GTK
//! accel group) is handled by the OS *before* the webview sees the key, so it
//! would bypass the JS keymap (`when` clauses, chords, user overrides). IDE
//! items therefore never get a native accelerator: their shortcut is appended
//! to the label after a tab (`Save All\t⌘S`), which Win32 renders as the
//! accelerator column and macOS/GTK as trailing text. The shortcut text comes
//! from the frontend keymap ([`MenuConfig::shortcuts`]), so the JS keymap stays
//! the single source of truth. Native accelerators are only used for keys the
//! webview never handles: the macOS clipboard/undo roles (required for text
//! inputs), Hide, Minimize, Quit and window cycling.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use tauri::menu::{IsMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Runtime};

/// Event emitted to the focused window when an IDE menu item is clicked.
pub const MENU_EVENT: &str = "openidea://menu";
/// Prefix of Open Recent item ids; the rest of the id is the project path.
const RECENT_PREFIX: &str = "recent:";
/// Prefix of items the frontend lists ([`MenuConfig::dynamic`]): `dyn:<action>` or `dyn:<action>|<arg>`.
const DYNAMIC_PREFIX: &str = "dyn:";
/// Action run for an Open Recent entry (argument: the project path).
pub const OPEN_RECENT_ACTION: &str = "file.openRecentProject";
const MAX_RECENT: usize = 15;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Mac,
    Windows,
    Linux,
}

impl Os {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Os::Mac
        } else if cfg!(target_os = "windows") {
            Os::Windows
        } else {
            Os::Linux
        }
    }
}

/// Native (role) items, implemented by the OS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Native {
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Minimize,
    Zoom,
    BringAllToFront,
}

impl Native {
    fn key(self) -> &'static str {
        match self {
            Native::Undo => "native.undo",
            Native::Redo => "native.redo",
            Native::Cut => "native.cut",
            Native::Copy => "native.copy",
            Native::Paste => "native.paste",
            Native::SelectAll => "native.selectAll",
            Native::Services => "native.services",
            Native::Hide => "native.hide",
            Native::HideOthers => "native.hideOthers",
            Native::ShowAll => "native.showAll",
            Native::Minimize => "native.minimize",
            Native::Zoom => "native.zoom",
            Native::BringAllToFront => "native.bringAllToFront",
        }
    }

    fn default_label(self) -> &'static str {
        match self {
            Native::Undo => "Undo",
            Native::Redo => "Redo",
            Native::Cut => "Cut",
            Native::Copy => "Copy",
            Native::Paste => "Paste",
            Native::SelectAll => "Select All",
            Native::Services => "Services",
            Native::Hide => "Hide OpenIDEA",
            Native::HideOthers => "Hide Others",
            Native::ShowAll => "Show All",
            Native::Minimize => "Minimize",
            Native::Zoom => "Zoom",
            Native::BringAllToFront => "Bring All to Front",
        }
    }

    /// Accelerator the OS attaches implicitly (macOS), in keymap syntax.
    #[cfg(test)]
    fn implicit_accelerator(self) -> Option<&'static str> {
        match self {
            Native::Undo => Some("Meta+Z"),
            Native::Redo => Some("Meta+Shift+Z"),
            Native::Cut => Some("Meta+X"),
            Native::Copy => Some("Meta+C"),
            Native::Paste => Some("Meta+V"),
            Native::SelectAll => Some("Meta+A"),
            Native::Hide => Some("Meta+H"),
            Native::HideOthers => Some("Meta+Alt+H"),
            Native::Minimize => Some("Meta+M"),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entry {
    Submenu {
        id: &'static str,
        label: &'static str,
        children: Vec<Entry>,
    },
    /// An IDE action; `id` is the action id.
    Action {
        id: &'static str,
        label: &'static str,
        /// Native accelerator (Tauri syntax). Only for keys the webview never handles.
        accel: Option<&'static str>,
        /// Shortcut text shown when the frontend keymap has none for this id.
        hint: Option<&'static str>,
    },
    Native(Native),
    Separator,
    /// Open Recent entries, filled from the recent-projects list.
    RecentProjects,
    /// Items the frontend lists under this slot name (registered tool windows,
    /// saved layouts), from [`MenuConfig::dynamic`].
    Dynamic(&'static str),
}

fn sub(id: &'static str, label: &'static str, children: Vec<Entry>) -> Entry {
    Entry::Submenu { id, label, children }
}
fn act(id: &'static str, label: &'static str) -> Entry {
    Entry::Action { id, label, accel: None, hint: None }
}
fn accel(id: &'static str, label: &'static str, accel: &'static str) -> Entry {
    Entry::Action { id, label, accel: Some(accel), hint: None }
}
fn hinted(id: &'static str, label: &'static str, hint: &'static str) -> Entry {
    Entry::Action { id, label, accel: None, hint: Some(hint) }
}
const SEP: Entry = Entry::Separator;

/// [`Entry::Dynamic`] slots the frontend fills.
pub const DYNAMIC_TOOL_WINDOWS: &str = "toolWindows";
pub const DYNAMIC_LAYOUTS: &str = "toolWindowLayouts";
/// Tools › entries of plugins (`[[contributes.menus]] menu = "tools"`).
pub const DYNAMIC_PLUGIN_TOOLS: &str = "pluginTools";

/// The menu bar for `os`. Labels are English defaults; the frontend replaces
/// them with `menu.<id>` strings from the active locale catalog.
pub fn spec(os: Os) -> Vec<Entry> {
    let mac = os == Os::Mac;
    let show_log = match os {
        Os::Mac => "Show Log in Finder",
        Os::Windows => "Show Log in Explorer",
        Os::Linux => "Show Log in Files",
    };
    let mut menus = Vec::new();

    if mac {
        menus.push(sub(
            "app",
            "OpenIDEA",
            vec![
                act("app.about", "About OpenIDEA"),
                act("app.checkForUpdates", "Check for Updates…"),
                SEP,
                act("file.settings", "Settings…"),
                SEP,
                Entry::Native(Native::Services),
                SEP,
                Entry::Native(Native::Hide),
                Entry::Native(Native::HideOthers),
                Entry::Native(Native::ShowAll),
                SEP,
                accel("app.quit", "Quit OpenIDEA", "CmdOrCtrl+Q"),
            ],
        ));
    }

    let mut file = vec![
        act("file.newProject", "New Project…"),
        act("workspace.create", "New Workspace…"),
        act("workspace.open", "Open Workspace…"),
        act("workspace.manage", "Manage Workspace…"),
        act("file.new", "New…"),
        act("file.newScratchFile", "New Scratch File…"),
        act("file.openProject", "Open…"),
        act("file.openFile", "Open File…"),
        act("file.openInNewWindow", "Open in New Window…"),
        sub(
            "openRecent",
            "Open Recent",
            vec![Entry::RecentProjects, SEP, act("welcome.recentProjects", "Manage Projects…")],
        ),
        act("file.closeProject", "Close Project"),
        act("file.renameProject", "Rename Project…"),
        SEP,
        act("remote.connect", "Remote Development…"),
        act("remote.disconnect", "Disconnect from Remote Host"),
        act("remote.reloadEnvironment", "Reload Environment"),
        SEP,
        act("file.save", "Save All"),
        act("file.reloadAllFromDisk", "Reload All from Disk"),
        sub("fileProperties", "File Properties", vec![act("file.toggleReadOnly", "Make File Read-only / Writable")]),
        SEP,
        act("file.invalidateCaches", "Invalidate Caches…"),
        SEP,
        sub(
            "manageIdeSettings",
            "Manage IDE Settings",
            vec![act("file.exportSettings", "Export Settings…"), act("file.importSettings", "Import Settings…")],
        ),
        sub(
            "newProjectsSetup",
            "New Projects Setup",
            vec![act("file.newProjectsSettings", "Settings for New Projects…")],
        ),
        SEP,
        act("file.togglePowerSave", "Power Save Mode"),
    ];
    if !mac {
        // macOS keeps Settings… and Quit in the application menu.
        file.extend([SEP, act("file.settings", "Settings…"), SEP, accel("app.quit", "Exit", "Ctrl+Q")]);
    }
    menus.push(sub("file", "File", file));

    let find = sub(
        "find",
        "Find",
        vec![
            act("find.inFile", "Find…"),
            act("find.replaceInFile", "Replace…"),
            SEP,
            act("find.inPath", "Find in Files…"),
            act("find.replaceInPath", "Replace in Files…"),
            act("find.structural", "Search Structurally…"),
            act("find.replaceStructural", "Replace Structurally…"),
            SEP,
            act("find.usages", "Find Usages"),
            act("find.showUsages", "Show Usages"),
        ],
    );
    let macros = || {
        sub(
            "macros",
            "Macros",
            vec![
                act("macro.startRecording", "Start Macro Recording"),
                act("macro.stopRecording", "Stop Macro Recording"),
                act("macro.playBack", "Play Back Last Macro"),
                SEP,
                act("macro.playSaved", "Play Saved Macros…"),
                act("macro.edit", "Edit Macros…"),
            ],
        )
    };
    let bookmarks = || {
        sub(
            "bookmarks",
            "Bookmarks",
            vec![
                act("navigate.toggleBookmark", "Toggle Bookmark"),
                act("navigate.toggleBookmarkWithMnemonic", "Toggle Bookmark with Mnemonic"),
                SEP,
                act("navigate.showBookmarks", "Show All Bookmarks…"),
                act("navigate.nextBookmark", "Next Bookmark"),
                act("navigate.prevBookmark", "Previous Bookmark"),
            ],
        )
    };
    let edit = if mac {
        vec![
            Entry::Native(Native::Undo),
            Entry::Native(Native::Redo),
            SEP,
            Entry::Native(Native::Cut),
            Entry::Native(Native::Copy),
            Entry::Native(Native::Paste),
            act("code.pasteFromHistory", "Paste from History…"),
            act("code.pasteAsPlainText", "Paste as Plain Text"),
            Entry::Native(Native::SelectAll),
            SEP,
            find,
            SEP,
            act("editor.copyPath", "Copy Path"),
            act("editor.copyReference", "Copy Reference"),
            SEP,
            act("code.sortLines", "Sort Lines"),
            act("code.reverseLines", "Reverse Lines"),
            SEP,
            act("editor.toggleColumnSelection", "Column Selection Mode"),
            SEP,
            macros(),
            bookmarks(),
        ]
    } else {
        // GTK/Win32 accelerators would swallow these keys before the webview, so
        // they are plain items routed to `document.execCommand` by the frontend.
        vec![
            hinted("edit.undo", "Undo", "Ctrl+Z"),
            hinted("edit.redo", "Redo", "Ctrl+Shift+Z"),
            SEP,
            hinted("edit.cut", "Cut", "Ctrl+X"),
            hinted("edit.copy", "Copy", "Ctrl+C"),
            hinted("edit.paste", "Paste", "Ctrl+V"),
            act("code.pasteFromHistory", "Paste from History…"),
            act("code.pasteAsPlainText", "Paste as Plain Text"),
            hinted("edit.selectAll", "Select All", "Ctrl+A"),
            SEP,
            find,
            SEP,
            act("editor.copyPath", "Copy Path"),
            act("editor.copyReference", "Copy Reference"),
            SEP,
            act("code.sortLines", "Sort Lines"),
            act("code.reverseLines", "Reverse Lines"),
            SEP,
            act("editor.toggleColumnSelection", "Column Selection Mode"),
            SEP,
            macros(),
            bookmarks(),
        ]
    };
    menus.push(sub("edit", "Edit", edit));

    menus.push(sub(
        "view",
        "View",
        vec![
            sub(
                "toolWindows",
                "Tool Windows",
                vec![Entry::Dynamic(DYNAMIC_TOOL_WINDOWS), SEP, act("toolwindow.hideAll", "Hide All Tool Windows")],
            ),
            sub(
                "appearance",
                "Appearance",
                vec![
                    act("editor.toggleZen", "Enter Distraction Free Mode"),
                    act("window.toggleFullScreen", "Toggle Full Screen"),
                    act("view.toggleCompactMode", "Compact Mode"),
                    SEP,
                    act("view.zoomIn", "Zoom In IDE"),
                    act("view.zoomOut", "Zoom Out IDE"),
                    act("view.resetZoom", "Reset IDE Zoom"),
                    SEP,
                    act("view.toggleTheme", "Toggle Light/Dark Theme"),
                    act("toolbar.customize", "Customize Main Toolbar…"),
                ],
            ),
            SEP,
            act("code.quickDefinition", "Quick Definition"),
            act("code.quickTypeDefinition", "Quick Type Definition"),
            SEP,
            act("navigate.recentLocations", "Recent Locations"),
            act("navigate.recentFiles", "Recent Files"),
            act("localHistory.recentChanges", "Recent Changes"),
            SEP,
            act("diff.compareWithClipboard", "Compare with Clipboard"),
            SEP,
            act("view.quickSwitchScheme", "Quick Switch Scheme…"),
            SEP,
            act("editor.resetFontSize", "Reset Font Size in All Editors"),
            SEP,
            act("view.notifications", "Notifications"),
        ],
    ));

    menus.push(sub(
        "navigate",
        "Navigate",
        vec![
            act("navigate.searchEverywhere", "Search Everywhere"),
            act("navigate.gotoClass", "Class…"),
            act("navigate.gotoFile", "File…"),
            act("navigate.gotoSymbol", "Symbol…"),
            act("navigate.gotoLine", "Line/Column…"),
            SEP,
            act("navigate.back", "Back"),
            act("navigate.forward", "Forward"),
            act("navigate.lastEditLocation", "Last Edit Location"),
            act("navigate.nextEditLocation", "Next Edit Location"),
            SEP,
            act("navigate.declaration", "Declaration or Usages"),
            act("navigate.implementation", "Implementation(s)"),
            act("navigate.typeDeclaration", "Type Declaration"),
            act("navigate.superMethod", "Super Method"),
            act("navigate.gotoTest", "Test"),
            SEP,
            act("navigate.fileStructure", "File Structure"),
            act("navigate.showFilePath", "File Path"),
            act("navigate.callHierarchy", "Call Hierarchy"),
            act("navigate.typeHierarchy", "Type Hierarchy"),
            act("navigate.customRegion", "Custom Folding…"),
            SEP,
            act("navigate.nextMethod", "Next Method"),
            act("navigate.previousMethod", "Previous Method"),
            SEP,
            act("navigate.nextError", "Next Highlighted Error"),
            act("navigate.prevError", "Previous Highlighted Error"),
            SEP,
            act("navigate.selectIn", "Select In…"),
        ],
    ));

    menus.push(sub(
        "code",
        "Code",
        vec![
            sub(
                "completion",
                "Code Completion",
                vec![
                    act("code.completion", "Basic"),
                    SEP,
                    act("code.cyclicExpandWord", "Cyclic Expand Word"),
                    act("code.cyclicExpandWordBackward", "Cyclic Expand Word (Backward)"),
                ],
            ),
            act("code.parameterInfo", "Parameter Info"),
            act("code.quickDocumentation", "Quick Documentation"),
            act("code.expressionTypeInfo", "Expression Type Info"),
            act("code.showErrorDescription", "Error Description"),
            act("editor.contextInfo", "Context Info"),
            act("code.showIntentions", "Show Context Actions"),
            act("code.generate", "Generate…"),
            act("code.overrideMethods", "Override Methods…"),
            act("code.implementMethods", "Implement Methods…"),
            SEP,
            act("code.insertLiveTemplate", "Insert Live Template…"),
            act("code.surroundWith", "Surround With…"),
            act("code.surroundWithLiveTemplate", "Surround with Live Template…"),
            act("code.unwrap", "Unwrap/Remove…"),
            SEP,
            act("code.reformat", "Reformat Code"),
            act("code.autoIndentLines", "Auto-Indent Lines"),
            act("code.optimizeImports", "Optimize Imports"),
            act("code.cleanup", "Code Cleanup…"),
            SEP,
            act("code.commentLine", "Comment with Line Comment"),
            act("code.commentBlock", "Comment with Block Comment"),
            SEP,
            act("code.extendSelection", "Extend Selection"),
            act("code.shrinkSelection", "Shrink Selection"),
            act("code.duplicateLine", "Duplicate Line or Selection"),
            act("code.deleteLine", "Delete Line"),
            act("code.moveStatementUp", "Move Statement Up"),
            act("code.moveStatementDown", "Move Statement Down"),
            act("code.moveElementLeft", "Move Element Left"),
            act("code.moveElementRight", "Move Element Right"),
            act("code.moveLineUp", "Move Line Up"),
            act("code.moveLineDown", "Move Line Down"),
            SEP,
            sub(
                "folding",
                "Folding",
                vec![
                    act("code.foldToggle", "Expand/Collapse"),
                    act("code.foldAll", "Collapse All"),
                    act("code.unfoldAll", "Expand All"),
                    sub(
                        "expandToLevel",
                        "Expand to Level",
                        vec![
                            act("code.expandToLevel1", "1"),
                            act("code.expandToLevel2", "2"),
                            act("code.expandToLevel3", "3"),
                            act("code.expandToLevel4", "4"),
                            act("code.expandToLevel5", "5"),
                        ],
                    ),
                    sub(
                        "expandAllToLevel",
                        "Expand All to Level",
                        vec![
                            act("code.expandAllToLevel1", "1"),
                            act("code.expandAllToLevel2", "2"),
                            act("code.expandAllToLevel3", "3"),
                            act("code.expandAllToLevel4", "4"),
                            act("code.expandAllToLevel5", "5"),
                        ],
                    ),
                    SEP,
                    act("code.collapseBlock", "Fold Code Block"),
                    act("code.foldSelection", "Fold Selection / Remove Region"),
                ],
            ),
            SEP,
            act("analyze.inspectCode", "Inspect Code…"),
            sub(
                "analyzeCode",
                "Analyze Code",
                vec![
                    act("analyze.inspectFile", "Inspect Current File"),
                    act("analyze.locateDuplicates", "Locate Duplicates…"),
                ],
            ),
            act("analyze.stackTrace", "Analyze Stack Trace or Thread Dump…"),
        ],
    ));

    menus.push(sub(
        "refactor",
        "Refactor",
        vec![
            act("refactor.thisMenu", "Refactor This…"),
            SEP,
            act("refactor.rename", "Rename…"),
            act("refactor.changeSignature", "Change Signature…"),
            SEP,
            act("refactor.extractVariable", "Introduce Variable…"),
            act("refactor.extractConstant", "Introduce Constant…"),
            act("refactor.extractField", "Introduce Field…"),
            act("refactor.extractParameter", "Introduce Parameter…"),
            act("refactor.extractMethod", "Extract Method…"),
            act("refactor.inline", "Inline…"),
            SEP,
            act("refactor.pullMembersUp", "Pull Members Up…"),
            act("refactor.pushMembersDown", "Push Members Down…"),
            SEP,
            act("refactor.move", "Move…"),
            act("project.copyElement", "Copy…"),
            act("refactor.safeDelete", "Safe Delete…"),
        ],
    ));

    menus.push(sub(
        "build",
        "Build",
        vec![
            act("build.buildProject", "Build Project"),
            act("build.buildModule", "Build Module"),
            act("build.rebuildProject", "Rebuild Project"),
            SEP,
            act("build.buildArtifacts", "Build Artifacts"),
        ],
    ));

    menus.push(sub(
        "run",
        "Run",
        vec![
            act("run.run", "Run"),
            act("run.debug", "Debug"),
            act("run.runContext", "Run Context Configuration"),
            act("run.debugContext", "Debug Context Configuration"),
            act("run.coverage", "Run with Coverage"),
            act("run.profile", "Profile"),
            act("run.stop", "Stop"),
            SEP,
            act("run.chooseConfig", "Run…"),
            act("run.chooseDebugConfig", "Debug…"),
            act("runAnything.show", "Run Anything…"),
            act("run.editConfigs", "Edit Configurations…"),
            act("run.updateApplication", "Update Application"),
            act("debug.attachToProcess", "Attach to Process…"),
            SEP,
            act("debug.resume", "Resume Program"),
            act("debug.pause", "Pause Program"),
            act("debug.stepOver", "Step Over"),
            act("debug.forceStepOver", "Force Step Over"),
            act("debug.stepInto", "Step Into"),
            act("debug.forceStepInto", "Force Step Into"),
            act("debug.smartStepInto", "Smart Step Into"),
            act("debug.stepOut", "Step Out"),
            act("debug.runToCursor", "Run to Cursor"),
            act("debug.forceRunToCursor", "Force Run to Cursor"),
            act("debug.showExecutionPoint", "Show Execution Point"),
            act("debug.resetFrame", "Reset Frame"),
            act("debug.evaluate", "Evaluate Expression…"),
            act("debug.quickEvaluate", "Quick Evaluate Expression"),
            sub(
                "debuggingActions",
                "Debugging Actions",
                vec![act("debug.reloadChangedClasses", "Reload Changed Classes")],
            ),
            SEP,
            act("coverage.hide", "Hide Coverage"),
            SEP,
            act("debug.toggleBreakpoint", "Toggle Line Breakpoint"),
            act("debug.toggleTemporaryBreakpoint", "Toggle Temporary Line Breakpoint"),
            act("debug.toggleMethodBreakpoint", "Toggle Method Breakpoint"),
            act("debug.toggleFieldWatchpoint", "Toggle Field Watchpoint"),
            act("debug.viewBreakpoints", "View Breakpoints…"),
        ],
    ));

    menus.push(sub(
        "git",
        "Git",
        vec![
            act("vcs.commit", "Commit…"),
            act("vcs.push", "Push…"),
            act("vcs.update", "Update Project…"),
            act("vcs.pull", "Pull…"),
            act("vcs.fetch", "Fetch"),
            SEP,
            // Operation items (Abort Merge, Continue Rebase…) are enabled only while it is in progress.
            act("vcs.merge", "Merge…"),
            act("vcs.merge.abort", "Abort Merge"),
            act("vcs.rebase", "Rebase…"),
            act("vcs.rebase.abort", "Abort Rebase"),
            act("vcs.rebase.continue", "Continue Rebase"),
            act("vcs.rebase.skip", "Skip Commit"),
            act("vcs.resolveConflicts", "Resolve Conflicts…"),
            SEP,
            act("vcs.branches", "Branches…"),
            act("vcs.newBranch", "New Branch…"),
            act("vcs.newTag", "New Tag…"),
            act("vcs.resetHead", "Reset HEAD…"),
            SEP,
            act("vcs.newWorktree", "New Worktree…"),
            act("vcs.worktrees", "Worktrees…"),
            SEP,
            act("vcs.showLog", "Show Git Log"),
            sub(
                "gitPatch",
                "Patch",
                vec![
                    act("vcs.createPatch", "Create Patch…"),
                    act("vcs.applyPatch", "Apply Patch…"),
                    act("vcs.applyPatchFromClipboard", "Apply Patch from Clipboard…"),
                ],
            ),
            sub(
                "gitUncommittedChanges",
                "Uncommitted Changes",
                vec![
                    act("vcs.shelve", "Shelve Changes…"),
                    act("vcs.showShelf", "Show Shelf"),
                    act("vcs.stash", "Stash Changes…"),
                    act("vcs.unstash", "Unstash Changes…"),
                    act("vcs.rollback", "Rollback…"),
                ],
            ),
            sub(
                "gitCurrentFile",
                "Current File",
                vec![
                    act("vcs.addToVcs", "Add to VCS"),
                    SEP,
                    act("vcs.annotate", "Annotate with Git Blame"),
                    act("vcs.showDiff", "Show Diff"),
                    act("vcs.compareWithBranch", "Compare with Branch or Revision…"),
                    act("vcs.showHistory", "Show History"),
                    act("vcs.showHistoryForSelection", "Show History for Selection"),
                    SEP,
                    act("vcs.localHistory", "Local History"),
                    act("localHistory.putLabel", "Put Label…"),
                ],
            ),
            SEP,
            sub(
                "gitHub",
                "GitHub",
                vec![
                    act("github.pullRequests", "View Pull Requests"),
                    act("github.createPullRequest", "Create Pull Request…"),
                    act("github.checkoutPullRequest", "Checkout Pull Request…"),
                    act("github.openInBrowser", "Open on GitHub"),
                ],
            ),
            act("vcs.manageRemotes", "Manage Remotes…"),
            act("vcs.clone", "Clone…"),
            SEP,
            act("vcs.operations", "VCS Operations Popup…"),
            SEP,
            act("vcs.revert.continue", "Continue Revert"),
            act("vcs.revert.abort", "Abort Revert"),
            act("vcs.cherryPick.continue", "Continue Cherry-Pick"),
            act("vcs.cherryPick.abort", "Abort Cherry-Pick"),
        ],
    ));

    menus.push(sub(
        "tools",
        "Tools",
        vec![
            act("http.newRequest", "New HTTP Request"),
            act("http.showToolWindow", "HTTP Client"),
            SEP,
            act("db.showToolWindow", "Database"),
            act("db.newDataSource", "New Data Source…"),
            act("db.openConsole", "Open Query Console"),
            SEP,
            act("ssh.startSession", "Start SSH Session…"),
            act("ssh.configurations", "SSH Configurations…"),
            sub(
                "deployment",
                "Deployment",
                vec![
                    act("deployment.uploadToDefault", "Upload to Default Server"),
                    act("deployment.uploadTo", "Upload to…"),
                    act("deployment.downloadFromDefault", "Download from Default Server"),
                    act("deployment.downloadFrom", "Download from…"),
                    act("deployment.syncWith", "Sync with Deployed…"),
                    act("deployment.deleteFromServer", "Delete from Server"),
                    SEP,
                    act("deployment.toggleAutoUpload", "Automatic Upload"),
                    act("deployment.browseRemoteHost", "Browse Remote Host"),
                    act("deployment.openInBrowser", "Open in Browser"),
                    act("deployment.configure", "Configuration…"),
                ],
            ),
            SEP,
            act("vim.toggle", "Vim"),
            Entry::Dynamic(DYNAMIC_PLUGIN_TOOLS),
        ],
    ));

    let mut window = Vec::new();
    if mac {
        window.extend([Entry::Native(Native::Minimize), Entry::Native(Native::Zoom), SEP]);
    }
    window.extend([
        sub(
            "toolWindowLayouts",
            "Tool Window Layouts",
            vec![
                act("layout.save", "Save Current Layout as…"),
                act("layout.restoreDefault", "Restore Default Layout"),
                SEP,
                Entry::Dynamic(DYNAMIC_LAYOUTS),
                SEP,
                act("layout.rename", "Rename Layout…"),
                act("layout.delete", "Delete Layout…"),
            ],
        ),
        SEP,
        sub(
            "activeToolWindow",
            "Active Tool Window",
            vec![
                act("toolwindow.hideActive", "Hide Active Tool Window"),
                act("toolwindow.maximize", "Maximize Tool Window"),
                act("toolwindow.closeContent", "Close Active Tab"),
                sub(
                    "resizeToolWindow",
                    "Resize",
                    vec![
                        act("toolwindow.resizeLeft", "Stretch to Left"),
                        act("toolwindow.resizeRight", "Stretch to Right"),
                        act("toolwindow.resizeUp", "Stretch to Top"),
                        act("toolwindow.resizeDown", "Stretch to Bottom"),
                    ],
                ),
                SEP,
                act("toolwindow.jumpToLast", "Jump to Last Tool Window"),
                act("toolwindow.focusEditor", "Focus Editor"),
            ],
        ),
        sub(
            "editorTabs",
            "Editor Tabs",
            vec![
                act("editor.nextTab", "Select Next Tab"),
                act("editor.prevTab", "Select Previous Tab"),
                SEP,
                act("editor.pinTab", "Pin Tab"),
                act("editor.closeTab", "Close Tab"),
                act("editor.closeOtherTabs", "Close Other Tabs"),
                act("editor.closeAllTabs", "Close All Tabs"),
                act("editor.reopenClosedTab", "Reopen Closed Tab"),
                SEP,
                act("editor.splitRight", "Split Right"),
                act("editor.splitDown", "Split Down"),
                act("editor.unsplit", "Unsplit"),
                act("editor.moveToOppositeGroup", "Move to Opposite Group"),
                act("editor.openInOppositeGroup", "Open in Opposite Group"),
                act("editor.changeSplitOrientation", "Change Splitter Orientation"),
                act("editor.unsplitAll", "Unsplit All"),
                act("editor.nextSplitter", "Go to Next Splitter"),
                act("editor.prevSplitter", "Go to Previous Splitter"),
            ],
        ),
        SEP,
        act("window.new", "New Window"),
        act("window.mergeAllWindows", "Merge All Project Windows"),
        act("window.detachTab", "Move Tab to New Window"),
        act("window.nextTab", "Next Project Tab"),
        act("window.previousTab", "Previous Project Tab"),
    ]);
    // ⌘` is macOS's window cycling; elsewhere Ctrl+` is Quick Switch Scheme and the keymap's
    // Ctrl+Alt+] / Ctrl+Alt+[ switch windows.
    if mac {
        window.extend([
            accel("window.next", "Next Project Window", "Cmd+`"),
            accel("window.previous", "Previous Project Window", "Cmd+Shift+`"),
        ]);
    } else {
        window.extend([act("window.next", "Next Project Window"), act("window.previous", "Previous Project Window")]);
    }
    if mac {
        window.extend([SEP, Entry::Native(Native::BringAllToFront)]);
    }
    menus.push(sub("window", "Window", window));

    let mut help = vec![
        act("navigate.findAction", "Find Action…"),
        act("help.keymapReference", "Keymap Reference"),
        SEP,
        act("help.showLog", show_log),
    ];
    if !mac {
        help.extend([act("app.checkForUpdates", "Check for Updates…"), SEP, act("app.about", "About OpenIDEA")]);
    }
    menus.push(sub("help", "Help", help));
    menus
}

/// What a clicked menu item asks the frontend to do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MenuRoute {
    pub action: String,
    pub arg: Option<String>,
}

/// Maps a clicked item id to the action to run. `None` for ids that are not
/// IDE items (native roles, placeholders).
pub fn route(spec: &[Entry], id: &str) -> Option<MenuRoute> {
    if let Some(path) = id.strip_prefix(RECENT_PREFIX) {
        return Some(MenuRoute { action: OPEN_RECENT_ACTION.into(), arg: Some(path.into()) });
    }
    if let Some(rest) = id.strip_prefix(DYNAMIC_PREFIX) {
        let (action, arg) = match rest.split_once('|') {
            Some((action, arg)) => (action, Some(arg.to_owned())),
            None => (rest, None),
        };
        return (!action.is_empty()).then(|| MenuRoute { action: action.into(), arg });
    }
    action_ids(spec).into_iter().any(|a| a == id).then(|| MenuRoute { action: id.into(), arg: None })
}

/// `entries` without the action `id` (and a separator it leaves doubled or trailing).
pub fn without_action(entries: Vec<Entry>, id: &str) -> Vec<Entry> {
    let mut out: Vec<Entry> = Vec::with_capacity(entries.len());
    for e in entries {
        match e {
            Entry::Action { id: a, .. } if a == id => {}
            Entry::Submenu { id: sid, label, children } => {
                out.push(Entry::Submenu { id: sid, label, children: without_action(children, id) })
            }
            Entry::Separator if matches!(out.last(), None | Some(Entry::Separator)) => {}
            e => out.push(e),
        }
    }
    if matches!(out.last(), Some(Entry::Separator)) {
        out.pop();
    }
    out
}

/// Every action id reachable from the spec (with duplicates).
pub fn action_ids(spec: &[Entry]) -> Vec<&'static str> {
    fn walk(entries: &[Entry], out: &mut Vec<&'static str>) {
        for e in entries {
            match e {
                Entry::Submenu { children, .. } => walk(children, out),
                Entry::Action { id, .. } => out.push(id),
                _ => {}
            }
        }
    }
    let mut out = Vec::new();
    walk(spec, &mut out);
    out
}

/// Localised labels and displayed shortcuts, pushed by the frontend.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MenuConfig {
    pub locale: String,
    /// `menu.<id>` → label (ids of submenus, actions and `native.*` roles).
    pub labels: HashMap<String, String>,
    /// Action id → display shortcut from the JS keymap, e.g. `⇧⌘O`.
    pub shortcuts: HashMap<String, String>,
    /// [`Entry::Dynamic`] slot → its items, already localised.
    #[serde(default)]
    pub dynamic: HashMap<String, Vec<DynamicItem>>,
}

/// An item of a frontend-listed menu slot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DynamicItem {
    pub action: String,
    pub arg: Option<String>,
    pub label: String,
}

impl DynamicItem {
    /// Native menu item id, decoded again by [`route`].
    pub fn item_id(&self) -> String {
        match &self.arg {
            Some(arg) => format!("{DYNAMIC_PREFIX}{}|{arg}", self.action),
            None => format!("{DYNAMIC_PREFIX}{}", self.action),
        }
    }
}

impl MenuConfig {
    fn label(&self, id: &str, default: &str) -> String {
        self.labels.get(&format!("menu.{id}")).cloned().unwrap_or_else(|| default.to_owned())
    }

    fn dynamic_items(&self, slot: &str) -> &[DynamicItem] {
        self.dynamic.get(slot).map(Vec::as_slice).unwrap_or_default()
    }

    /// A dynamic item's text: its label, plus the action's shortcut unless it carries an argument.
    fn dynamic_text(&self, item: &DynamicItem) -> String {
        match self.shortcuts.get(&item.action).filter(|s| item.arg.is_none() && !s.is_empty()) {
            Some(shortcut) => format!("{}\t{shortcut}", item.label),
            None => item.label.clone(),
        }
    }

    /// Item text with the keymap shortcut appended after a tab (display only).
    pub fn item_text(&self, id: &str, default: &str, hint: Option<&str>) -> String {
        let label = self.label(id, default);
        match self.shortcuts.get(id).map(String::as_str).filter(|s| !s.is_empty()).or(hint) {
            Some(shortcut) => format!("{label}\t{shortcut}"),
            None => label,
        }
    }
}

#[derive(Default)]
pub struct MenuState {
    pub config: Mutex<MenuConfig>,
    /// Action ids the focused window reports as disabled (no context / not registered).
    pub disabled: Mutex<HashSet<String>>,
    /// Visible menu last installed. Shortcuts for actions that are not on the menu
    /// are not part of this, so they must not redraw the macOS menu bar.
    rendered: Mutex<Option<Vec<RenderedMenu>>>,
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

/// The action an item id stands for, if it is an IDE action item.
fn item_action(id: &str) -> Option<&str> {
    if id.starts_with(RECENT_PREFIX) || id == "recent.none" || id.starts_with("submenu:") {
        return None;
    }
    Some(id.strip_prefix(DYNAMIC_PREFIX).map_or(id, |rest| rest.split_once('|').map_or(rest, |(a, _)| a)))
}

/// Whether the item `id` is enabled given the disabled action ids.
pub fn item_enabled(id: &str, disabled: &HashSet<String>) -> bool {
    item_action(id).is_none_or(|a| !disabled.contains(a))
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

pub struct RecentItem {
    pub path: String,
    pub label: String,
}

pub fn recent_items(recent: &[ide_workspace::RecentProject], home: Option<&Path>) -> Vec<RecentItem> {
    recent
        .iter()
        .take(MAX_RECENT)
        .map(|p| {
            let shown = match home.and_then(|h| p.path.strip_prefix(h).ok()) {
                Some(rest) => format!("~/{}", rest.display()),
                None => p.path.display().to_string(),
            };
            RecentItem { path: p.path.to_string_lossy().into_owned(), label: format!("{}  —  {shown}", p.name) }
        })
        .collect()
}

/// One top-level menu, as it will actually be drawn.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RenderedMenu {
    id: &'static str,
    title: String,
    items: Vec<RenderedItem>,
}

/// A visible menu row. Unused keymap shortcuts are intentionally absent.
#[derive(Debug, Clone, PartialEq, Eq)]
enum RenderedItem {
    Submenu {
        id: &'static str,
        title: String,
        items: Vec<RenderedItem>,
    },
    /// `accel` is set only for items that own a native accelerator; their shortcut
    /// is then not copied from [`MenuConfig::shortcuts`].
    Action {
        id: String,
        text: String,
        accel: Option<&'static str>,
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

/// Visible items for `entries`. Shortcuts that no item displays do not affect the result.
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
                id,
                title: config.label(id, label),
                items: render_items(children, config, recent),
            }),
            Entry::Action { id, label, accel, hint } => {
                let text = match accel {
                    Some(_) => config.label(id, label),
                    None => config.item_text(id, label, *hint),
                };
                out.push(RenderedItem::Action { id: (*id).into(), text, accel: *accel });
            }
            Entry::Dynamic(slot) => {
                for item in config.dynamic_items(slot) {
                    out.push(RenderedItem::Action { id: item.item_id(), text: config.dynamic_text(item), accel: None });
                }
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
                    });
                }
            }
        }
    }
    out
}

fn structure_key(item: &RenderedItem) -> (u8, &str, Option<&str>) {
    match item {
        RenderedItem::Submenu { id, .. } => (0, *id, None),
        RenderedItem::Action { id, accel, .. } => (1, id.as_str(), *accel),
        RenderedItem::Placeholder { id, .. } => (2, id.as_str(), None),
        RenderedItem::Native { kind, .. } => (3, kind.key(), None),
        RenderedItem::Separator => (4, "", None),
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
        #[cfg(target_os = "macos")]
        match rendered.id {
            "window" => submenu.set_as_windows_menu_for_nsapp()?,
            "help" => submenu.set_as_help_menu_for_nsapp()?,
            _ => {}
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
            RenderedItem::Submenu { id, title, items } => {
                let child = Submenu::with_id(app, format!("submenu:{id}"), title, true)?;
                append_rendered(app, &child, items, disabled)?;
                parent.append(&child)?;
            }
            RenderedItem::Action { id, text, accel } => {
                let enabled = item_enabled(id, disabled);
                parent.append(&MenuItem::with_id(app, id, text, enabled, *accel)?)?;
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
        (MenuItemKind::MenuItem(item), RenderedItem::Action { id, .. } | RenderedItem::Placeholder { id, .. }) => {
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
            RenderedItem::Submenu { title: previous_title, items: previous_items, .. },
            RenderedItem::Submenu { title, items, .. },
        ) => {
            if previous_title != title && submenu.set_text(title).is_err() {
                return false;
            }
            sync_children(app, submenu, previous_items, items, disabled, true)
        }
        (
            MenuItemKind::MenuItem(item),
            _,
            RenderedItem::Action { text, .. } | RenderedItem::Placeholder { text, .. },
        ) => item.set_text(text).is_ok(),
        (MenuItemKind::Predefined(item), _, RenderedItem::Native { text, .. }) => item.set_text(text).is_ok(),
        _ => false,
    }
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

/// A menu entry for a menu bar drawn by the frontend (Windows title bar).
/// Labels are the English defaults; the frontend localises them like the native menu.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum MenuNode {
    Submenu {
        id: String,
        label: String,
        children: Vec<MenuNode>,
    },
    /// Runs `id` with `arg`. Items with an `arg` (Open Recent) carry their final label.
    Action {
        id: String,
        label: String,
        hint: Option<String>,
        arg: Option<String>,
    },
    /// A disabled placeholder such as "No Recent Projects".
    Placeholder {
        id: String,
        label: String,
    },
    Separator,
}

/// The spec as [`MenuNode`]s; native role items (macOS only) are left out.
pub fn model(spec: &[Entry], recent: &[RecentItem], config: &MenuConfig) -> Vec<MenuNode> {
    let mut out = Vec::new();
    for e in spec {
        match e {
            Entry::Submenu { id, label, children } => out.push(MenuNode::Submenu {
                id: (*id).into(),
                label: (*label).into(),
                children: model(children, recent, config),
            }),
            Entry::Dynamic(slot) => out.extend(config.dynamic_items(slot).iter().map(|d| MenuNode::Action {
                id: d.action.clone(),
                label: d.label.clone(),
                hint: None,
                arg: d.arg.clone(),
            })),
            Entry::Action { id, label, hint, .. } => out.push(MenuNode::Action {
                id: (*id).into(),
                label: (*label).into(),
                hint: hint.map(Into::into),
                arg: None,
            }),
            Entry::Native(_) => {}
            Entry::Separator => out.push(MenuNode::Separator),
            Entry::RecentProjects if recent.is_empty() => {
                out.push(MenuNode::Placeholder { id: "recent.none".into(), label: "No Recent Projects".into() })
            }
            Entry::RecentProjects => out.extend(recent.iter().map(|r| MenuNode::Action {
                id: OPEN_RECENT_ACTION.into(),
                label: r.label.clone(),
                hint: None,
                arg: Some(r.path.clone()),
            })),
        }
    }
    out
}

/// Whether the OS menu bar is used. Windows and Linux project windows are
/// frameless and draw IDEA's hamburger menu in their own title bar instead.
pub fn native_menu_bar() -> bool {
    cfg!(target_os = "macos")
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
    let items = recent_items(recent, home.as_deref());
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
    match build(app, Os::current(), &config, &items, &disabled).and_then(|menu| app.set_menu(menu)) {
        Ok(_) => *slot = Some(rendered),
        Err(e) => tracing::warn!("failed to build the app menu: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

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
        extra.shortcuts.insert("java.compile".into(), "⌘K".into());
        // Shown by the native accelerator, not by the keymap text.
        extra.shortcuts.insert("window.next".into(), "⌘`".into());
        assert_eq!(render_bar(&entries, &base, &[]), render_bar(&entries, &extra, &[]));
    }

    #[test]
    fn tool_windows_change_only_the_view_menu() {
        let entries = spec(Os::Mac);
        let base = MenuConfig::default();
        let mut with_maven = base.clone();
        with_maven.shortcuts.insert("toolwindow.maven".into(), "⌘9".into());
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
        let mut shortcuts = base.clone();
        shortcuts.shortcuts.insert("file.save".into(), "⌘S".into());
        assert_eq!(changed_menus(&render_bar(&entries, &base, &[]), &render_bar(&entries, &shortcuts, &[])), ["file"]);

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
                "file.settings",
                "file.newProjectsSettings",
                "window.new",
                "window.next",
                "window.previous",
                "window.toggleFullScreen",
                "view.toggleTheme",
                "editor.toggleZen",
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
    fn labels_and_shortcuts_come_from_config() {
        let mut config = MenuConfig::default();
        assert_eq!(config.item_text("file.save", "Save All", None), "Save All");
        assert_eq!(config.item_text("edit.copy", "Copy", Some("Ctrl+C")), "Copy\tCtrl+C");
        config.labels.insert("menu.file.save".into(), "全部保存".into());
        config.shortcuts.insert("file.save".into(), "⌘S".into());
        assert_eq!(config.item_text("file.save", "Save All", None), "全部保存\t⌘S");
        assert_eq!(config.label("file", "File"), "File");
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
    fn recent_labels_tildify_home() {
        let recent = vec![ide_workspace::RecentProject {
            path: "/home/me/code/openidea".into(),
            name: "openidea".into(),
            opened_at_ms: 0.0,
            branch: None,
        }];
        let items = recent_items(&recent, Some(Path::new("/home/me")));
        assert_eq!(items[0].label, "openidea  —  ~/code/openidea");
        assert_eq!(items[0].path, "/home/me/code/openidea");
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
        DynamicItem { action: action.into(), arg: arg.map(Into::into), label: label.into() }
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
            assert_eq!(found, [DYNAMIC_TOOL_WINDOWS, DYNAMIC_PLUGIN_TOOLS, DYNAMIC_LAYOUTS], "{os:?}");
            assert!(!action_ids(&spec).iter().any(|id| {
                id.starts_with("toolwindow.")
                    && *id != "toolwindow.hideAll"
                    && ![
                        "toolwindow.hideActive",
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
        config.shortcuts.insert("toolwindow.project".into(), "⌘1".into());
        assert_eq!(config.dynamic_text(&config.dynamic[DYNAMIC_TOOL_WINDOWS][0]), "Project\t⌘1");
        assert_eq!(config.dynamic_text(&dynamic_item("toolwindow.project", Some("x"), "X")), "X");
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
                "layout.save",
                "layout.restoreDefault",
                "layout.rename",
                "layout.delete",
                "toolwindow.hideActive",
                "editor.closeOtherTabs",
                "toolbar.customize",
            ] {
                assert!(ids.contains(&required), "{required} missing on {os:?}");
            }
        }
    }
}
