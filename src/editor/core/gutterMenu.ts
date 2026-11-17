/** The line-number gutter's context menu, IDEA's EditorGutterPopupMenu. */
import { executeAction } from "@/platform/actions";
import { editorPrefs } from "@/platform/editorSettings";
import { call, commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { menuGroupItems } from "@/workbench/contributions";
import type { MenuItem } from "@/ui";
import type { EditorSlot } from "./model/slot";

/** Whether a right-click on `target` belongs to the gutter menu (contributed gutters with their own menu handle theirs). */
export function inGutterMenuArea(target: EventTarget | null): boolean {
  const t = target as HTMLElement | null;
  return !!t?.closest?.(".cm-gutters") && !t.closest(".cm-vcs-blame");
}

async function setEditorSetting(key: string, value: unknown) {
  useProject.setState({ settings: await call(commands.settingsSet("global", `editor.${key}`, JSON.stringify(value))) });
}

function toggle(label: string, key: string, on: boolean): MenuItem {
  return { label, checked: on, run: () => void setEditorSetting(key, !on) };
}

function appearanceItems(): MenuItem[] {
  const p = editorPrefs();
  const whitespace = !!useProject.getState().settings?.editor?.showWhitespace;
  return [
    toggle("Show Line Numbers", "appearance.lineNumbers", p.appearance.lineNumbers),
    toggle("Show Gutter Icons", "showGutterIcons", p.showGutterIcons),
    toggle("Show Folding Outline", "folding.showOutline", p.folding.showOutline),
    toggle("Show Indent Guides", "appearance.indentGuides", p.appearance.indentGuides),
    toggle("Show Whitespaces", "showWhitespace", whitespace),
    toggle("Show Method Separators", "appearance.methodSeparators", p.appearance.methodSeparators),
    toggle("Show Breadcrumbs", "breadcrumbs.show", p.breadcrumbs.show),
  ];
}

const openSettings = (page: string) => () => void executeAction("file.settings", page);

export function gutterMenuItems(slot: EditorSlot, line: number): MenuItem[] {
  const model = slot.model;
  return [
    // Contributed groups (Annotate with Git Blame, bookmarks), each followed by a separator.
    ...menuGroupItems("editorGutter", { paths: [model.path], text: slot.currentState().doc.toString(), line }),
    { label: "Soft-Wrap", checked: model.softWrapOn(), run: () => model.toggleSoftWrap() },
    { label: "Configure Soft Wraps…", run: openSettings("editor.general") },
    { label: "Render Documentation Comments", checked: model.renderedDocsOn(), run: () => model.toggleRenderedDocs() },
    { kind: "separator" },
    { label: "Appearance", submenu: appearanceItems() },
    { label: "Configure Gutter Icons…", run: openSettings("editor.general.gutterIcons") },
  ];
}
