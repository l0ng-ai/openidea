/**
 * Settings › Languages & Frameworks › PHP › Inspections: the built-in PHP
 * engine's inspections, each turned on or off, with its severity and (for
 * the call and type checks) strict mode. They are stored in the inspection
 * profile in effect (`lsp:php:<Id>`), the same settings Editor › Inspections
 * shows under PHP › Built-in engine, so the editor, Problems and Inspect Code
 * apply them and the engine stops running what is turned off.
 */
import { Checkbox, T } from "@/ui";
import {
  PHP_STRICT_OPTION_SPEC,
  effectiveProfileId,
  inspectionOption,
  overridesOf,
  profileLabel,
  profileLocation,
  type CustomProfiles,
  type InspectionLevel,
  type InspectionSettingsValid,
  type ProfileId,
  type ProfileOverrides,
} from "@/platform/inspections";
import { PHP_INSPECTIONS, PHP_INSPECTION_GROUPS, phpInspectionId, type PhpInspection } from "@/platform/phpInspections";
import { useProject } from "@/platform/project";
import { tx } from "@/platform/i18n";
import { Row, Section, Select } from "../components/Form";
import { useSetting } from "../components/context";
import { useSettingsDialog } from "../model/staging";
import {
  AS_REPORTED,
  LEVEL_OPTIONS,
  isEnabled,
  setEnabled,
  setLevel,
  setOption,
  withProfileOverrides,
} from "../pages/editor/inspectionsModel";
import styles from "./Sdk.module.css";

/** The profile in effect, its overrides and a setter (as Editor › Inspections stores them). */
function useProfileOverrides(): {
  label: string;
  level: "ide" | "project";
  overrides: ProfileOverrides;
  setOverrides: (o: ProfileOverrides) => void;
} {
  const hasProject = useProject((s) => !!s.project);
  const newProjects = useSettingsDialog((s) => s.newProjects);
  const [chosen] = useSetting<ProfileId>("inspections.profile", "project");
  const [ideOverrides, setIde] = useSetting<ProfileOverrides>("inspections.default", "global");
  const [projectOverrides, setProject] = useSetting<ProfileOverrides>("inspections.project", "project");
  const [ideProfiles, setIdeProfiles] = useSetting<CustomProfiles>("inspections.ideProfiles", "global");
  const [projectProfiles, setProjectProfiles] = useSetting<CustomProfiles>("inspections.projectProfiles", "project");
  const settings: InspectionSettingsValid = {
    profile: chosen,
    default: ideOverrides ?? {},
    project: projectOverrides ?? {},
    ideProfiles: ideProfiles ?? {},
    projectProfiles: projectProfiles ?? {},
  };
  const id = effectiveProfileId(settings, hasProject && !newProjects);
  const setOverrides = (o: ProfileOverrides) => {
    const next = withProfileOverrides(settings, id, o);
    if (next.default !== settings.default) setIde(next.default);
    if (next.project !== settings.project) setProject(next.project);
    if (next.ideProfiles !== settings.ideProfiles) setIdeProfiles(next.ideProfiles);
    if (next.projectProfiles !== settings.projectProfiles) setProjectProfiles(next.projectProfiles);
  };
  return {
    label: profileLabel(settings, id),
    level: profileLocation(id).level,
    overrides: overridesOf(settings, id),
    setOverrides,
  };
}

/** Turns an inspection on or off (on is the default, so it drops the override). */
export function setPhpInspectionEnabled(o: ProfileOverrides, code: string, enabled: boolean): ProfileOverrides {
  const id = phpInspectionId(code);
  return setEnabled(o, { key: id, id, name: code, description: "", children: [] }, enabled);
}

function InspectionRow({
  inspection,
  overrides,
  onChange,
}: {
  inspection: PhpInspection;
  overrides: ProfileOverrides;
  onChange: (o: ProfileOverrides) => void;
}) {
  const id = phpInspectionId(inspection.code);
  const enabled = isEnabled(overrides, id) && isEnabled(overrides, "lsp:php");
  return (
    <Row label={inspection.name} hint={inspection.description}>
      <span className={styles.pathRow}>
        <Checkbox
          checked={enabled}
          onChange={(on) => onChange(setPhpInspectionEnabled(overrides, inspection.code, on))}
          aria-label={tx`Enable ${inspection.name}`}
        />
        <Select
          value={overrides[id]?.severity ?? AS_REPORTED}
          options={LEVEL_OPTIONS}
          disabled={!enabled}
          onChange={(v) => onChange(setLevel(overrides, id, v === AS_REPORTED ? undefined : (v as InspectionLevel)))}
          aria-label={tx`Severity of ${inspection.name}`}
        />
        {inspection.strict && (
          <Checkbox
            label={<T>Strict</T>}
            checked={inspectionOption(overrides, id, PHP_STRICT_OPTION_SPEC.key)}
            disabled={!enabled}
            onChange={(on) => onChange(setOption(overrides, id, PHP_STRICT_OPTION_SPEC.key, on))}
            aria-label={tx`Strict mode for ${inspection.name}`}
          />
        )}
      </span>
    </Row>
  );
}

export function PhpInspectionsPage() {
  const { label, level, overrides, setOverrides } = useProfileOverrides();
  const engineOff = !isEnabled(overrides, "lsp:php");
  return (
    <div className={styles.page}>
      <p className={styles.note}>
        {level === "project"
          ? tx`These inspections run with the built-in engine (Code insight engine: Built-in). Changes are stored in the inspection profile in effect, ${label} (Project), which Editor › Inspections edits too.`
          : tx`These inspections run with the built-in engine (Code insight engine: Built-in). Changes are stored in the inspection profile in effect, ${label} (IDE), which Editor › Inspections edits too.`}
      </p>
      {engineOff && (
        <p className={styles.note}>
          <T>The profile turns off every problem of the built-in engine. Turn it on again in Editor › Inspections.</T>
        </p>
      )}
      <p className={styles.note}>
        <T>
          Strict also reports possible type mismatches against PHPDoc types, as warnings. Without it, only values that
          certainly fail at runtime are reported.
        </T>
      </p>
      {PHP_INSPECTION_GROUPS.map((group) => (
        <Section key={group} title={group}>
          {PHP_INSPECTIONS.filter((i) => i.group === group).map((i) => (
            <InspectionRow key={i.code} inspection={i} overrides={overrides} onChange={setOverrides} />
          ))}
        </Section>
      ))}
    </div>
  );
}
