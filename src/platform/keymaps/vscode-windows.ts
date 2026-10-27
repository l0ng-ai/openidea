/**
 * "VS Code (Windows)" keymap: the macOS VS Code preset with ⌘ read as Ctrl,
 * plus the bindings where VS Code's Windows defaults differ.
 */
import { vscodeMacos } from "./vscode-macos";

/** `Meta` becomes `Ctrl`; a stroke that already uses Ctrl has no Windows spelling and is dropped. */
function withCtrl(binding: string): string | null {
  const strokes = binding.split(" ").map((s) => {
    const parts = s.split("+");
    if (parts.includes("Meta") && parts.includes("Ctrl")) return null;
    return parts.map((p) => (p === "Meta" ? "Ctrl" : p)).join("+");
  });
  return strokes.includes(null) ? null : strokes.join(" ");
}

const translated = Object.fromEntries(
  Object.entries(vscodeMacos).map(([id, keys]) => [id, keys.map(withCtrl).filter((k): k is string => k !== null)]),
);

export const vscodeWindows: Record<string, string[]> = {
  ...translated,
  "navigate.back": ["Alt+Left", "Button4"],
  "navigate.forward": ["Alt+Right", "Button5"],
  "find.replaceInFile": ["Ctrl+H"],
  "find.next": ["F3"],
  "find.previous": ["Shift+F3"],
  "find.popup.nextResult": ["F3"],
  "find.popup.previousResult": ["Shift+F3"],
  "code.extendSelection": ["Alt+Shift+Right"],
  "code.shrinkSelection": ["Alt+Shift+Left"],
  "code.fold": ["Ctrl+Shift+["],
  "code.unfold": ["Ctrl+Shift+]"],
  "code.joinLines": [],
  "file.openProject": ["Ctrl+K Ctrl+O"],
  "editor.closeTab": ["Ctrl+W", "Ctrl+F4"],
  "toolwindow.closeContent": ["Ctrl+W", "Ctrl+F4"],
  "editor.nextTab": ["Ctrl+PageDown"],
  "editor.prevTab": ["Ctrl+PageUp"],
  "window.toggleFullScreen": ["F11"],
  "project.rename": ["F2"],
  "project.delete": ["Delete"],
  "db.drop": ["Delete"],
  "project.copyAbsolutePath": ["Alt+Shift+C"],
  "project.open": [],
  // Editing extras, image viewer (keyWhen: image focused) and Markdown editor layouts
  "code.cyclicExpandWord": [],
  "code.cyclicExpandWordBackward": [],
  "editor.copyReference": [],
  "code.pasteAsPlainText": [],
  "code.expressionTypeInfo": [],
  "code.implementMethods": [],
  "code.overrideMethods": [],
  "image.zoomIn": [],
  "image.zoomOut": [],
  "image.actualSize": [],
  "image.fitToWindow": [],
  "image.toggleChessboard": [],
  "markdown.editorOnly": [],
  "markdown.editorAndPreview": ["Ctrl+K V"],
  "markdown.previewOnly": ["Ctrl+Shift+V"],
  // Agents (VS Code's chat: Ctrl+Shift+I)
  "agents.newTask": ["Ctrl+Shift+I"],
  "agents.showToolWindow": [],
  "agents.sendToAgent": [],
};
