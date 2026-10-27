/**
 * IDEA's inspection controls, offered wherever a problem is shown (⌥↵ submenu
 * of an inspection's fixes, Problems, Inspection Results): Edit inspection
 * profile setting, Disable inspection, change its severity. Every change is
 * written to the inspection profile in effect, at the level it is stored.
 */
import { executeAction } from "./actions";
import { call, commands } from "./ipc";
import { useProject } from "./project";
import {
  INSPECTION_LEVELS,
  activeProfileId,
  inspectionProfile,
  inspectionSettings,
  profileLocation,
  type InspectionLevel,
  type InspectionOverride,
  type InspectionRef,
  type ProfileOverrides,
} from "./inspections";

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

/** `undefined` restores the inspection's default level. */
export const setInspectionSeverity = (id: string, level: InspectionLevel | undefined) =>
  updateInspection(id, (o) => ({ ...o, severity: level }));

export const setInspectionOption = (id: string, option: string, value: boolean) =>
  updateInspection(id, (o) => ({ ...o, options: { ...o.options, [option]: value } }));

/** Settings › Editor › Inspections with the inspection selected. */
export function editInspectionSettings(id: string) {
  void executeAction("file.settings", `editor.inspections#${id}`);
}

const report = (p: Promise<unknown>) => void p.catch((e) => console.warn("[inspections]", e));

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
  ];
}

/** Problems / Inspection Results context menu rows for a problem's inspection. */
export function problemControls(inspection: InspectionRef): ControlItem[] {
  const current = inspectionProfile()[inspection.id]?.severity;
  return [
    {
      id: "inspection.disable",
      label: `Disable Inspection '${inspection.name}'`,
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
      id: "inspection.edit",
      label: "Edit Inspection Profile Setting…",
      icon: "settings",
      run: () => editInspectionSettings(inspection.id),
    },
  ];
}
