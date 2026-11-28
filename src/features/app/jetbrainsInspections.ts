/**
 * JetBrains inspection profiles (`inspection/*.xml`) → OpenIDEA's. `Default` updates the
 * `Default` profile; any other profile becomes an IDE-level copy of the same name. Only
 * inspections OpenIDEA has a counterpart for are carried over; the rest are listed.
 */
import {
  BUILTIN_INSPECTIONS,
  customProfileId,
  CUCUMBER_UNDEFINED_STEP_INSPECTION,
  JAVA_SERIAL_VERSION_INSPECTION,
  PYTHON_REQUIREMENTS_INSPECTION,
  SPELLING_INSPECTION,
  SPELLING_OPTIONS,
  newProfileKey,
  validateInspections,
  type CustomProfiles,
  type InspectionLevel,
  type InspectionOverride,
} from "@/platform/inspections";

/** JetBrains inspection short name → OpenIDEA inspection id. */
const BY_SHORT_NAME = new Map<string, string>([
  ["SpellCheckingInspection", SPELLING_INSPECTION],
  ["PyPackageRequirementsInspection", PYTHON_REQUIREMENTS_INSPECTION],
  ["SerializableHasSerialVersionUIDField", JAVA_SERIAL_VERSION_INSPECTION],
  ["CucumberUndefinedStep", CUCUMBER_UNDEFINED_STEP_INSPECTION],
  // PyCharm's short names are the `# noinspection` id plus "Inspection".
  ...BUILTIN_INSPECTIONS.flatMap((b) => (b.suppressId ? [[`${b.suppressId}Inspection`, b.id] as const] : [])),
]);

/** pycodestyle and pep8-naming codes PyCharm ignores; Ruff and pylsp report them under the same codes. */
const CODE_LISTS = new Set(["PyPep8Inspection", "PyPep8NamingInspection"]);
const CODE_SERVERS = ["lsp:ruff", "lsp:pylsp"];

const LEVELS: Record<string, InspectionLevel> = {
  ERROR: "error",
  WARNING: "warning",
  "WEAK WARNING": "weakWarning",
  "SERVER PROBLEM": "serverProblem",
  TYPO: "typo",
  INFORMATION: "none",
  INFO: "none",
  "TEXT ATTRIBUTES": "none",
};

const SPELLING_KEYS = new Set<string>(Object.values(SPELLING_OPTIONS));

export interface JetBrainsInspectionsImport {
  /** Writes to the global layer: `inspections.default` and/or `inspections.ideProfiles`. */
  writes: [key: string, value: unknown][];
  /**
   * Profile name → inspections carried over; `id` of a named profile (`ide:<key>`), and
   * whether it replaces an IDE profile of the same name.
   */
  profiles: { name: string; count: number; id?: string; replaces?: boolean }[];
  /** Inspections (and parts of them) with no counterpart here. */
  unmapped: string[];
  invalid: string[];
}

const attr = (el: Element, name: string) => el.getAttribute(name) ?? undefined;

/** Adds the tool's overrides to `out`; whether anything of it was carried over. */
function parseTool(tool: Element, out: Record<string, InspectionOverride>, unmapped: Set<string>): boolean {
  const name = attr(tool, "class");
  if (!name) return false;
  for (const scope of Array.from(tool.children).filter((c) => c.tagName === "scope"))
    unmapped.add(`${name} (${attr(scope, "name") ?? "scope"})`);
  // With scopes, `enabled_by_default` is "everywhere else"; without, it equals `enabled`.
  const on = attr(tool, "enabled_by_default") ?? attr(tool, "enabled");
  const enabled = on === undefined ? undefined : on === "true";
  const level = attr(tool, "level");
  const severity = LEVELS[level ?? ""];
  // A severity defined in the JetBrains IDE (Settings › Editor › Inspections › Severities).
  if (level && !severity) unmapped.add(`${name} (${level})`);
  const options = Array.from(tool.children).filter((c) => c.tagName === "option");

  if (CODE_LISTS.has(name)) {
    const list = options.find((o) => attr(o, "name") === "ignoredErrors");
    const codes = Array.from(list?.querySelectorAll("list > option") ?? []).map((o) => attr(o, "value") ?? "");
    let mapped = false;
    for (const code of codes) {
      if (!/^[EWN]\d{3}$/.test(code)) {
        unmapped.add(`${name}: ${code}`);
        continue;
      }
      for (const server of CODE_SERVERS) out[`${server}:${code}`] = { enabled: false };
      mapped = true;
    }
    if (enabled === false) unmapped.add(name);
    return mapped;
  }

  const id = BY_SHORT_NAME.get(name);
  if (!id) {
    unmapped.add(name);
    return false;
  }
  const entry: InspectionOverride = {};
  if (enabled !== undefined) entry.enabled = enabled;
  if (severity) entry.severity = severity;
  if (id === SPELLING_INSPECTION) {
    const flags = options.filter((o) => SPELLING_KEYS.has(attr(o, "name") ?? "") && attr(o, "value") !== undefined);
    if (flags.length)
      entry.options = Object.fromEntries(flags.map((o) => [attr(o, "name"), attr(o, "value") === "true"]));
  }
  if (!Object.keys(entry).length) return false;
  out[id] = entry;
  return true;
}

/** `files`: the bundle's `inspection/*.xml`; `current`: the global `inspections` setting. */
export function parseJetBrainsInspections(files: Record<string, string>, current: unknown): JetBrainsInspectionsImport {
  const settings = validateInspections(current);
  let defaults = settings.default;
  let customs: CustomProfiles = settings.ideProfiles;
  const result: JetBrainsInspectionsImport = { writes: [], profiles: [], unmapped: [], invalid: [] };
  const unmapped = new Set<string>();
  for (const [file, text] of Object.entries(files)) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    // App-level files are a bare <profile>; project ones wrap it in a <component>.
    const profile = doc.querySelector("parsererror") ? null : doc.querySelector("profile");
    if (!profile) {
      result.invalid.push(file.slice(file.lastIndexOf("/") + 1));
      continue;
    }
    const named = Array.from(profile.children).find((c) => c.tagName === "option" && attr(c, "name") === "myName");
    const name = (named && attr(named, "value")?.trim()) || file.replace(/^.*\/|\.xml$/g, "");
    const overrides: Record<string, InspectionOverride> = {};
    let count = 0;
    for (const tool of Array.from(profile.children))
      if (tool.tagName === "inspection_tool" && parseTool(tool, overrides, unmapped)) count++;
    if (name === "Default") {
      defaults = { ...defaults, ...overrides };
      result.profiles.push({ name, count });
    } else {
      // Replaces an earlier import of the same profile instead of adding a second one.
      const existing = Object.entries(customs).find(([, p]) => p.name === name)?.[0];
      const key = existing ?? newProfileKey(name, customs);
      customs = { ...customs, [key]: { name, overrides } };
      const replaces = !!existing && !!settings.ideProfiles[existing];
      result.profiles.push({ name, count, id: customProfileId("ide", key), replaces });
    }
  }
  if (defaults !== settings.default) result.writes.push(["inspections.default", defaults]);
  if (customs !== settings.ideProfiles) result.writes.push(["inspections.ideProfiles", customs]);
  result.unmapped = [...unmapped];
  return result;
}
