/**
 * File › New Project…: the generators of `ide-scaffold` (`generators/*.toml`) on the
 * left, the chosen one's form on the right, then a progress view while the backend
 * creates the project. The new project opens in a new window (this one when it has
 * no project).
 */
import { Channel } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import {
  call,
  commands,
  isCancelled,
  isTauri,
  nextRequestId,
  type Field,
  type GeneratorInfo,
  type Requirement,
  type ScaffoldEvent,
  type Sdk,
} from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { useTx, useTxTemplate } from "@/platform/i18n";
import { Button, Checkbox, Dialog, Icon, Input, Select, type SelectOption, T, hasIcon } from "@/ui";
import { effectiveValues, fieldError, isVisible, type Values } from "./newProjectTemplate";
import { defaultProjectDirectory, openProjectInWindow } from "./windows";
import styles from "./newProject.module.css";

const useNewProject = create<{ open: boolean }>(() => ({ open: false }));
export const showNewProject = () => useNewProject.setState({ open: true });

export function NewProjectOverlay() {
  const open = useNewProject((s) => s.open);
  return open ? <NewProjectDialog onClose={() => useNewProject.setState({ open: false })} /> : null;
}

/** Why `name` cannot be a project folder name, or null. */
export function projectNameError(name: string): string | null {
  const n = name.trim();
  if (!n) return "Enter a project name";
  if (/[/\\:*?"<>|]/.test(n) || n === "." || n === ".." || n.startsWith("."))
    return "The name contains characters a folder name cannot have";
  return null;
}

export function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith("/") || dir.endsWith("\\") ? `${dir}${name.trim()}` : `${dir}${sep}${name.trim()}`;
}

function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

/** Default Project Directory, else the parent of the open project. */
function initialLocation(): string {
  const preset = defaultProjectDirectory();
  if (preset) return preset;
  const root = useProject.getState().project?.root;
  return root ? root.slice(0, Math.max(root.lastIndexOf("/"), 1)) : "";
}

/** Generators in list order, with a heading per group. */
function groupedEntries(catalog: readonly GeneratorInfo[], query: string) {
  const q = query.trim().toLowerCase();
  const matches = (g: GeneratorInfo) =>
    !q || g.name.toLowerCase().includes(q) || g.group.toLowerCase().includes(q) || g.id.includes(q);
  const groups = new Map<string, GeneratorInfo[]>();
  for (const g of catalog) if (matches(g)) groups.set(g.group, [...(groups.get(g.group) ?? []), g]);
  return [...groups];
}

const NO_VALUES: Values = {};
const NO_FIELDS: Field[] = [];

interface Job {
  steps: string[];
  lines: string[];
  error: string | null;
  cancel: () => void;
}

const SIZE_KEY = "openidea.newProject.size";

function loadDialogSize(): { w: number; h: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(SIZE_KEY) ?? "null") as { w?: unknown; h?: unknown } | null;
    return typeof v?.w === "number" && typeof v.h === "number" ? { w: v.w, h: v.h } : null;
  } catch {
    return null;
  }
}

function saveDialogSize(size: { w: number; h: number }) {
  try {
    localStorage.setItem(SIZE_KEY, JSON.stringify(size));
  } catch {
    // Not kept: the dialog opens at its default size next time.
  }
}

function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const tx = useTx();
  const txTemplate = useTxTemplate();
  const [catalog, setCatalog] = useState<GeneratorInfo[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [selected, setSelected] = useState("empty");
  const [query, setQuery] = useState("");
  const [name, setName] = useState("untitled");
  const [location, setLocation] = useState(initialLocation);
  const [git, setGit] = useState(true);
  /** Values the user set, per generator; the rest are rendered defaults. */
  const [edited, setEdited] = useState<Record<string, Values>>({});
  const [dynamic, setDynamic] = useState<{ id: string; key: string; fields: Field[] } | null>(null);
  const [dynamicError, setDynamicError] = useState<string | null>(null);
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [jdks, setJdks] = useState<Sdk[] | null>(null);
  const [job, setJob] = useState<Job | null>(null);

  useEffect(() => {
    if (initialLocation()) return;
    // Otherwise the user's home.
    void import("@tauri-apps/api/path")
      .then((p) => p.homeDir())
      .then(setLocation)
      .catch(() => {});
  }, []);

  useEffect(() => {
    commands
      .scaffoldCatalog()
      .then(setCatalog)
      .catch((e: unknown) => setCatalogError(errorText(e)));
  }, []);

  const generator = catalog?.find((g) => g.id === selected) ?? null;
  const ownValues = edited[selected] ?? NO_VALUES;
  // A project service's metadata depends only on its server.
  const dynamicKey = `${selected}\0${ownValues.server ?? ""}`;
  const dynamicFields = dynamic && dynamic.key === dynamicKey ? dynamic.fields : NO_FIELDS;
  const fields = useMemo(() => [...(generator?.fields ?? []), ...dynamicFields], [generator, dynamicFields]);
  const values = useMemo(() => effectiveValues(fields, name, ownValues), [fields, name, ownValues]);
  const valuesKey = JSON.stringify(values);

  useEffect(() => {
    if (!generator?.dynamic) return;
    setDynamicError(null);
    const request = nextRequestId();
    let live = true;
    const timer = setTimeout(() => {
      call(commands.scaffoldOptions(generator.id, { server: ownValues.server ?? "" }, request))
        .then((f) => live && setDynamic({ id: generator.id, key: dynamicKey, fields: f }))
        .catch((e: unknown) => live && !isCancelled(e) && setDynamicError(errorText(e)));
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
      void commands.cancelRequest(request).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch per generator and server only
  }, [dynamicKey, generator?.dynamic]);

  useEffect(() => {
    if (!generator) return;
    let live = true;
    const timer = setTimeout(() => {
      call(commands.scaffoldRequirements(generator.id, JSON.parse(valuesKey) as Values))
        .then((r) => live && setRequirements(r))
        .catch(() => live && setRequirements([]));
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [generator, valuesKey]);

  const needsJdk = fields.some((f) => f.kind.type === "sdk" && f.kind.sdk === "jdk");
  useEffect(() => {
    if (!needsJdk || jdks) return;
    call(commands.sdkDetect("jdk"))
      .then(setJdks)
      .catch(() => setJdks([]));
  }, [needsJdk, jdks]);

  const setValue = (id: string, value: string) =>
    setEdited((all) => ({ ...all, [selected]: { ...(all[selected] ?? {}), [id]: value } }));

  const nameError = projectNameError(name);
  const path = location.trim() && !nameError ? joinPath(location.trim(), name) : "";
  const visibleFields = fields.filter((f) => isVisible(f, values));
  const invalidField = visibleFields.find((f) => fieldError(f, values[f.id] ?? ""));
  const missing = requirements.filter((r) => !r.satisfied);
  const loadingDynamic = !!generator?.dynamic && !dynamicFields.length && !dynamicError;
  const invalid =
    !generator || !!nameError || !location.trim() || !!invalidField || missing.length > 0 || loadingDynamic;

  const browse = async () => {
    if (!isTauri()) return;
    const { open } = await import("@/platform/dialog");
    const picked = await open({
      directory: true,
      multiple: false,
      title: "Project Location",
      defaultPath: location || undefined,
    });
    const dir = Array.isArray(picked) ? picked[0] : picked;
    if (dir) setLocation(dir);
  };

  const createProject = async () => {
    if (invalid || job || !generator) return;
    const request = nextRequestId();
    const channel = new Channel<ScaffoldEvent>();
    const next: Job = {
      steps: [],
      lines: [],
      error: null,
      cancel: () => void commands.cancelRequest(request).catch(() => {}),
    };
    setJob(next);
    channel.onmessage = (e) =>
      setJob((j) =>
        j && e.type === "step" ? { ...j, steps: [...j.steps, e.text] } : j ? { ...j, lines: [...j.lines, e.text] } : j,
      );
    const submitted: Values = {};
    for (const f of fields) if (isVisible(f, values)) submitted[f.id] = values[f.id] ?? "";
    try {
      const dir = await call(
        commands.scaffoldCreate(
          {
            generator: generator.id,
            location: location.trim(),
            name: name.trim(),
            git: git && generator.git,
            values: submitted,
          },
          request,
          channel,
        ),
      );
      onClose();
      await openProjectInWindow(dir, useProject.getState().project !== null);
    } catch (e) {
      if (isCancelled(e)) setJob(null);
      else setJob((j) => (j ? { ...j, error: errorText(e) } : j));
    }
  };

  if (job) return <ProgressView job={job} onBack={() => setJob(null)} onClose={onClose} />;

  return (
    <Dialog
      open
      title="New Project"
      onClose={onClose}
      width={860}
      resizable="both"
      minWidth={720}
      minHeight={480}
      initialSize={loadDialogSize()}
      onResized={saveDialogSize}
      className={styles.dialog}
      buttons={[
        { label: "Create", role: "default", disabled: invalid, onClick: () => void createProject() },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.layout}>
        <div className={styles.sidebar}>
          <Input
            className={styles.search}
            value={query}
            placeholder="Search"
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search generators"
          />
          <div className={styles.list} role="listbox" aria-label={tx("Generators")}>
            {catalogError && <div className={styles.error}>{txTemplate(catalogError)}</div>}
            {groupedEntries(catalog ?? [], query).map(([group, entries]) => (
              <div key={group} role="group" aria-label={tx(group)}>
                <div className={styles.groupLabel}>{tx(group)}</div>
                {entries.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    role="option"
                    aria-selected={g.id === selected}
                    className={styles.entry}
                    onClick={() => setSelected(g.id)}
                  >
                    <Icon name={hasIcon(g.icon) ? g.icon : "folder"} />
                    <span>{tx(g.name)}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            void createProject();
          }}
        >
          {generator?.description && <div className={styles.description}>{tx(generator.description)}</div>}
          <div className={styles.grid}>
            <label className={styles.label} htmlFor="np-name">
              <T>Name:</T>
            </label>
            <Input
              id="np-name"
              data-autofocus
              value={name}
              invalid={!!nameError}
              onChange={(e) => setName(e.target.value)}
            />
            <label className={styles.label} htmlFor="np-location">
              <T>Location:</T>
            </label>
            <div className={styles.inline}>
              <Input id="np-location" value={location} onChange={(e) => setLocation(e.target.value)} />
              <Button onClick={() => void browse()} disabled={!isTauri()}>
                <T>Browse…</T>
              </Button>
            </div>
            <span />
            <div className={styles.hint}>
              {nameError ? txTemplate(nameError) : path && txTemplate(`Project will be created in: ${path}`)}
            </div>
            {generator?.git && (
              <>
                <span />
                <Checkbox checked={git} onChange={setGit} label="Create Git repository" />
              </>
            )}
            {visibleFields.map((f) => (
              <FieldRow
                key={f.id}
                field={f}
                value={values[f.id] ?? ""}
                onChange={(v) => setValue(f.id, v)}
                jdks={jdks}
              />
            ))}
            {loadingDynamic && (
              <>
                <span />
                <div className={styles.hint}>
                  <T>Loading options…</T>
                </div>
              </>
            )}
            {dynamicError && (
              <>
                <span />
                <div className={styles.error}>{txTemplate(dynamicError)}</div>
              </>
            )}
          </div>
          {missing.map((r) => (
            <div key={r.program} className={styles.missing}>
              <Icon name="warning" />
              <span>
                {r.found
                  ? tx`${r.program} ${r.found} is installed, but this project needs ${r.min ?? ""} or later.`
                  : tx`${r.program} is not installed.`}{" "}
                {r.hint && tx(r.hint)}
              </span>
            </div>
          ))}
        </form>
      </div>
    </Dialog>
  );
}

function FieldRow({
  field,
  value,
  onChange,
  jdks,
}: {
  field: Field;
  value: string;
  onChange: (value: string) => void;
  jdks: Sdk[] | null;
}) {
  const tx = useTx();
  const id = `np-field-${field.id}`;
  const label = (
    <label className={styles.label} htmlFor={id}>
      {tx(field.label)}
    </label>
  );
  const hint = field.hint ? <div className={styles.fieldHint}>{tx(field.hint)}</div> : null;
  const kind = field.kind;
  if (kind.type === "checkbox")
    return (
      <>
        <span />
        <div>
          <Checkbox checked={value === "true"} onChange={(c) => onChange(c ? "true" : "false")} label={field.label} />
          {hint}
        </div>
      </>
    );
  let control;
  if (kind.type === "choice" && kind.segmented && kind.options.length <= 4)
    control = (
      <div className={styles.segmented} role="group" aria-label={tx(field.label)} id={id}>
        {kind.options.map((o) => (
          <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
            {tx(o.label)}
          </button>
        ))}
      </div>
    );
  else if (kind.type === "choice")
    control = (
      <Select
        id={id}
        value={value}
        options={kind.options.map((o) => ({ value: o.value, label: o.label }))}
        onChange={onChange}
        searchable={kind.options.length > 12}
        aria-label={tx(field.label)}
      />
    );
  else if (kind.type === "sdk") {
    const options: SelectOption[] = [
      { value: "", label: jdks === null ? "Detecting…" : "Automatic" },
      ...(jdks ?? []).map((s) => ({
        value: s.home ?? s.path,
        label: s.name,
        detail: s.version ?? undefined,
        verbatim: true,
      })),
    ];
    if (value && !options.some((o) => o.value === value)) options.push({ value, label: value, verbatim: true });
    control = <Select id={id} value={value} options={options} onChange={onChange} aria-label={tx(field.label)} />;
  } else if (kind.type === "dependencies")
    control = <DependencyPicker id={id} groups={kind.groups} value={value} onChange={onChange} />;
  else
    control = (
      <Input
        id={id}
        value={value}
        placeholder={kind.placeholder ? tx(kind.placeholder) : undefined}
        invalid={!!fieldError(field, value)}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  return (
    <>
      {label}
      <div>
        {control}
        {hint}
      </div>
    </>
  );
}

/** Ids picked out of grouped items (Spring starters, Quarkus extensions); the value is comma-separated. */
function DependencyPicker({
  id,
  groups,
  value,
  onChange,
}: {
  id: string;
  groups: { name: string; items: { id: string; name: string; description: string }[] }[];
  value: string;
  onChange: (value: string) => void;
}) {
  const tx = useTx();
  const [filter, setFilter] = useState("");
  const chosen = value.split(",").filter(Boolean);
  const toggle = (dep: string) =>
    onChange((chosen.includes(dep) ? chosen.filter((d) => d !== dep) : [...chosen, dep]).join(","));
  const names = new Map(groups.flatMap((g) => g.items.map((i) => [i.id, i.name] as const)));
  const q = filter.trim().toLowerCase();
  const shown = groups
    .map((g) => ({
      ...g,
      items: g.items.filter((i) => !q || i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q)),
    }))
    .filter((g) => g.items.length);
  return (
    <div className={styles.dependencies}>
      {chosen.length > 0 && (
        <div className={styles.chips}>
          {chosen.map((d) => (
            <button
              key={d}
              type="button"
              className={styles.chip}
              onClick={() => toggle(d)}
              aria-label={tx`Remove ${names.get(d) ?? d}`}
            >
              {names.get(d) ?? d}
              <Icon name="close" size={12} />
            </button>
          ))}
        </div>
      )}
      <Input id={id} value={filter} placeholder="Search" onChange={(e) => setFilter(e.target.value)} />
      <div className={styles.depList}>
        {shown.map((g) => (
          <div key={g.name}>
            <div className={styles.groupLabel}>{g.name}</div>
            {g.items.map((i) => (
              <div key={i.id} className={styles.depItem} title={i.description}>
                <Checkbox checked={chosen.includes(i.id)} onChange={() => toggle(i.id)} label={i.name} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function ProgressView({ job, onBack, onClose }: { job: Job; onBack: () => void; onClose: () => void }) {
  const txTemplate = useTxTemplate();
  const tx = useTx();
  const log = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [job.lines.length]);
  const failed = job.error !== null;
  return (
    <Dialog
      open
      title="New Project"
      onClose={() => (failed ? onClose() : job.cancel())}
      width={860}
      buttons={
        failed
          ? [
              { label: "Back", role: "default", onClick: onBack },
              { label: "Close", role: "cancel" },
            ]
          : [{ label: "Cancel", role: "cancel", onClick: job.cancel }]
      }
    >
      <div className={styles.progress}>
        <ol className={styles.steps}>
          {job.steps.map((s, i) => (
            <li key={i} aria-current={i === job.steps.length - 1 && !failed ? "step" : undefined}>
              {tx(s)}
            </li>
          ))}
        </ol>
        <pre ref={log} className={styles.log} aria-label={tx("Output")} tabIndex={0}>
          {job.lines.join("\n")}
        </pre>
        {failed && <div className={styles.error}>{txTemplate(job.error ?? "")}</div>}
      </div>
    </Dialog>
  );
}
