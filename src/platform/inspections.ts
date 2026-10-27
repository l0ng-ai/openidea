/**
 * Inspection profiles (Settings › Editor › Inspections). Every diagnostic
 * producer is an inspection: a language server (`lsp:<server>`), optionally
 * refined per diagnostic code (`lsp:<server>:<code>`), or a built-in check.
 * The profile in effect disables inspections and remaps their severity; the
 * editor, Problems view and Inspect Code all filter through `applyProfile`.
 * Besides `Default` (IDE) and `Project Default`, profiles made with Copy live
 * at either level (`ide:<key>` / `project:<key>`).
 * Mirrors `ide-core::inspection_settings`.
 */
import type { Diagnostic, Severity } from "@/bindings";
import { useProject } from "./project";

export type InspectionLevel = "error" | "warning" | "weakWarning" | "serverProblem" | "typo" | "none";
/** `default`, `project`, `ide:<key>` or `project:<key>`. */
export type ProfileId = string;
export type ProfileLevel = "ide" | "project";

export interface InspectionOverride {
  enabled?: boolean;
  severity?: InspectionLevel;
  /** The inspection's own options (`BuiltinInspection.options`). */
  options?: Readonly<Record<string, boolean>>;
}

export type ProfileOverrides = Readonly<Record<string, InspectionOverride>>;

export interface CustomProfile {
  name: string;
  overrides: ProfileOverrides;
}

export type CustomProfiles = Readonly<Record<string, CustomProfile>>;

export interface InspectionSettingsValid {
  profile: ProfileId;
  default: ProfileOverrides;
  project: ProfileOverrides;
  ideProfiles: CustomProfiles;
  projectProfiles: CustomProfiles;
}

export const DEFAULT_INSPECTIONS: InspectionSettingsValid = {
  profile: "default",
  default: {},
  project: {},
  ideProfiles: {},
  projectProfiles: {},
};

/** IDEA's highlighting levels and the editor severity each one is shown with. */
export const INSPECTION_LEVELS: readonly { value: InspectionLevel; label: string; severity: Severity }[] = [
  { value: "error", label: "Error", severity: "error" },
  { value: "warning", label: "Warning", severity: "warning" },
  { value: "weakWarning", label: "Weak Warning", severity: "info" },
  { value: "serverProblem", label: "Server Problem", severity: "warning" },
  { value: "typo", label: "Typo", severity: "info" },
  { value: "none", label: "No highlighting", severity: "hint" },
];

export const PROFILE_LABELS: Record<"default" | "project", string> = { default: "Default", project: "Project Default" };

export function levelSeverity(level: InspectionLevel): Severity {
  return INSPECTION_LEVELS.find((l) => l.value === level)?.severity ?? "warning";
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const LEVELS = new Set<string>(INSPECTION_LEVELS.map((l) => l.value));

function validateOverrides(raw: unknown): Record<string, InspectionOverride> {
  const out: Record<string, InspectionOverride> = {};
  for (const [id, v] of Object.entries(obj(raw))) {
    const o = obj(v);
    const entry: InspectionOverride = {};
    if (typeof o.enabled === "boolean") entry.enabled = o.enabled;
    if (typeof o.severity === "string" && LEVELS.has(o.severity)) entry.severity = o.severity as InspectionLevel;
    const options = Object.entries(obj(o.options)).filter(([, v]) => typeof v === "boolean");
    if (options.length) entry.options = Object.fromEntries(options) as Record<string, boolean>;
    if (id && Object.keys(entry).length) out[id] = entry;
  }
  return out;
}

function validateCustom(raw: unknown): Record<string, CustomProfile> {
  const out: Record<string, CustomProfile> = {};
  for (const [key, v] of Object.entries(obj(raw))) {
    const o = obj(v);
    if (!key.trim()) continue;
    const name = typeof o.name === "string" && o.name.trim() ? o.name.trim() : key;
    out[key] = { name, overrides: validateOverrides(o.overrides) };
  }
  return out;
}

const CUSTOM_ID = /^(ide|project):(.+)$/;

export function validateInspections(raw: unknown): InspectionSettingsValid {
  const r = obj(raw);
  const profile =
    typeof r.profile === "string" && (r.profile === "project" || CUSTOM_ID.test(r.profile)) ? r.profile : "default";
  return {
    profile,
    default: validateOverrides(r.default),
    project: validateOverrides(r.project),
    ideProfiles: validateCustom(r.ideProfiles),
    projectProfiles: validateCustom(r.projectProfiles),
  };
}

/** Where a profile is stored: its level, and its key among that level's copies (null for the two defaults). */
export function profileLocation(id: ProfileId): { level: ProfileLevel; key: string | null } {
  if (id === "project") return { level: "project", key: null };
  const m = CUSTOM_ID.exec(id);
  if (!m) return { level: "ide", key: null };
  return { level: m[1] as ProfileLevel, key: m[2]! };
}

export const customProfileId = (level: ProfileLevel, key: string): ProfileId => `${level}:${key}`;

function customOf(s: InspectionSettingsValid, id: ProfileId): CustomProfile | undefined {
  const { level, key } = profileLocation(id);
  if (key === null) return undefined;
  return (level === "ide" ? s.ideProfiles : s.projectProfiles)[key];
}

/** Whether profile `id` exists (project-level ones only with a project open). */
export function profileExists(s: InspectionSettingsValid, id: ProfileId, hasProject: boolean): boolean {
  if (id === "default") return true;
  if (profileLocation(id).level === "project" && !hasProject) return false;
  return id === "project" || !!customOf(s, id);
}

/** The profile chosen, if it exists here; else `Default`. */
export function effectiveProfileId(s: InspectionSettingsValid, hasProject: boolean): ProfileId {
  return profileExists(s, s.profile, hasProject) ? s.profile : "default";
}

export function profileLabel(s: InspectionSettingsValid, id: ProfileId): string {
  if (id === "default" || id === "project") return PROFILE_LABELS[id];
  return customOf(s, id)?.name ?? id;
}

/** Overrides of profile `id` (empty when it does not exist). */
export function overridesOf(s: InspectionSettingsValid, id: ProfileId): ProfileOverrides {
  if (id === "default") return s.default;
  if (id === "project") return s.project;
  return customOf(s, id)?.overrides ?? {};
}

export interface ProfileEntry {
  id: ProfileId;
  label: string;
  level: ProfileLevel;
}

/** Profiles to choose from: project level first (with a project), then IDE level; copies by name. */
export function listProfiles(s: InspectionSettingsValid, hasProject: boolean): ProfileEntry[] {
  const copies = (level: ProfileLevel, map: CustomProfiles): ProfileEntry[] =>
    Object.entries(map)
      .map(([key, p]) => ({ id: customProfileId(level, key), label: p.name, level }))
      .sort((a, b) => a.label.localeCompare(b.label));
  const project: ProfileEntry[] = hasProject
    ? [{ id: "project", label: PROFILE_LABELS.project, level: "project" }, ...copies("project", s.projectProfiles)]
    : [];
  return [...project, { id: "default", label: PROFILE_LABELS.default, level: "ide" }, ...copies("ide", s.ideProfiles)];
}

/** Error text for a proposed profile name, or null when valid (names are unique per level). */
export function validateProfileName(
  name: string,
  level: ProfileLevel,
  s: InspectionSettingsValid,
  ownId?: ProfileId,
): string | null {
  const n = name.trim();
  if (!n) return "Profile name cannot be empty";
  const taken = listProfiles(s, true).some((p) => p.level === level && p.id !== ownId && p.label === n);
  return taken ? `A profile named '${n}' already exists` : null;
}

/** `<name> copy`, numbered when taken at `level`. */
export function copyProfileName(name: string, level: ProfileLevel, s: InspectionSettingsValid): string {
  const base = `${name} copy`;
  if (!validateProfileName(base, level, s)) return base;
  for (let i = 2; ; i++) if (!validateProfileName(`${base} ${i}`, level, s)) return `${base} ${i}`;
}

/** A fresh storage key for a copy named `name` among `existing`. */
export function newProfileKey(name: string, existing: CustomProfiles): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "profile";
  if (!existing[slug]) return slug;
  for (let i = 2; ; i++) if (!existing[`${slug}-${i}`]) return `${slug}-${i}`;
}

// --- inspection identity -----------------------------------------------------

/** A checkbox in the inspection's Options (Settings › Editor › Inspections). */
export interface InspectionOptionSpec {
  key: string;
  label: string;
  default: boolean;
}

export interface BuiltinInspection {
  id: string;
  /** Producer key the diagnostics arrive under. */
  producer: string;
  name: string;
  group: string;
  description: string;
  /** Highlighting level when the profile sets none (else as reported). */
  defaultLevel?: InspectionLevel;
  options?: readonly InspectionOptionSpec[];
}

/** Producer key of the Typo inspection's diagnostics. */
export const SPELLING_PRODUCER = "spelling";
export const SPELLING_INSPECTION = "builtin:spelling";

/** IDEA's Typo options: which parts of source files are checked (plain text always is). */
export const SPELLING_OPTIONS = {
  code: "processCode",
  literals: "processLiterals",
  comments: "processComments",
} as const;

/** Checks the IDE runs itself (not a language server). */
export const BUILTIN_INSPECTIONS: readonly BuiltinInspection[] = [
  {
    id: "builtin:file-references",
    producer: "file-references",
    name: "Unresolved file references",
    group: "General",
    description:
      "Reports paths in HTML attributes, CSS url() and @import that do not name an existing file, resolved relative to the file, the project root and its resource roots.",
  },
  {
    id: "builtin:build",
    producer: "build",
    name: "Build problems",
    group: "General",
    description: "Compiler errors and warnings of the last Build Project, shown at their source positions.",
  },
  {
    id: "builtin:sql",
    producer: "sql-inspections",
    name: "Unresolved database references",
    group: "SQL",
    description:
      "Reports tables, columns and aliases in query consoles that the data source's schema does not contain.",
  },
  {
    id: SPELLING_INSPECTION,
    producer: SPELLING_PRODUCER,
    name: "Typo",
    group: "Proofreading",
    description:
      "Reports misspelt words in comments, string literals and the names declarations introduce (camelCase and snake_case parts checked separately), and in plain text and Markdown. Agent nouns of known words (checkpointer) and, in names, two known words run together (filepath) are accepted. Words can be saved to the project or application dictionary (Editor › Natural Languages › Spelling). Correcting a name renames the symbol and its references.",
    defaultLevel: "typo",
    options: [
      { key: SPELLING_OPTIONS.code, label: "Process code", default: true },
      { key: SPELLING_OPTIONS.literals, label: "Process literals", default: true },
      { key: SPELLING_OPTIONS.comments, label: "Process comments", default: true },
    ],
  },
];

const BUILTIN_BY_PRODUCER = new Map(BUILTIN_INSPECTIONS.map((b) => [b.producer, b]));
const BUILTIN_BY_ID = new Map(BUILTIN_INSPECTIONS.map((b) => [b.id, b]));

/** Option `key` of inspection `id` under `profile` (its default when unset). */
export function inspectionOption(profile: ProfileOverrides, id: string, key: string): boolean {
  const value = profile[id]?.options?.[key];
  if (typeof value === "boolean") return value;
  return BUILTIN_BY_ID.get(id)?.options?.find((o) => o.key === key)?.default ?? true;
}

/** The inspection a diagnostic of `producer` belongs to: its code's own when it has one. */
export interface InspectionRef {
  id: string;
  name: string;
}

export function diagnosticInspection(producer: string, d: Pick<Diagnostic, "code">): InspectionRef | null {
  if (!producer) return null;
  const builtin = BUILTIN_BY_PRODUCER.get(producer);
  if (builtin) return { id: builtin.id, name: builtin.name };
  const base = producerInspectionId(producer);
  return d.code ? { id: codeInspectionId(base, d.code), name: `${producer} ${d.code}` } : { id: base, name: producer };
}

/** Inspection id of everything a producer reports. */
export function producerInspectionId(producer: string): string {
  return BUILTIN_BY_PRODUCER.get(producer)?.id ?? `lsp:${producer}`;
}

export const codeInspectionId = (base: string, code: string) => `${base}:${code}`;

/** Producer of a diagnostic: the reporting server, else the event's producer, else its `source`. */
export function producerOf(d: Diagnostic, fallback?: string): string {
  return d.server ?? fallback ?? d.source ?? "";
}

/** Set on diagnostics shown at the Typo level (rendered as a typo, not a weak warning). */
export interface TypoStyled {
  typo?: boolean;
}

export const isTypoStyled = (d: object): boolean => (d as TypoStyled).typo === true;

/**
 * `items` of `producer` under `profile`: disabled inspections dropped, severity
 * overrides applied (a code's own override wins over its server's, which wins
 * over a built-in check's default level). Returns `items` itself when the
 * profile changes nothing.
 */
export function applyProfile<D extends Diagnostic>(
  profile: ProfileOverrides,
  producer: string,
  items: readonly D[],
): readonly D[] {
  const base = producerInspectionId(producer);
  const own = profile[base];
  if (own?.enabled === false) return [];
  const fallback = BUILTIN_BY_PRODUCER.get(producer)?.defaultLevel;
  let changed = false;
  const out: D[] = [];
  for (const d of items) {
    const code = d.code ? profile[codeInspectionId(base, d.code)] : undefined;
    if (code?.enabled === false) {
      changed = true;
      continue;
    }
    const level = code?.severity ?? own?.severity ?? fallback;
    const severity = level ? levelSeverity(level) : d.severity;
    if (level === "typo") {
      changed = true;
      out.push({ ...d, severity, typo: true });
    } else if (severity !== d.severity) {
      changed = true;
      out.push({ ...d, severity });
    } else {
      out.push(d);
    }
  }
  return changed ? out : items;
}

/** Applies `profile` to diagnostics of mixed producers (Inspect Code results). */
export function applyProfileMixed<D extends Diagnostic>(profile: ProfileOverrides, items: readonly D[]): D[] {
  const byProducer = new Map<string, D[]>();
  for (const d of items) {
    const p = producerOf(d);
    let list = byProducer.get(p);
    if (!list) byProducer.set(p, (list = []));
    list.push(d);
  }
  return [...byProducer].flatMap(([p, list]) => applyProfile(profile, p, list));
}

// --- profile in effect --------------------------------------------------------

let cache: { raw: unknown; hasProject: boolean; id: ProfileId; value: ProfileOverrides } | null = null;

function current(): { id: ProfileId; value: ProfileOverrides } {
  const { settings, project } = useProject.getState();
  const raw = obj(settings).inspections;
  const hasProject = !!project;
  if (cache && cache.raw === raw && cache.hasProject === hasProject) return cache;
  const valid = validateInspections(raw);
  const id = effectiveProfileId(valid, hasProject);
  cache = { raw, hasProject, id, value: overridesOf(valid, id) };
  return cache;
}

/** Overrides of the profile in effect. */
export function inspectionProfile(): ProfileOverrides {
  return current().value;
}

export function activeProfileId(): ProfileId {
  return current().id;
}

/** Overrides of a named profile from the effective settings. */
export function profileOverrides(id: ProfileId): ProfileOverrides {
  return overridesOf(inspectionSettings(), id);
}

/** Validated inspection settings (effective). */
export function inspectionSettings(): InspectionSettingsValid {
  return validateInspections(obj(useProject.getState().settings).inspections);
}

/** Calls `listener` whenever the profile in effect changes (its content, not just identity). */
export function subscribeInspectionProfile(listener: () => void): () => void {
  let last = JSON.stringify(inspectionProfile());
  return useProject.subscribe((s, prev) => {
    if (s.settings === prev.settings && s.project === prev.project) return;
    const next = JSON.stringify(inspectionProfile());
    if (next === last) return;
    last = next;
    listener();
  });
}

// --- diagnostic codes seen ----------------------------------------------------

/** A diagnostic code met at runtime, offered as its own inspection in Settings. */
export interface SeenCode {
  producer: string;
  code: string;
  source: string;
  sample: string;
}

const SEEN_KEY = "openidea.inspections.seenCodes";
const SEEN_LIMIT = 500;
let seen: Map<string, SeenCode> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function loadSeen(): Map<string, SeenCode> {
  if (seen) return seen;
  seen = new Map();
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]");
    if (Array.isArray(raw)) {
      for (const e of raw) {
        const o = obj(e);
        if (typeof o.producer === "string" && typeof o.code === "string") {
          seen.set(`${o.producer}\u0000${o.code}`, {
            producer: o.producer,
            code: o.code,
            source: typeof o.source === "string" ? o.source : "",
            sample: typeof o.sample === "string" ? o.sample : "",
          });
        }
      }
    }
  } catch {
    // Unavailable storage: the list lives for this session only.
  }
  return seen;
}

/** Records the codes of a producer's diagnostics (persisted, shared with the Settings window). */
export function noteDiagnosticCodes(producer: string, items: readonly Diagnostic[]) {
  if (!producer) return;
  const map = loadSeen();
  let added = false;
  for (const d of items) {
    if (!d.code) continue;
    const key = `${producer}\u0000${d.code}`;
    if (map.has(key)) continue;
    map.set(key, { producer, code: d.code, source: d.source ?? "", sample: d.message.slice(0, 200) });
    added = true;
  }
  if (!added) return;
  while (map.size > SEEN_LIMIT) map.delete(map.keys().next().value!);
  saveTimer ??= setTimeout(() => {
    saveTimer = null;
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify([...map.values()]));
    } catch {
      // Ignored: see loadSeen.
    }
  }, 1000);
}

/** Codes seen in any window (re-read from storage, merged with this window's unsaved ones). */
export function seenDiagnosticCodes(): SeenCode[] {
  const mine = seen;
  seen = null;
  const map = loadSeen();
  for (const [k, v] of mine ?? []) if (!map.has(k)) map.set(k, v);
  return [...map.values()];
}
