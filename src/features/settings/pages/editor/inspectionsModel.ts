/**
 * Editor › Inspections tree: language → language server → diagnostic codes
 * seen, plus the built-in checks; enabled / severity state against a
 * profile's overrides (`@/platform/inspections`).
 */
import {
  BUILTIN_INSPECTIONS,
  INSPECTION_LEVELS,
  codeInspectionId,
  customProfileId,
  newProfileKey,
  overridesOf,
  producerInspectionId,
  profileLocation,
  type CustomProfile,
  type InspectionLevel,
  type InspectionOverride,
  type InspectionSettingsValid,
  type ProfileId,
  type ProfileLevel,
  type ProfileOverrides,
  type SeenCode,
} from "@/platform/inspections";

export interface InspectionNode {
  /** Unique in the tree (a server serving several languages appears under each). */
  key: string;
  /** Inspection id; absent for language / category groups. */
  id?: string;
  name: string;
  description: string;
  children: InspectionNode[];
}

export interface LanguageServers {
  name: string;
  servers: readonly string[];
}

const OTHER = "Other";

function serverNode(group: string, server: string, codes: readonly SeenCode[], languages: string): InspectionNode {
  const id = producerInspectionId(server);
  return {
    key: `${group}/${id}`,
    id,
    name: server,
    description: `Problems the ${server} language server reports${languages ? ` in ${languages} files` : ""}. Severity "As reported" keeps the level the server assigns; a code below can override it.`,
    children: [...codes]
      .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))
      .map((c) => ({
        key: `${group}/${codeInspectionId(id, c.code)}`,
        id: codeInspectionId(id, c.code),
        name: c.code,
        description: `${server} problems with code ${c.code}${c.source && c.source !== server ? ` (${c.source})` : ""}.${c.sample ? `\n\nExample: ${c.sample}` : ""}`,
        children: [],
      })),
  };
}

/**
 * The inspection tree: one group per language that has language servers, the
 * built-in checks under their category, and servers known only from seen
 * diagnostics or stored overrides under "Other". Groups sort by name.
 */
export function buildInspectionTree(
  languages: readonly LanguageServers[],
  seen: readonly SeenCode[],
  overrides: readonly ProfileOverrides[] = [],
): InspectionNode[] {
  const codes = new Map<string, Map<string, SeenCode>>();
  const addCode = (c: SeenCode) => {
    let m = codes.get(c.producer);
    if (!m) codes.set(c.producer, (m = new Map()));
    if (!m.has(c.code)) m.set(c.code, c);
  };
  seen.forEach(addCode);
  // Codes with stored overrides stay listed even if not seen in this session.
  for (const profile of overrides) {
    for (const id of Object.keys(profile)) {
      const m = /^lsp:([^:]+):(.+)$/.exec(id);
      if (m) addCode({ producer: m[1]!, code: m[2]!, source: "", sample: "" });
      else if (id.startsWith("lsp:") && !codes.has(id.slice(4))) codes.set(id.slice(4), new Map());
    }
  }
  const servedBy = new Map<string, string[]>();
  for (const l of languages) {
    for (const s of l.servers) servedBy.set(s, [...(servedBy.get(s) ?? []), l.name]);
  }

  const groups = new Map<string, InspectionNode>();
  const group = (name: string) => {
    let g = groups.get(name);
    if (!g) groups.set(name, (g = { key: `group:${name}`, name, description: "", children: [] }));
    return g;
  };
  for (const l of languages) {
    if (!l.servers.length) continue;
    const g = group(l.name);
    for (const s of l.servers) {
      g.children.push(serverNode(l.name, s, [...(codes.get(s)?.values() ?? [])], servedBy.get(s)!.join(", ")));
    }
  }
  const builtinProducers = new Set(BUILTIN_INSPECTIONS.map((b) => b.producer));
  for (const b of BUILTIN_INSPECTIONS) {
    group(b.group).children.push({
      key: `${b.group}/${b.id}`,
      id: b.id,
      name: b.name,
      description: b.description,
      children: [],
    });
  }
  for (const [producer, list] of codes) {
    if (servedBy.has(producer) || builtinProducers.has(producer)) continue;
    group(OTHER).children.push(serverNode(OTHER, producer, [...list.values()], ""));
  }
  for (const g of groups.values()) {
    g.description = `${g.children.length} inspection${g.children.length === 1 ? "" : "s"}.`;
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Nodes whose name, id or description (or an ancestor's name) contain every query word; ancestors kept. */
export function filterInspectionTree(nodes: readonly InspectionNode[], query: string): InspectionNode[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [...nodes];
  const walk = (list: readonly InspectionNode[], trail: string): InspectionNode[] =>
    list.flatMap((n) => {
      const hay = `${trail} ${n.name} ${n.id ?? ""} ${n.description}`.toLowerCase();
      if (terms.every((t) => hay.includes(t))) return [n];
      const children = walk(n.children, `${trail} ${n.name}`);
      return children.length ? [{ ...n, children }] : [];
    });
  return walk(nodes, "");
}

/** Inspection ids of a node and its descendants. */
export function inspectionIds(node: InspectionNode): string[] {
  return [...(node.id ? [node.id] : []), ...node.children.flatMap(inspectionIds)];
}

export const isEnabled = (o: ProfileOverrides, id: string) => o[id]?.enabled !== false;

export type CheckState = "on" | "off" | "mixed";

/** Checkbox of a node: an inspection that is off is off; otherwise mixed when some descendant is off. */
export function checkState(o: ProfileOverrides, node: InspectionNode): CheckState {
  if (node.id && !isEnabled(o, node.id)) return "off";
  const ids = inspectionIds(node);
  const on = ids.filter((id) => isEnabled(o, id)).length;
  if (on === ids.length) return "on";
  return on === 0 ? "off" : "mixed";
}

function withOverride(o: ProfileOverrides, id: string, patch: Partial<InspectionOverride>): ProfileOverrides {
  const next: Record<string, InspectionOverride> = { ...o };
  const entry: InspectionOverride = { ...o[id], ...patch };
  for (const k of Object.keys(entry) as (keyof InspectionOverride)[]) if (entry[k] === undefined) delete entry[k];
  if (Object.keys(entry).length) next[id] = entry;
  else delete next[id];
  return next;
}

/** Turns a node and all its descendants on or off (on is the default, so it removes the override). */
export function setEnabled(o: ProfileOverrides, node: InspectionNode, enabled: boolean): ProfileOverrides {
  return inspectionIds(node).reduce((acc, id) => withOverride(acc, id, { enabled: enabled ? undefined : false }), o);
}

/** `undefined` restores the default ("As reported"). */
export function setLevel(o: ProfileOverrides, id: string, level: InspectionLevel | undefined): ProfileOverrides {
  return withOverride(o, id, { severity: level });
}

/** Sets option `key` of inspection `id` (dropped again when back to its default). */
export function setOption(o: ProfileOverrides, id: string, key: string, value: boolean): ProfileOverrides {
  const fallback = BUILTIN_INSPECTIONS.find((b) => b.id === id)?.options?.find((x) => x.key === key)?.default ?? true;
  const options: Record<string, boolean> = { ...o[id]?.options };
  if (value === fallback) delete options[key];
  else options[key] = value;
  return withOverride(o, id, { options: Object.keys(options).length ? options : undefined });
}

/** Keys of `id`'s node and its ancestors in `nodes`, outermost first; null when absent. */
export function pathToInspection(nodes: readonly InspectionNode[], id: string): string[] | null {
  for (const n of nodes) {
    if (n.id === id) return [n.key];
    const below = pathToInspection(n.children, id);
    if (below) return [n.key, ...below];
  }
  return null;
}

export const AS_REPORTED = "";

export const LEVEL_OPTIONS = [
  { value: AS_REPORTED, label: "As reported" },
  ...INSPECTION_LEVELS.map((l) => ({ value: l.value, label: l.label })),
];

/** Search texts for the settings search (built-in checks and levels; servers load asynchronously). */
export const INSPECTION_KEYWORDS = [
  "inspections",
  "inspection profile",
  "code analysis",
  "lint",
  "linter",
  "diagnostics",
  "severity",
  "highlighting level",
  "language server",
  "copy profile",
  "rename profile",
  "delete profile",
  "spelling",
  "proofreading",
  "process code",
  "process literals",
  "process comments",
  ...BUILTIN_INSPECTIONS.map((b) => b.name),
  ...INSPECTION_LEVELS.map((l) => l.label),
];

// --- profile management (gear menu) ------------------------------------------

/** Replaces the overrides of profile `id`. */
export function withProfileOverrides(
  s: InspectionSettingsValid,
  id: ProfileId,
  overrides: ProfileOverrides,
): InspectionSettingsValid {
  const { level, key } = profileLocation(id);
  if (key === null) return level === "project" ? { ...s, project: overrides } : { ...s, default: overrides };
  const field = level === "project" ? "projectProfiles" : "ideProfiles";
  const existing = s[field][key];
  if (!existing) return s;
  return { ...s, [field]: { ...s[field], [key]: { ...existing, overrides } } };
}

/** Copy of profile `from` named `name` at `level`, made the chosen profile. */
export function copyProfile(
  s: InspectionSettingsValid,
  from: ProfileId,
  name: string,
  level: ProfileLevel,
): InspectionSettingsValid {
  const field = level === "project" ? "projectProfiles" : "ideProfiles";
  const key = newProfileKey(name, s[field]);
  const copy: CustomProfile = { name: name.trim(), overrides: { ...overridesOf(s, from) } };
  return { ...s, [field]: { ...s[field], [key]: copy }, profile: customProfileId(level, key) };
}

/** Renames a copied profile (the two defaults keep their names). */
export function renameProfile(s: InspectionSettingsValid, id: ProfileId, name: string): InspectionSettingsValid {
  const { level, key } = profileLocation(id);
  if (key === null) return s;
  const field = level === "project" ? "projectProfiles" : "ideProfiles";
  const existing = s[field][key];
  if (!existing) return s;
  return { ...s, [field]: { ...s[field], [key]: { ...existing, name: name.trim() } } };
}

/** Deletes a copied profile; the chosen profile falls back to the level's default. */
export function deleteProfile(s: InspectionSettingsValid, id: ProfileId): InspectionSettingsValid {
  const { level, key } = profileLocation(id);
  if (key === null) return s;
  const field = level === "project" ? "projectProfiles" : "ideProfiles";
  const rest = { ...s[field] };
  delete rest[key];
  const profile = s.profile === id ? (level === "project" ? "project" : "default") : s.profile;
  return { ...s, [field]: rest, profile };
}
