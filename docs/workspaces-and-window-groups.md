# Workspaces and project window groups

A workspace opens several local project folders in one IDE session. A window group switches between independent IDE sessions; a member can itself contain a workspace.

## Workspace

Use **File → New Workspace…**. Choose a name and a separate directory for the workspace, then add project folders. **File → Open Workspace…** opens that directory again. **File → Manage Workspace…** changes its name or linked projects. Removing a link leaves the project's files and open editor buffers intact.

When opening another local project, choose **Attach** to add it to this window. A plain project becomes a workspace automatically under the IDE app data directory's `workspaces` folder, named after the current project (with a unique directory suffix when needed). The existing editor session carries over after the unsaved-changes guard. **Don't ask again** remembers Attach; change it in **Settings → System Settings → Project → Open project in**. Already linked projects are revealed in Project view. Right-click a non-first linked root and choose **Remove from Workspace** to unlink it without deleting files.

The workspace stores its manifest in `.openidea/workspace.json`:

```json
{
  "version": 1,
  "name": "Full stack",
  "projects": ["/work/frontend", "/work/backend"]
}
```

Paths in an existing manifest may be relative to the workspace directory. New and updated manifests use canonical absolute paths. Missing previously linked folders are retained so they can be reconnected or removed. Nested workspace manifests are rejected.

Linked folders appear as roots in Project view and participate in indexing, Find in Files, Git repository discovery and language-server root selection. Detected and saved run configurations have project-qualified names and use their member's working directory and launch settings. Build Project combines the linked projects' build plans; Compile File targets its owning project. Workspace editor/settings state belongs to its own directory. Each member retains its repository and project configuration.

The specialized Maven/Gradle tool-window model still describes the workspace directory itself; it does not yet aggregate independent member models. Workspace creation and management currently target local folders.

## Window group

Open two project windows, then use **Window → Merge All Project Windows**. The project tabs occupy their own row below the main toolbar. Click a tab or use **Next/Previous Project Tab** to switch; drag tabs to reorder them. The default shortcuts are ⌥⌘PageDown/PageUp on macOS and Ctrl+Alt+PageDown/PageUp on Windows/Linux.

Use the tab's close button to close that project, or **Move Tab to New Window** to detach the current tab. Closing uses the existing unsaved-changes guard. Quit visits project windows in sequence so a hidden project's prompt is visible. Groups restore when **Reopen last project** is enabled.

The grouping model lives in `ide-workspace`, independently of project ownership. The desktop adapter keeps each member's WebView and backend services alive, presents the selected window at the group's position/size, and hides its peers. This is an application-drawn tab strip, not the macOS native tab strip. Its persistence is application-local in `window-groups.json`. Language servers, terminals, editor buffers and settings remain independent between group members.

## Validation

Automated coverage includes workspace manifest validation and persistence, missing members, independent language-server initialization roots, cross-root search/repositories/run directories, document preservation after unlinking, window-group membership/order, dialog failures and tab keyboard controls.

Tauri MCP validation on macOS covered workspace creation and management, opening same-named files from both projects, cross-project search, running both projects, tab selection/reordering/detachment, unsaved close cancellation, full-screen switching and application restart restoration. Windows/Linux native-window behavior has not been visually tested.
