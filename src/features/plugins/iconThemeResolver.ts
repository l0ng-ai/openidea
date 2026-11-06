import type { FileIconThemeOptions } from "@/bindings";
import { isSymbolIcon, type FileIconTheme } from "@/ui";
import { createPatternIndex, type IndexedPattern } from "@/ui/patternIndex";

export interface IconThemePattern {
  pattern: string;
  icon: string;
  target: "file" | "folder";
  path: boolean;
  ignoreCase: boolean;
  group: string | null;
  openIcon: string | null;
}

export interface IconThemeGroup {
  id: string;
  name: string;
  enabled: boolean;
}

export interface IconThemeChoiceOption {
  id: string;
  name: string;
  overrides: Record<string, string>;
}

export interface IconThemeChoice {
  id: string;
  name: string;
  default: string;
  options: IconThemeChoiceOption[];
}

export interface IconThemeMap {
  file: string | null;
  folder?: string | null;
  folderExpanded?: string | null;
  folderOpen?: string | null;
  fileExtensions: Record<string, string>;
  fileNames: Record<string, string>;
  folderNames?: Record<string, string>;
  patterns?: IconThemePattern[];
  overrides?: Record<string, string>;
  groups?: IconThemeGroup[];
  choices?: IconThemeChoice[];
  accent?: boolean;
}

export interface ResolverSettings {
  hidden: string;
  options: FileIconThemeOptions;
}

export interface ThemeResolver extends FileIconTheme {
  icon(name: string): string | null;
}

interface Compiled extends IndexedPattern {
  icon: string;
  openIcon: string | null;
}

const MAX_NAME_LEN = 255;
const MAX_PATH_LEN = 1024;
const MAX_CACHED = 5000;

const normalizePath = (path: string | null | undefined) => (path ? path.replace(/\\/g, "/") : null);

function compile(map: IconThemeMap, target: IconThemePattern["target"], options: FileIconThemeOptions) {
  const enabled = (group: string | null) => {
    if (!group) return true;
    return options.groups?.[group] ?? map.groups?.find((g) => g.id === group)?.enabled ?? true;
  };
  const compiled: Compiled[] = [];
  (map.patterns ?? []).forEach((p, order) => {
    if (p.target !== target || !enabled(p.group)) return;
    try {
      const re = new RegExp(p.pattern, p.ignoreCase ? "i" : "");
      compiled.push({ re, source: p.pattern, path: p.path, order, icon: p.icon, openIcon: p.openIcon });
    } catch {
      return;
    }
  });
  return createPatternIndex(compiled, (p, name, path) => {
    const subject = p.path ? path : name;
    if (subject === null || subject.length > (p.path ? MAX_PATH_LEN : MAX_NAME_LEN)) return false;
    return p.re.test(subject);
  });
}

function chosenOverrides(map: IconThemeMap, options: FileIconThemeOptions): Record<string, string> {
  return Object.assign(
    {},
    ...(map.choices ?? []).map((c) => {
      const picked = options.choices?.[c.id];
      const option = c.options.find((o) => o.id === picked) ?? c.options.find((o) => o.id === c.default);
      return option?.overrides ?? {};
    }),
  );
}

function cached(resolve: (fileName: string, path: string | null) => string | null) {
  const cache = new Map<string, string | null>();
  return (fileName: string, path: string | null) => {
    const key = path ?? `\0${fileName}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    if (cache.size >= MAX_CACHED) cache.clear();
    const icon = resolve(fileName, path);
    cache.set(key, icon);
    return icon;
  };
}

export function iconResolver(
  map: IconThemeMap,
  iconName: (icon: string) => string,
  has: (name: string) => boolean,
  settings: ResolverSettings = { hidden: "", options: {} },
): ThemeResolver {
  const { options, hidden } = settings;
  const pick = (icon: string | undefined | null) => (icon && has(iconName(icon)) ? iconName(icon) : null);
  const files = compile(map, "file", options);
  const folders = compile(map, "folder", options);
  const chosen = chosenOverrides(map, options);
  const overrides = map.overrides ?? {};
  const replaced = (name: string) => {
    if (isSymbolIcon(name) ? options.hidePsiIcons : options.hideUiIcons) return null;
    if (Object.hasOwn(chosen, name)) return chosen[name];
    return Object.hasOwn(overrides, name) ? overrides[name] : null;
  };
  const fileIcon = cached((fileName, path) => {
    const lower = fileName.toLowerCase();
    const hit = files.find(fileName, path);
    const matched = hit && pick(hit.icon);
    if (matched) return matched;
    const named = pick(map.fileNames[lower]);
    if (named) return named;
    let rest = lower;
    for (let dot = rest.indexOf("."); dot >= 0; dot = rest.indexOf(".")) {
      rest = rest.slice(dot + 1);
      const byExt = pick(map.fileExtensions[rest]);
      if (byExt) return byExt;
    }
    return pick(map.file);
  });
  return {
    file(fileName, path) {
      if (options.hideFiles && hidden) return hidden;
      return fileIcon(fileName, normalizePath(path));
    },
    folder(folderName, expanded, holdsOpenFile = false, path = null) {
      if (options.hideFolders && hidden) return hidden;
      const open = !!options.hollowFolders && holdsOpenFile;
      const hit = folders.find(folderName, normalizePath(path));
      const matched = hit && ((open && pick(hit.openIcon)) || pick(hit.icon));
      if (matched) return matched;
      const named = pick(map.folderNames?.[folderName.toLowerCase()]);
      if (named) return named;
      if (open && pick(map.folderOpen)) return pick(map.folderOpen);
      return (expanded && pick(map.folderExpanded)) || pick(map.folder);
    },
    icon(name) {
      return pick(replaced(name));
    },
  };
}
