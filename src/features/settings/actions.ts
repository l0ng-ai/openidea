import type { Action } from "@/platform/actions";
import { nativeToAsciiAction } from "./nativeToAscii";

/** Java's page first: JDK, Maven and the language server are what new projects most often need. */
export const NEW_PROJECTS_PAGE = "languages.java";

export function settingsActions(open: (page?: string, newProjects?: boolean) => void | Promise<void>): Action[] {
  return [
    nativeToAsciiAction(),
    {
      id: "file.settings",
      title: "Settings…",
      category: "File",
      icon: "settings",
      keywords: ["preferences", "options", "configure"],
      run: ({ arg }) => open(typeof arg === "string" ? arg : undefined),
    },
    {
      id: "file.newProjectsSettings",
      title: "Settings for New Projects…",
      category: "File",
      icon: "settings",
      keywords: ["new projects setup", "default settings", "default project", "default jdk", "global settings"],
      run: ({ arg }) => open(typeof arg === "string" ? arg : NEW_PROJECTS_PAGE, true),
    },
    {
      id: "settings.keymap",
      title: "Keymap…",
      category: "File",
      icon: "keyboard",
      keywords: ["shortcuts", "keyboard", "bindings"],
      run: () => open("keymap"),
    },
    {
      id: "settings.appearance",
      title: "Appearance…",
      category: "View",
      icon: "sun",
      keywords: ["theme", "accent", "font size"],
      run: () => open("appearance"),
    },
  ];
}
