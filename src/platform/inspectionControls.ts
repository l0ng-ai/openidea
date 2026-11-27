/**
 * IDEA's inspection controls, offered wherever a problem is shown (⌥↵ submenu
 * of an inspection's fixes, Problems, Inspection Results): Edit inspection
 * profile setting, Disable inspection, change its severity, and the producer's
 * suppressed-rule list. Every change is written to the inspection profile in
 * effect, at the level it is stored.
 */
import { executeAction } from "./actions";
import { call, commands } from "./ipc";
import { useProject } from "./project";
import {
  BUILTIN_INSPECTIONS,
  INSPECTION_LEVELS,
  activeProfileId,
  codeInspectionId,
  inspectionProfile,
  inspectionSettings,
  profileLocation,
  type InspectionLevel,
  type InspectionOverride,
  type InspectionRef,
  type ProfileOverrides,
} from "./inspections";
import { tx, txPart } from "@/platform/i18n";

/** Menu rows (structurally `@/ui` `MenuItem`s). */
export type ControlItem =
  | { kind: "separator" }
  | {
      id?: string;
      label: string;
      verbatim?: boolean;
      icon?: string;
      checked?: boolean;
      run?: () => void;
      submenu?: ControlItem[];
    };

/** `overrides` with `patch` applied to inspection `id` (empty entries removed). */
export function patchOverride(
  overrides: ProfileOverrides,
  id: string,
  patch: (o: InspectionOverride) => InspectionOverride,
): Record<string, InspectionOverride> {
  const next: Record<string, InspectionOverride> = { ...overrides };
  const entry: Record<string, unknown> = { ...patch({ ...overrides[id] }) };
  for (const k of Object.keys(entry)) if (entry[k] === undefined) delete entry[k];
  if (Object.keys(entry).length) next[id] = entry as InspectionOverride;
  else delete next[id];
  return next;
}

/** Changes inspection `id` in the profile in effect and stores it. */
export async function updateInspection(id: string, patch: (o: InspectionOverride) => InspectionOverride) {
  const s = inspectionSettings();
  const { level, key } = profileLocation(activeProfileId());
  const scope = level === "project" ? "project" : "global";
  let settingKey: string;
  let value: unknown;
  if (key === null) {
    settingKey = level === "project" ? "inspections.project" : "inspections.default";
    value = patchOverride(level === "project" ? s.project : s.default, id, patch);
  } else {
    const field = level === "project" ? "projectProfiles" : "ideProfiles";
    const profile = s[field][key];
    if (!profile) return;
    settingKey = `inspections.${field}`;
    value = { ...s[field], [key]: { ...profile, overrides: patchOverride(profile.overrides, id, patch) } };
  }
  const settings = await call(commands.settingsSet(scope, settingKey, JSON.stringify(value)));
  useProject.setState({ settings });
}

export const disableInspection = (id: string) => updateInspection(id, (o) => ({ ...o, enabled: false }));

// --- suppressed rules ---------------------------------------------------------

/**
 * The user's own suppression list: the codes of a producer the profile in
 * effect turns off (`lsp:ruff:UP045: {enabled: false}` and friends), managed
 * from the → submenu wherever a problem of that inspection is shown. The
 * editor, Problems and Inspect Code all hide them through `applyProfile`.
 */

/** The inspection a code-level id refines: `lsp:ruff` of `lsp:ruff:UP045`, `builtin:phpstan` of `builtin:phpstan:constant.notFound`. */
function baseInspectionOf(id: string): { base: string; code?: string } {
  for (const b of BUILTIN_INSPECTIONS)
    if (id.startsWith(`${b.id}:`)) return { base: b.id, code: id.slice(b.id.length + 1) };
  const m = /^lsp:([^:]+)(?::(.+))?$/.exec(id);
  return m ? { base: `lsp:${m[1]!}`, code: m[2] } : { base: id };
}

function inspectionBaseName(base: string): string {
  const builtin = BUILTIN_INSPECTIONS.find((b) => b.id === base);
  return builtin?.name ?? (base.startsWith("lsp:") ? base.slice(4) : base);
}

/** The codes of `base` the profile in effect suppresses, sorted. */
function suppressedCodes(base: string): string[] {
  const profile = inspectionProfile();
  const prefix = `${base}:`;
  return Object.keys(profile)
    .filter((k) => k.startsWith(prefix) && profile[k]?.enabled === false)
    .map((k) => k.slice(prefix.length))
    .sort();
}

const report = (p: Promise<unknown>): Promise<void> =>
  p.then(
    () => undefined,
    (e) => console.warn("[inspections]", e),
  );

/** Enables or disables the code's rule, keeping its other overrides. */
function toggleRule(id: string): Promise<void> {
  return updateInspection(id, (o) => (o.enabled === false ? { ...o, enabled: undefined } : { ...o, enabled: false }));
}

/** Asks for a code and writes its rule to the profile in effect. */
async function addSuppressedRule(base: string, initial?: string): Promise<void> {
  // The input dialog lives above the platform layer; loaded only on use.
  const { promptInput } = await import("@/workbench/inputDialogs");
  const code = await promptInput({
    title: tx`Add rule for ${txPart(inspectionBaseName(base))}`,
    label: tx("Rule:"),
    initial,
    hint: tx("One code per rule, for example UP045. The rule is written to the inspection profile in effect."),
    validate: (value) => {
      const code = value.trim();
      if (!code) return tx("Value must not be empty");
      if (/\s/.test(code)) return tx("Codes contain no spaces");
      return inspectionProfile()[codeInspectionId(base, code)]?.enabled === false
        ? tx`Rule '${txPart(code)}' is already in the list`
        : null;
    },
  });
  if (!code) return;
  await updateInspection(codeInspectionId(base, code), (o) => ({ ...o, enabled: false }));
}

/**
 * The → submenu rows of the producer behind inspection `inspectionId`: the
 * codes the profile in effect suppresses (checked; unchecking removes the
 * rule), then Add rule… to suppress a code before it has ever reported.
 */
export function suppressedRuleControls(inspectionId: string): ControlItem[] {
  const { base, code } = baseInspectionOf(inspectionId);
  return [
    { kind: "separator" },
    ...suppressedCodes(base).map((c): ControlItem => ({
      id: `inspection.rule.${c}`,
      label: c,
      verbatim: true,
      checked: true,
      run: () => report(toggleRule(codeInspectionId(base, c))),
    })),
    { id: "inspection.rule.add", label: "Add rule…", icon: "plus", run: () => report(addSuppressedRule(base, code)) },
  ];
}

/** `undefined` restores the inspection's default level. */
export const setInspectionSeverity = (id: string, level: InspectionLevel | undefined) =>
  updateInspection(id, (o) => ({ ...o, severity: level }));

export const setInspectionOption = (id: string, option: string, value: boolean) =>
  updateInspection(id, (o) => ({ ...o, options: { ...o.options, [option]: value } }));

/** Settings › Editor › Inspections with the inspection selected. */
export function editInspectionSettings(id: string) {
  void executeAction("file.settings", `editor.inspections#${id}`);
}

/** ⌥↵ submenu of an inspection's fix (IDEA's right-arrow menu). */
export function intentionControls(inspection: InspectionRef): ControlItem[] {
  return [
    {
      id: "inspection.edit",
      label: "Edit inspection profile setting",
      icon: "settings",
      run: () => editInspectionSettings(inspection.id),
    },
    {
      id: "inspection.disable",
      label: "Disable inspection",
      run: () => report(disableInspection(inspection.id)),
    },
    ...suppressedRuleControls(inspection.id),
  ];
}

/** Problems / Inspection Results context menu rows for a problem's inspection. */
export function problemControls(inspection: InspectionRef): ControlItem[] {
  const current = inspectionProfile()[inspection.id]?.severity;
  return [
    {
      id: "inspection.disable",
      label: tx`Disable Inspection '${txPart(inspection.name)}'`,
      verbatim: true,
      run: () => report(disableInspection(inspection.id)),
    },
    {
      id: "inspection.severity",
      label: "Change Severity",
      submenu: [
        {
          id: "severity.default",
          label: "Default",
          checked: current === undefined,
          run: () => report(setInspectionSeverity(inspection.id, undefined)),
        },
        ...INSPECTION_LEVELS.map((l) => ({
          id: `severity.${l.value}`,
          label: l.label,
          checked: current === l.value,
          run: () => report(setInspectionSeverity(inspection.id, l.value)),
        })),
      ],
    },
    {
      id: "inspection.rules",
      label: "Suppressed rules",
      icon: "filter",
      submenu: suppressedRuleControls(inspection.id),
    },
    {
      id: "inspection.edit",
      label: "Edit Inspection Profile Setting…",
      icon: "settings",
      run: () => editInspectionSettings(inspection.id),
    },
  ];
}
