/**
 * File Types at runtime: Override File Type / Revert File Type Override in the
 * Project view and editor tab menus (`files.fileTypeOverrides`, project scope,
 * as IDEA keeps them per project) and file icons for the user's patterns.
 */
import { executeAction, registerActions } from "@/platform/actions";
import { call, commands, isTauri, type LanguageInfo_Serialize as LanguageInfo } from "@/platform/ipc";
import {
  sampleFileName,
  userFileType,
  validateFileTypeOverrides,
  validateFileTypes,
  type FileTypeAssociations,
} from "@/platform/fileTypes";
import { onLanguageListChanged } from "@/platform/languageList";
import { loadSettings, useProject } from "@/platform/project";
import { fileIconName, setFileIconOverride, type IconName, type MenuItem } from "@/ui";
import { registerMenuGroup } from "@/workbench/contributions";

let languages: LanguageInfo[] | null = null;
let loading: Promise<LanguageInfo[]> | null = null;

function loadLanguages(): Promise<LanguageInfo[]> {
  if (!isTauri()) return Promise.resolve([]);
  return (loading ??= commands
    .languages()
    .then((list) => (languages = [...list].sort((a, b) => a.name.localeCompare(b.name))))
    .catch(() => {
      loading = null;
      return [];
    }));
}

/** Settings key of a file: project-relative inside the project, else absolute. */
export function overrideKey(path: string, root: string | null): string {
  return root && path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
}

function currentOverrides(): Record<string, string> {
  return validateFileTypeOverrides(
    (useProject.getState().settings?.files as { fileTypeOverrides?: unknown } | undefined)?.fileTypeOverrides,
  );
}

async function writeOverride(path: string, language: string | null) {
  const root = useProject.getState().project?.root ?? null;
  const next = { ...currentOverrides() };
  const key = overrideKey(path, root);
  if (language) next[key] = language;
  else delete next[key];
  await call(commands.settingsSet(root ? "project" : "global", "files.fileTypeOverrides", JSON.stringify(next)));
  await loadSettings();
}

function overrideMenu(path: string): MenuItem[] {
  const langs = languages ?? [];
  if (!langs.length) return [];
  const current = currentOverrides()[overrideKey(path, useProject.getState().project?.root ?? null)];
  const items: MenuItem[] = [
    {
      label: "Override File Type",
      submenu: langs.map((l) => ({
        label: l.name,
        verbatim: true,
        checked: l.id === current,
        run: () => void executeAction("file.overrideFileType", { path, language: l.id }),
      })),
    },
  ];
  if (current)
    items.push({
      kind: "action",
      action: "file.revertFileTypeOverride",
      arg: { path },
      label: "Revert File Type Override",
    });
  return items;
}

function iconResolver(assoc: FileTypeAssociations): ((name: string) => IconName | null) | null {
  if (!Object.keys(assoc).length || !languages) return null;
  const byId = new Map(languages.map((l) => [l.id, l]));
  return (name) => {
    const id = userFileType(assoc, name);
    const lang = id ? byId.get(id) : undefined;
    const sample = lang && sampleFileName(lang);
    return sample ? fileIconName(sample) : null;
  };
}

export function activateFileTypes(): () => void {
  const syncIcons = () => {
    const files = useProject.getState().settings?.files as { fileTypes?: unknown } | undefined;
    setFileIconOverride(iconResolver(validateFileTypes(files?.fileTypes)));
  };
  void loadLanguages().then(syncIcons);
  const unsub = useProject.subscribe((s, prev) => {
    if (s.settings !== prev.settings) syncIcons();
  });
  const disposers = [
    // Plugins add and remove languages: read the list again.
    onLanguageListChanged(() => {
      loading = null;
      void loadLanguages().then(syncIcons);
    }),
    unsub,
    () => setFileIconOverride(null),
    registerActions([
      {
        id: "file.overrideFileType",
        title: "Override File Type",
        category: "File",
        hidden: true,
        run: ({ arg }) => {
          const { path, language } = (arg ?? {}) as { path?: string; language?: string };
          if (path && language) void writeOverride(path, language);
        },
      },
      {
        id: "file.revertFileTypeOverride",
        title: "Revert File Type Override",
        category: "File",
        hidden: true,
        run: ({ arg }) => {
          const path = (arg as { path?: string } | undefined)?.path;
          if (path) void writeOverride(path, null);
        },
      },
    ]),
    registerMenuGroup({
      id: "settings.fileType",
      menus: ["projectView", "editorTab"],
      order: 90,
      prepare: async () => void (await loadLanguages()),
      items: (_menu, { paths, dirs }) => {
        const path = paths.length === 1 && !dirs?.[0] ? paths[0]! : null;
        return path && !path.includes("://") ? overrideMenu(path) : [];
      },
    }),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
