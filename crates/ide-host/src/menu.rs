//! The application menu as data: the spec table ([`spec`]) every window's menu is built from,
//! and its model ([`model`]) for a menu bar drawn by the frontend. The desktop app renders the
//! spec with the native menu API; `openidea-server --web` serves the model to the browser.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::path::Path;

/// Prefix of Open Recent item ids; the rest of the id is the project path.
pub const RECENT_PREFIX: &str = "recent:";
/// Prefix of items the frontend lists ([`MenuConfig::dynamic`]): `dyn:<action>` or `dyn:<action>|<arg>`.
pub const DYNAMIC_PREFIX: &str = "dyn:";
/// Action run for an Open Recent entry (argument: the project path).
pub const OPEN_RECENT_ACTION: &str = "file.openRecentProject";
pub const MAX_RECENT: usize = 15;

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
    pub fn key(self) -> &'static str {
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

    pub fn default_label(self) -> &'static str {
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
    pub fn implicit_accelerator(self) -> Option<&'static str> {
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
        /// Native accelerator (Tauri syntax) that fires natively ([`fires_natively`]) and wins
        /// over the keymap's. Only for keys the webview never handles.
        accel: Option<&'static str>,
        /// Shortcut text after the label, for the Windows/Linux edit items without a keymap binding.
        hint: Option<&'static str>,
        /// A toggle (IDEA's ToggleAction) drawn with a check mark; on when its id is in
        /// [`MenuConfig::checked`].
        check: bool,
    },
    Native(Native),
    Separator,
    /// Open Recent entries, filled from the recent-projects list.
    RecentProjects,
    /// Items the frontend lists under this slot name (registered tool windows,
    /// saved layouts), from [`MenuConfig::dynamic`].
    Dynamic(&'static str),
}

pub fn sub(id: &'static str, label: &'static str, children: Vec<Entry>) -> Entry {
    Entry::Submenu { id, label, children }
}
pub fn act(id: &'static str, label: &'static str) -> Entry {
    Entry::Action { id, label, accel: None, hint: None, check: false }
}
pub fn accel(id: &'static str, label: &'static str, accel: &'static str) -> Entry {
    Entry::Action { id, label, accel: Some(accel), hint: None, check: false }
}
pub fn hinted(id: &'static str, label: &'static str, hint: &'static str) -> Entry {
    Entry::Action { id, label, accel: None, hint: Some(hint), check: false }
}
pub fn toggle(id: &'static str, label: &'static str) -> Entry {
    Entry::Action { id, label, accel: None, hint: None, check: true }
}
pub const SEP: Entry = Entry::Separator;

/// [`Entry::Dynamic`] slots the frontend fills.
pub const DYNAMIC_TOOL_WINDOWS: &str = "toolWindows";
pub const DYNAMIC_LAYOUTS: &str = "toolWindowLayouts";
/// View › Appearance › Status Bar Widgets: every titled widget with its check mark.
pub const DYNAMIC_STATUS_BAR_WIDGETS: &str = "statusBarWidgets";
/// Tools › entries of plugins (`[[contributes.menus]] menu = "tools"`).
pub const DYNAMIC_PLUGIN_TOOLS: &str = "pluginTools";
/// Build › Flutter: the Flutter build actions, filled only in Flutter projects. Shown as a submenu
/// first in Build (the Flutter plugin's anchor) when it has items, nothing otherwise.
pub const DYNAMIC_FLUTTER_BUILD: &str = "flutterBuild";
/// Id (and `menu.` label key) of the Build › Flutter submenu.
pub const FLUTTER_BUILD_MENU: &str = "build.flutter";

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
                act("app.installCli", "Install 'openidea' Command"),
                act("app.uninstallCli", "Uninstall 'openidea' Command"),
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
        sub(
            "new",
            "New",
            vec![
                act("file.newProject", "Project…"),
                act("workspace.create", "Workspace…"),
                act("vcs.cloneProject", "Project from Version Control…"),
                SEP,
                act("file.new", "File…"),
                act("file.newScratchFile", "Scratch File"),
                act("file.newUntitled", "Untitled File"),
            ],
        ),
        act("file.openProject", "Open…"),
        act("file.openFile", "Open File…"),
        act("file.openInNewWindow", "Open in New Window…"),
        sub(
            "openRecent",
            "Open Recent",
            vec![Entry::RecentProjects, SEP, act("welcome.recentProjects", "Manage Projects…")],
        ),
        act("project.attach", "Attach Project…"),
        SEP,
        act("workspace.open", "Open Workspace…"),
        act("workspace.manage", "Manage Workspace…"),
        SEP,
        act("file.closeProject", "Close Project"),
        act("file.renameProject", "Rename Project…"),
        SEP,
        act("remote.connect", "Remote Development…"),
        act("remote.reopenInContainer", "Reopen in Container"),
        act("remote.disconnect", "Disconnect from Remote Host"),
        act("remote.stopBackend", "Stop Remote Backend"),
        act("remote.reloadEnvironment", "Reload Environment"),
        SEP,
        act("file.save", "Save All"),
        act("file.reloadAllFromDisk", "Reload All from Disk"),
        sub("fileProperties", "File Properties", vec![act("file.toggleReadOnly", "Make File Read-only / Writable")]),
        SEP,
        act("file.projectStructure", "Project Structure…"),
        SEP,
        act("file.invalidateCaches", "Invalidate Caches…"),
        SEP,
        sub(
            "manageIdeSettings",
            "Manage IDE Settings",
            vec![
                act("file.exportSettings", "Export Settings…"),
                act("file.importSettings", "Import Settings…"),
                act("file.importJetBrainsSettings", "Import Settings from JetBrains IDE…"),
            ],
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
                    act("view.toggleZenMode", "Enter Zen Mode"),
                    act("window.toggleFullScreen", "Toggle Full Screen"),
                    toggle("view.toggleCompactMode", "Compact Mode"),
                    toggle("view.togglePresentationAssistant", "Presentation Assistant"),
                    SEP,
                    act("view.zoomIn", "Zoom In IDE"),
                    act("view.zoomOut", "Zoom Out IDE"),
                    act("view.resetZoom", "Reset IDE Zoom"),
                    SEP,
                    act("view.toggleTheme", "Toggle Light/Dark Theme"),
                    act("toolbar.customize", "Customize Main Toolbar…"),
                    SEP,
                    toggle("view.toggleToolbar", "Toolbar"),
                    toggle("view.toggleToolWindowBars", "Tool Window Bars"),
                    sub(
                        "navigationBar",
                        "Navigation Bar",
                        vec![
                            toggle("view.navigationBarTop", "Top"),
                            toggle("view.navigationBarStatusBar", "Status Bar"),
                            toggle("view.navigationBarHidden", "Don't Show"),
                        ],
                    ),
                    toggle("view.toggleStatusBar", "Status Bar"),
                    sub("statusBarWidgets", "Status Bar Widgets", vec![Entry::Dynamic(DYNAMIC_STATUS_BAR_WIDGETS)]),
                ],
            ),
            sub(
                "activeEditor",
                "Active Editor",
                vec![
                    act("editor.toggleSoftWrap", "Soft-Wrap"),
                    act("editor.toggleRenderedDocs", "Render Documentation Comments"),
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
            act("editor.resetFontSize", "Reset Font Size"),
            act("editor.resetFontSizeAll", "Reset Font Size in All Editors"),
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
            act("navigate.relatedSymbol", "Related Symbol…"),
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
                    act("code.smartTypeCompletion", "Smart Type"),
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
            act("code.rearrange", "Rearrange Code"),
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
                    act("code.expandDocComments", "Expand Doc Comments"),
                    act("code.collapseDocComments", "Collapse Doc Comments"),
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
            act("refactor.extractInterface", "Extract Interface…"),
            act("refactor.extractTypeAlias", "Extract Type Alias…"),
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
            Entry::Dynamic(DYNAMIC_FLUTTER_BUILD),
            act("build.buildProject", "Build Project"),
            act("build.buildModule", "Build Module"),
            act("build.compileFile", "Recompile"),
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
            act("profiler.openSnapshot", "Open Profiler Snapshot…"),
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
            act("vcs.unshallow", "Fetch Full History"),
            act("vcs.lfsPull", "Pull LFS Objects"),
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
                    act("vcs.showStashes", "Show Stash"),
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

    let mut tools = vec![
        act("code.saveAsLiveTemplate", "Save as Live Template…"),
        SEP,
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
    ];
    if !mac {
        tools.extend([
            SEP,
            act("app.installCli", "Install 'openidea' Command"),
            act("app.uninstallCli", "Uninstall 'openidea' Command"),
        ]);
    }
    menus.push(sub("tools", "Tools", tools));

    let mut window = Vec::new();
    if mac {
        window.extend([Entry::Native(Native::Minimize), Entry::Native(Native::Zoom), SEP]);
    }
    window.extend([
        sub(
            "toolWindowLayouts",
            "Tool Window Layouts",
            vec![
                toggle("layout.restoreDefault", "Restore Default Layout"),
                Entry::Dynamic(DYNAMIC_LAYOUTS),
                SEP,
                act("layout.restoreCurrent", "Restore Current Layout"),
                act("layout.saveCurrent", "Save Changes in Current Layout"),
                act("layout.save", "Save Current Layout as…"),
            ],
        ),
        SEP,
        sub(
            "activeToolWindow",
            "Active Tool Window",
            vec![
                act("toolwindow.hideActive", "Hide Active Tool Window"),
                act("toolwindow.hideSide", "Hide Side Tool Windows"),
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
        act("app.whatsNew", "What's New"),
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

/// Localised labels and keymap accelerators, pushed by the frontend.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MenuConfig {
    pub locale: String,
    /// `menu.<id>` → label (ids of submenus, actions and `native.*` roles).
    pub labels: HashMap<String, String>,
    /// Action id → native accelerator of its first keymap binding, e.g. `Shift+Meta+O`.
    /// Absent when that binding has no native form (chord, double modifier).
    pub accelerators: HashMap<String, String>,
    /// [`Entry::Dynamic`] slot → its items, already localised.
    #[serde(default)]
    pub dynamic: HashMap<String, Vec<DynamicItem>>,
    /// Ids of the toggle actions currently on.
    #[serde(default)]
    pub checked: Vec<String>,
}

/// An item of a frontend-listed menu slot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DynamicItem {
    pub action: String,
    pub arg: Option<String>,
    pub label: String,
    /// Drawn with a check mark in this state; `None` for a plain item.
    #[serde(default)]
    pub checked: Option<bool>,
}

impl DynamicItem {
    /// Native menu item id, decoded again by [`route`].
    pub fn item_id(&self) -> String {
        match &self.arg {
            Some(arg) => format!("{DYNAMIC_PREFIX}{}|{arg}", self.action),
            None => format!("{DYNAMIC_PREFIX}{}", self.action),
        }
    }

    pub fn model(&self) -> MenuNode {
        MenuNode::Action {
            id: self.action.clone(),
            label: self.label.clone(),
            hint: None,
            arg: self.arg.clone(),
            checked: self.checked,
        }
    }
}

pub struct LayoutMenu<'a> {
    pub id: String,
    pub name: &'a str,
    pub current: bool,
    pub items: Vec<Option<DynamicItem>>,
}

impl MenuConfig {
    pub fn label(&self, id: &str, default: &str) -> String {
        self.labels.get(&format!("menu.{id}")).cloned().unwrap_or_else(|| default.to_owned())
    }

    pub fn dynamic_items(&self, slot: &str) -> &[DynamicItem] {
        self.dynamic.get(slot).map(Vec::as_slice).unwrap_or_default()
    }

    pub fn layout_menus(&self) -> Vec<LayoutMenu<'_>> {
        self.dynamic_items(DYNAMIC_LAYOUTS)
            .iter()
            .filter_map(|layout| {
                let name = layout.arg.as_deref()?;
                let current = layout.checked.unwrap_or_default();
                let command = |action: &str, label_key, fallback| {
                    Some(DynamicItem {
                        action: action.into(),
                        arg: Some(name.into()),
                        label: self.label(label_key, fallback),
                        checked: None,
                    })
                };
                let mut items = if current {
                    vec![
                        command("layout.restore", "layout.restoreNamed", "Restore"),
                        command("layout.saveCurrent", "layout.saveNamed", "Save Changes"),
                    ]
                } else {
                    vec![command("layout.restore", "layout.applyNamed", "Apply")]
                };
                items.extend([
                    command("layout.rename", "layout.renameNamed", "Rename…"),
                    None,
                    command("layout.delete", "layout.deleteNamed", "Delete…"),
                ]);
                Some(LayoutMenu { id: format!("layout:{name}"), name, current, items })
            })
            .collect()
    }

    /// The keymap accelerator shown on the item of action `id`.
    pub fn accelerator(&self, id: &str) -> Option<&str> {
        self.accelerators.get(id).map(String::as_str).filter(|a| !a.is_empty())
    }

    /// A dynamic item's accelerator: the action's, unless the item carries an argument.
    pub fn dynamic_accelerator(&self, item: &DynamicItem) -> Option<&str> {
        item.arg.is_none().then(|| self.accelerator(&item.action)).flatten()
    }

    /// Item text: the label, with the spec's hint after a tab (Windows/Linux edit items).
    pub fn item_text(&self, id: &str, default: &str, hint: Option<&str>) -> String {
        let label = self.label(id, default);
        match hint {
            Some(hint) => format!("{label}\t{hint}"),
            None => label,
        }
    }
}

/// A recent Remote Development project (SSH, WSL, Dev Container), kept by the frontend: Open
/// Recent lists it among the local projects, as Manage Projects does.
#[derive(Debug, Clone, PartialEq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRecent {
    /// `ssh://host/path`, `wsl://Ubuntu/path`…: what `file.openRecentProject` gets back.
    pub location: String,
    pub name: String,
    /// Where it lives, as shown after the name (`me@host:/srv/app`).
    pub detail: String,
    pub opened_at_ms: f64,
}

pub struct RecentItem {
    pub path: String,
    pub label: String,
}

/// The local and remote recent projects, most recently opened first.
pub fn recent_items(
    recent: &[ide_workspace::RecentProject],
    remote: &[RemoteRecent],
    home: Option<&Path>,
) -> Vec<RecentItem> {
    let local = recent.iter().map(|p| {
        let shown = match home.and_then(|h| p.path.strip_prefix(h).ok()) {
            Some(rest) => format!("~/{}", rest.display()),
            None => p.path.display().to_string(),
        };
        let item =
            RecentItem { path: p.path.to_string_lossy().into_owned(), label: format!("{}  —  {shown}", p.name) };
        (p.opened_at_ms, item)
    });
    let remote = remote.iter().map(|r| {
        (r.opened_at_ms, RecentItem { path: r.location.clone(), label: format!("{}  —  {}", r.name, r.detail) })
    });
    let mut items: Vec<(f64, RecentItem)> = local.chain(remote).collect();
    // Stable: the local list's own order holds among equal times.
    items.sort_by(|a, b| b.0.total_cmp(&a.0));
    items.into_iter().take(MAX_RECENT).map(|(_, item)| item).collect()
}

/// A menu entry for a menu bar drawn by the frontend (Windows title bar).
/// Labels are the English defaults; the frontend localises them like the native menu.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum MenuNode {
    Submenu {
        id: String,
        label: String,
        /// Saved layout selection, unset for ordinary submenus.
        #[serde(skip_serializing_if = "Option::is_none")]
        current: Option<bool>,
        children: Vec<MenuNode>,
    },
    /// Runs `id` with `arg`. Items with an `arg` (Open Recent) carry their final label.
    /// `checked` is the state of a frontend-listed toggle (Status Bar Widgets). Spec toggles
    /// leave it unset: the frontend menu reads their state from the action (`toggled`), the
    /// source [`MenuConfig::checked`] is built from for the native menu.
    Action {
        id: String,
        label: String,
        hint: Option<String>,
        arg: Option<String>,
        checked: Option<bool>,
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
                current: None,
                children: model(children, recent, config),
            }),
            Entry::Dynamic(DYNAMIC_LAYOUTS) => {
                let layouts = config.layout_menus();
                if !layouts.is_empty() {
                    out.push(MenuNode::Separator);
                }
                out.extend(layouts.into_iter().map(|layout| {
                    MenuNode::Submenu {
                        id: layout.id,
                        label: layout.name.into(),
                        current: Some(layout.current),
                        children: layout
                            .items
                            .into_iter()
                            .map(|item| item.map_or(MenuNode::Separator, |item| item.model()))
                            .collect(),
                    }
                }));
            }
            Entry::Dynamic(DYNAMIC_FLUTTER_BUILD) => {
                let items = config.dynamic_items(DYNAMIC_FLUTTER_BUILD);
                if !items.is_empty() {
                    out.push(MenuNode::Submenu {
                        id: FLUTTER_BUILD_MENU.into(),
                        label: "Flutter".into(),
                        current: None,
                        children: items.iter().map(DynamicItem::model).collect(),
                    });
                    out.push(MenuNode::Separator);
                }
            }
            Entry::Dynamic(slot) => out.extend(config.dynamic_items(slot).iter().map(DynamicItem::model)),
            Entry::Action { id, label, hint, .. } => out.push(MenuNode::Action {
                id: (*id).into(),
                label: (*label).into(),
                hint: hint.map(Into::into),
                arg: None,
                checked: None,
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
                checked: None,
            })),
        }
    }
    out
}
