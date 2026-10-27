/**
 * Editor › Inspections: IDEA's inspection profile editor. `Default` is stored
 * in the IDE settings, `Project Default` in the project; copies (gear menu:
 * Duplicate / Copy to IDE·Project / Rename / Delete) at either level. The
 * chosen one is in effect for the project (editor highlighting, Problems,
 * Inspect Code).
 */
import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from "react";
import clsx from "clsx";
import { commands, isTauri } from "@/platform/ipc";
import {
  BUILTIN_INSPECTIONS,
  copyProfileName,
  effectiveProfileId,
  inspectionOption,
  listProfiles,
  overridesOf,
  profileLabel,
  profileLocation,
  seenDiagnosticCodes,
  validateProfileName,
  type CustomProfiles,
  type InspectionLevel,
  type InspectionSettingsValid,
  type ProfileId,
  type ProfileLevel,
  type ProfileOverrides,
} from "@/platform/inspections";
import { confirm } from "@/workbench/messages";
import {
  Checkbox,
  Dialog,
  IconButton,
  Input,
  SearchField,
  Select,
  T,
  Tree,
  showContextMenu,
  type MenuItem,
  type TreeHandle,
} from "@/ui";
import { useSetting } from "../../components/context";
import { useSettingsDialog } from "../../model/staging";
import { useProject } from "@/platform/project";
import type { PageSpec } from "../spec";
import {
  AS_REPORTED,
  INSPECTION_KEYWORDS,
  LEVEL_OPTIONS,
  buildInspectionTree,
  checkState,
  copyProfile,
  deleteProfile,
  filterInspectionTree,
  isEnabled,
  pathToInspection,
  setEnabled,
  setOption,
  renameProfile,
  setLevel,
  withProfileOverrides,
  type InspectionNode,
  type LanguageServers,
} from "./inspectionsModel";
import styles from "./Inspections.module.css";

let languagesCache: LanguageServers[] | null = null;

async function loadLanguages(): Promise<LanguageServers[]> {
  if (languagesCache) return languagesCache;
  if (!isTauri()) return [];
  const list = await commands.languages();
  languagesCache = list.map((l) => ({ name: l.name, servers: l.languageServers ?? [] }));
  return languagesCache;
}

function useLanguages(): LanguageServers[] {
  const [langs, setLangs] = useState<LanguageServers[]>(() => languagesCache ?? []);
  useEffect(() => {
    let alive = true;
    void loadLanguages().then(
      (l) => alive && setLangs(l),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);
  return langs;
}

function expandableKeys(nodes: readonly InspectionNode[], out = new Set<string>()): Set<string> {
  for (const n of nodes) {
    if (n.children.length) out.add(n.key);
    expandableKeys(n.children, out);
  }
  return out;
}

function InspectionsPage() {
  const hasProject = useProject((s) => !!s.project);
  const newProjects = useSettingsDialog((s) => s.newProjects);
  const projectAvailable = hasProject && !newProjects;
  const [chosen, setChosen] = useSetting<ProfileId>("inspections.profile", "project");
  const [ideOverrides, setIde] = useSetting<ProfileOverrides>("inspections.default", "global");
  const [projectOverrides, setProject] = useSetting<ProfileOverrides>("inspections.project", "project");
  const [ideProfiles, setIdeProfiles] = useSetting<CustomProfiles>("inspections.ideProfiles", "global");
  const [projectProfiles, setProjectProfiles] = useSetting<CustomProfiles>("inspections.projectProfiles", "project");
  const settings: InspectionSettingsValid = {
    profile: chosen,
    default: ideOverrides,
    project: projectOverrides,
    ideProfiles,
    projectProfiles,
  };
  const profileId = effectiveProfileId(settings, projectAvailable);
  const location = profileLocation(profileId);
  const overrides = overridesOf(settings, profileId);
  const [nameDialog, setNameDialog] = useState<NameDialogState | null>(null);

  /** Stages the parts of `next` that changed. */
  const apply = (next: InspectionSettingsValid) => {
    if (next.default !== settings.default) setIde(next.default);
    if (next.project !== settings.project) setProject(next.project);
    if (next.ideProfiles !== settings.ideProfiles) setIdeProfiles(next.ideProfiles);
    if (next.projectProfiles !== settings.projectProfiles) setProjectProfiles(next.projectProfiles);
    if (next.profile !== settings.profile) setChosen(next.profile);
  };
  const setOverrides = (o: ProfileOverrides) => apply(withProfileOverrides(settings, profileId, o));

  const languages = useLanguages();
  const seen = useMemo(() => seenDiagnosticCodes(), []);
  const tree = useMemo(
    () => buildInspectionTree(languages, seen, [ideOverrides, projectOverrides]),
    [languages, seen, ideOverrides, projectOverrides],
  );
  const [query, setQuery] = useState("");
  const roots = useMemo(() => filterInspectionTree(tree, query), [tree, query]);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());
  const filtering = !!query.trim();
  const expanded = useMemo(() => (filtering ? expandableKeys(roots) : expandedKeys), [filtering, roots, expandedKeys]);
  const [selected, setSelected] = useState<InspectionNode | null>(null);

  // Opened as `editor.inspections#<id>` (Edit inspection profile setting): select that inspection.
  const focus = useSettingsDialog((s) => s.focus);
  const treeRef = useRef<TreeHandle | null>(null);
  const reveal = useRef<string | null>(null);
  useEffect(() => {
    const path = focus ? pathToInspection(tree, focus) : null;
    if (!path) return;
    // Expand first; the effect below selects the row once it is rendered.
    const frame = requestAnimationFrame(() => {
      reveal.current = path[path.length - 1]!;
      setQuery("");
      setExpandedKeys((prev) => new Set([...prev, ...path.slice(0, -1)]));
      useSettingsDialog.setState({ focus: null });
    });
    return () => cancelAnimationFrame(frame);
  }, [focus, tree]);
  useEffect(() => {
    if (!reveal.current) return;
    treeRef.current?.reveal(reveal.current);
    reveal.current = null;
  }, [expanded]);

  const profiles = listProfiles(settings, projectAvailable);
  const profileOptions = profiles.map((p) => ({
    value: p.id,
    label: p.label,
    detail: p.level === "project" ? "Project" : "IDE",
  }));
  const label = profileLabel(settings, profileId);
  const otherLevel: ProfileLevel = location.level === "project" ? "ide" : "project";
  const isCopy = location.key !== null;

  const confirmDelete = async () => {
    if (!(await confirm({ title: "Delete Profile", message: `Delete inspection profile '${label}'?`, ok: "Delete" })))
      return;
    apply(deleteProfile(settings, profileId));
  };

  const gearMenu = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const items: MenuItem[] = [
      {
        label: "Duplicate…",
        icon: "copy",
        run: () =>
          setNameDialog({
            mode: "copy",
            level: location.level,
            initial: copyProfileName(label, location.level, settings),
          }),
      },
      {
        label: otherLevel === "project" ? "Copy to Project…" : "Copy to IDE…",
        disabled: otherLevel === "project" && !projectAvailable,
        run: () =>
          setNameDialog({
            mode: "copy",
            level: otherLevel,
            initial: validateProfileName(label, otherLevel, settings)
              ? copyProfileName(label, otherLevel, settings)
              : label,
          }),
      },
      {
        label: "Rename…",
        icon: "edit",
        disabled: !isCopy,
        run: () => setNameDialog({ mode: "rename", level: location.level, initial: label }),
      },
      { label: "Restore Defaults", icon: "undo", disabled: !Object.keys(overrides).length, run: () => setOverrides({}) },
      // Default and Project Default cannot be deleted.
      ...(isCopy
        ? ([
            { kind: "separator" },
            { label: "Delete", icon: "trash", danger: true, run: () => void confirmDelete() },
          ] satisfies MenuItem[])
        : []),
    ];
    showContextMenu({ x: r.left, y: r.bottom + 2 }, items);
  };

  return (
    <div className={styles.page}>
      <div className={styles.profileRow}>
        <span>
          <T>Profile:</T>
        </span>
        <Select
          className={styles.profileSelect}
          aria-label="Inspection profile"
          value={profileId}
          options={profileOptions}
          onChange={(v) => setChosen(v)}
          disabled={profileOptions.length < 2}
        />
        <IconButton icon="settings" title="Profile Actions" onClick={gearMenu} />
        <span className={styles.profileLevel}><T>{location.level === "project" ? "Stored in Project" : "Stored in IDE"}</T></span>
      </div>

      <div className={styles.toolbar}>
        <SearchField
          className={styles.search}
          value={query}
          onChange={setQuery}
          placeholder="Search inspections"
          aria-label="Search inspections"
        />
        <IconButton icon="expand-all" title="Expand All" onClick={() => setExpandedKeys(expandableKeys(tree))} />
        <IconButton icon="collapse-all" title="Collapse All" onClick={() => setExpandedKeys(new Set())} />
        <IconButton
          icon="refresh"
          title="Reset to Default"
          disabled={!selected?.id || !overrides[selected.id]}
          onClick={() => {
            if (!selected?.id) return;
            const next = { ...overrides };
            delete next[selected.id];
            setOverrides(next);
          }}
        />
      </div>

      <div className={styles.split}>
        <div
          className={styles.treeWrap}
          onKeyDown={(e) => {
            // Space toggles the selected inspection, as in IDEA.
            if (e.key !== " " || !selected || (e.target as HTMLElement).tagName === "INPUT") return;
            e.preventDefault();
            setOverrides(setEnabled(overrides, selected, checkState(overrides, selected) !== "on"));
          }}
        >
          <Tree<InspectionNode>
            aria-label="Inspections"
            handleRef={treeRef}
            roots={roots}
            getKey={(n) => n.key}
            getLabel={(n) => n.name}
            getChildren={(n) => (n.children.length ? n.children : undefined)}
            isExpandable={(n) => n.children.length > 0}
            expanded={expanded}
            onExpandedChange={(_set, node, isExpanded) => {
              if (filtering) return;
              setExpandedKeys((prev) => {
                const next = new Set(prev);
                if (isExpanded) next.add(node.key);
                else next.delete(node.key);
                return next;
              });
            }}
            multiSelect={false}
            speedSearch={false}
            onSelectionChange={(_sel, node) => setSelected(node)}
            renderNode={(n) => (
              <InspectionRow
                node={n}
                overrides={overrides}
                onToggle={(on) => setOverrides(setEnabled(overrides, n, on))}
              />
            )}
            empty={
              <div className={styles.empty}>
                <T>Nothing to show</T>
              </div>
            }
          />
        </div>
        <Details node={selected} overrides={overrides} onChange={setOverrides} />
      </div>

      {nameDialog && (
        <ProfileNameDialog
          title={nameDialog.mode === "rename" ? "Rename Profile" : "Copy Profile"}
          initial={nameDialog.initial}
          validate={(name) =>
            validateProfileName(name, nameDialog.level, settings, nameDialog.mode === "rename" ? profileId : undefined)
          }
          onCancel={() => setNameDialog(null)}
          onSubmit={(name) => {
            apply(
              nameDialog.mode === "rename"
                ? renameProfile(settings, profileId, name)
                : copyProfile(settings, profileId, name, nameDialog.level),
            );
            setNameDialog(null);
          }}
        />
      )}
    </div>
  );
}

interface NameDialogState {
  mode: "copy" | "rename";
  /** Level the (new) profile is stored at. */
  level: ProfileLevel;
  initial: string;
}

function ProfileNameDialog({
  title,
  initial,
  validate,
  onCancel,
  onSubmit,
}: {
  title: string;
  initial: string;
  validate: (name: string) => string | null;
  onCancel: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(initial);
  const id = useId();
  const error = validate(name);
  const submit = () => !error && onSubmit(name.trim());
  return (
    <Dialog
      open
      onClose={onCancel}
      title={title}
      width={380}
      buttons={[
        { label: "OK", role: "default", disabled: !!error, onClick: submit },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.nameBody}>
        <div className={styles.nameRow}>
          <label htmlFor={id}>
            <T>Name:</T>
          </label>
          <Input
            id={id}
            autoFocus
            value={name}
            invalid={!!error}
            onChange={(e) => setName(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
          />
        </div>
        {error && name.trim() !== "" && <div className={styles.nameError}>{error}</div>}
      </div>
    </Dialog>
  );
}

function InspectionRow({
  node,
  overrides,
  onToggle,
}: {
  node: InspectionNode;
  overrides: ProfileOverrides;
  onToggle: (on: boolean) => void;
}) {
  const state = checkState(overrides, node);
  const level = node.id ? overrides[node.id]?.severity : undefined;
  const levelLabel = level ? LEVEL_OPTIONS.find((o) => o.value === level)?.label : undefined;
  return (
    <span className={styles.row}>
      <span className={clsx(styles.name, !node.id && styles.groupName, state === "off" && styles.off)}>
        {node.name}
      </span>
      {levelLabel && <span className={styles.level}>{levelLabel}</span>}
      <span className={styles.check}>
        <Checkbox
          checked={state === "on"}
          indeterminate={state === "mixed"}
          onChange={() => onToggle(state !== "on")}
          aria-label={`Enable ${node.name}`}
        />
      </span>
    </span>
  );
}

function Details({
  node,
  overrides,
  onChange,
}: {
  node: InspectionNode | null;
  overrides: ProfileOverrides;
  onChange: (o: ProfileOverrides) => void;
}) {
  if (!node) {
    return (
      <div className={styles.details}>
        <p className={styles.description}>
          <T>Select an inspection to see its description and change its severity.</T>
        </p>
      </div>
    );
  }
  const id = node.id;
  return (
    <div className={styles.details}>
      <p className={styles.description}>{node.description}</p>
      {id && (
        <div className={styles.severityRow}>
          <span>
            <T>Severity:</T>
          </span>
          <Select
            className={styles.levelSelect}
            aria-label="Severity"
            value={overrides[id]?.severity ?? AS_REPORTED}
            options={LEVEL_OPTIONS}
            disabled={!isEnabled(overrides, id)}
            onChange={(v) => onChange(setLevel(overrides, id, v === AS_REPORTED ? undefined : (v as InspectionLevel)))}
          />
        </div>
      )}
      {id && <InspectionOptions id={id} overrides={overrides} onChange={onChange} />}
    </div>
  );
}

/** The inspection's own options (Typo: Process code / literals / comments). */
function InspectionOptions({
  id,
  overrides,
  onChange,
}: {
  id: string;
  overrides: ProfileOverrides;
  onChange: (o: ProfileOverrides) => void;
}) {
  const specs = BUILTIN_INSPECTIONS.find((b) => b.id === id)?.options;
  if (!specs?.length) return null;
  return (
    <fieldset className={styles.options} disabled={!isEnabled(overrides, id)}>
      <legend>
        <T>Options</T>
      </legend>
      {specs.map((o) => (
        <Checkbox
          key={o.key}
          label={o.label}
          checked={inspectionOption(overrides, id, o.key)}
          onChange={(on) => onChange(setOption(overrides, id, o.key, on))}
        />
      ))}
    </fieldset>
  );
}

export const INSPECTIONS_PAGE: PageSpec = {
  id: "editor.inspections",
  title: "Inspections",
  group: "Editor",
  order: 25,
  keywords: INSPECTION_KEYWORDS,
  component: InspectionsPage,
  dynamicLabels: () => (languagesCache ?? []).flatMap((l) => [l.name, ...l.servers]),
};
