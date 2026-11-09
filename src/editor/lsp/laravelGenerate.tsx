/**
 * Laravel code generation: the Laravel › Generate menu (project view, editor and New
 * menus), an action per generator (category "Laravel Generators", which Search
 * Everywhere's Laravel Generators tab lists), and the New Model dialog. Generators
 * run in the native PHP engine (`php_laravel_new_model`), which renders the "Laravel …"
 * code templates of Settings › Editor › File and Code Templates (the user's edited
 * bodies go with the request) and follows Settings › PHP › Laravel › Code generation.
 */
import { useEffect, useState } from "react";
import { create } from "zustand";
import {
  call,
  commands,
  type LaravelGenerationContext,
  type LaravelNewModelField,
  type LaravelNewModelRelation,
  type LaravelNewModel,
  type LaravelTemplate,
} from "@/platform/ipc";
import { t, tx } from "@/platform/i18n";
import { executeAction, registerActions } from "@/platform/actions";
import { ipcPath } from "@/platform/paths";
import { useProject } from "@/platform/project";
import { Button, Checkbox, Dialog, IconButton, Input, Select, T, type MenuItem, type SelectOption } from "@/ui";
import { editorService, notifications, registerMenuGroup } from "@/workbench/contributions";
import { whenAllSynced } from "@/editor/api";
import { useFileTemplates } from "@/features/templates/files/store";
import { LARAVEL_TEMPLATE_PREFIX } from "@/features/templates/files/builtins";
import { COLUMN_TYPES, migrationTimestamp } from "./modelView";
import styles from "./laravelGenerate.module.css";

/** The category of the generator actions: Search Everywhere's Laravel Generators tab. */
export const LARAVEL_GENERATORS_CATEGORY = "Laravel Generators";

/** The action opening a generator's dialog. */
export const generatorAction = (id: string) => `laravel.generate.${id}`;

/** The generators known to the front end, with their dialogs. */
export const GENERATORS: ReadonlyArray<{ id: string; title: string; keywords: string[]; open(): void }> = [
  {
    id: "model",
    title: "New Eloquent Model…",
    keywords: ["laravel", "model", "eloquent", "migration", "factory", "seeder", "controller", "policy", "make:model"],
    open: () => openNewModel(),
  },
];

export const RELATION_KINDS = ["belongsTo", "hasOne", "hasMany", "belongsToMany", "morphMany", "morphTo"] as const;
export type ControllerChoice = "none" | "plain" | "resource" | "api";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CLASS_NAME = /^[A-Za-z_][A-Za-z0-9_]*([\\/][A-Za-z_][A-Za-z0-9_]*)*$/;

/** The New Model dialog's form. */
export interface NewModelForm {
  name: string;
  /** "" = the application. */
  module: string;
  fields: LaravelNewModelField[];
  relations: LaravelNewModelRelation[];
  /** Comma-separated columns per index. */
  indexes: Array<{ columns: string; unique: boolean }>;
  timestamps: boolean;
  softDeletes: boolean;
  migration: boolean;
  factory: boolean;
  seeder: boolean;
  controller: ControllerChoice;
  formRequests: boolean;
  resource: boolean;
  policy: boolean;
}

export const emptyField = (): LaravelNewModelField => ({
  name: "",
  ty: "string",
  nullable: false,
  unique: false,
  index: false,
  default: "",
});

export const emptyRelation = (): LaravelNewModelRelation => ({ kind: "belongsTo", model: "", name: "" });

export function emptyForm(module = ""): NewModelForm {
  return {
    name: "",
    module,
    fields: [emptyField()],
    relations: [],
    indexes: [],
    timestamps: true,
    softDeletes: false,
    migration: true,
    factory: true,
    seeder: false,
    controller: "none",
    formRequests: false,
    resource: false,
    policy: false,
  };
}

/** The request of the form: the rows with a name, the indexes' columns split. */
export function newModelRequest(form: NewModelForm): LaravelNewModel {
  return {
    name: form.name.trim(),
    module: form.module,
    fields: form.fields.filter((f) => f.name.trim()).map((f) => ({ ...f, name: f.name.trim() })),
    relations: form.relations
      .filter((r) => r.model.trim() || r.kind === "morphTo")
      .map((r) => ({ ...r, model: r.model.trim(), name: r.name.trim() })),
    indexes: form.indexes
      .map((i) => ({
        columns: i.columns
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean),
        unique: i.unique,
      }))
      .filter((i) => i.columns.length),
    timestamps: form.timestamps,
    softDeletes: form.softDeletes,
    migration: form.migration,
    factory: form.factory,
    seeder: form.seeder,
    controller: form.controller,
    formRequests: form.formRequests,
    resource: form.resource,
    policy: form.policy,
  };
}

/** Why the form can't be submitted yet, or null (the engine checks the rest). */
export function newModelError(form: NewModelForm): string | null {
  const name = form.name.trim();
  if (!name) return "Enter the model's class name";
  if (!CLASS_NAME.test(name)) return tx`'${name}' is not a valid class name`;
  const request = newModelRequest(form);
  const seen = new Set<string>();
  for (const f of request.fields) {
    if (!IDENTIFIER.test(f.name)) return tx`'${f.name}' is not a valid column name`;
    if (seen.has(f.name.toLowerCase())) return tx`The column '${f.name}' is there twice`;
    seen.add(f.name.toLowerCase());
  }
  for (const r of request.relations) {
    if (r.kind === "morphTo" && !r.name) return "Name the morphTo relation (commentable)";
    if (r.name && !IDENTIFIER.test(r.name)) return tx`'${r.name}' is not a valid relation name`;
  }
  return null;
}

/** The current bodies of the generators' templates (the engine has the same defaults). */
export function laravelTemplates(): LaravelTemplate[] {
  return useFileTemplates
    .getState()
    .codeTemplates.filter((f) => f.name.startsWith(LARAVEL_TEMPLATE_PREFIX))
    .map((f) => ({ name: f.name, body: f.body }));
}

/** Creates the model and its classes, and opens the model. Answers the created paths. */
export async function createModel(form: NewModelForm, now = new Date()): Promise<string[]> {
  const edit = await call(
    commands.phpLaravelNewModel(newModelRequest(form), laravelTemplates(), migrationTimestamp(now)),
  );
  await whenAllSynced();
  await call(commands.applyWorkspaceEdit(edit));
  return edit.files.flatMap((f) => (f.kind === "create" ? [String(f.path)] : []));
}

// ---------------------------------------------------------------------------
// The generation context: whether the project is a Laravel one, its modules and models.

let context: { root: string | null; value: LaravelGenerationContext | null } | null = null;

/** The engine's generation context, cached per project (null outside Laravel projects). */
export async function generationContext(refresh = false): Promise<LaravelGenerationContext | null> {
  const root = useProject.getState().project?.root ?? null;
  if (!refresh && context && context.root === root) return context.value;
  const value = await call(commands.phpLaravelGenerationContext()).catch(() => null);
  context = { root, value };
  return value;
}

/** The cached context, without asking the engine. */
export const knownContext = () =>
  context && context.root === (useProject.getState().project?.root ?? null) ? context.value : null;

// ---------------------------------------------------------------------------
// The dialog.

interface DialogState {
  open: { seq: number } | null;
}

export const useNewModel = create<DialogState>(() => ({ open: null }));
let seq = 0;

export function openNewModel(): void {
  useNewModel.setState({ open: { seq: ++seq } });
}

const close = () => useNewModel.setState({ open: null });

export function NewModelDialog() {
  const open = useNewModel((s) => s.open);
  if (!open) return null;
  return <NewModelPanel key={open.seq} />;
}

const CONTROLLER_OPTIONS: SelectOption[] = [
  { value: "none", label: "No controller" },
  { value: "plain", label: "Plain controller" },
  { value: "resource", label: "Resource controller" },
  { value: "api", label: "API controller" },
];

function NewModelPanel() {
  const [ctx, setCtx] = useState<LaravelGenerationContext | null | undefined>(undefined);
  const [form, setForm] = useState<NewModelForm>(() => emptyForm());
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void generationContext(true).then((value) => {
      if (!live) return;
      setCtx(value);
      if (value?.defaultModule) setForm((f) => ({ ...f, module: value.defaultModule! }));
    });
    return () => {
      live = false;
    };
  }, []);
  const update = (change: Partial<NewModelForm>) => {
    setFailure(null);
    setForm((f) => ({ ...f, ...change }));
  };
  const invalid = newModelError(form);
  const submit = async () => {
    if (invalid || pending) return;
    setPending(true);
    try {
      const paths = await createModel(form);
      const count = paths.length;
      const name = form.name.trim();
      close();
      notifications().notify({
        level: "info",
        title: tx`Created ${count} files for ${name}`,
        key: "laravel-new-model",
      });
      if (paths[0]) await editorService().openFile(ipcPath(paths[0]), { focus: true });
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
      setPending(false);
    }
  };
  const typeOptions = COLUMN_TYPES.map((ty) => ({ value: ty, label: ty }));
  const kindOptions = RELATION_KINDS.map((k) => ({ value: k, label: k }));
  const moduleOptions: SelectOption[] = [
    { value: "", label: "Application", detail: ctx?.namespace ?? "" },
    ...(ctx?.modules ?? []).map((m) => ({ value: m, label: m, detail: "module" })),
  ];
  const fields = form.fields;
  const setField = (i: number, change: Partial<LaravelNewModelField>) =>
    update({ fields: fields.map((f, j) => (j === i ? { ...f, ...change } : f)) });
  const setRelation = (i: number, change: Partial<LaravelNewModelRelation>) =>
    update({ relations: form.relations.map((r, j) => (j === i ? { ...r, ...change } : r)) });
  const setIndex = (i: number, change: Partial<NewModelForm["indexes"][number]>) =>
    update({ indexes: form.indexes.map((x, j) => (j === i ? { ...x, ...change } : x)) });
  return (
    <Dialog
      open
      title="New Eloquent Model"
      onClose={close}
      width={760}
      resizable="both"
      minWidth={560}
      minHeight={360}
      buttons={[
        { label: t("common.cancel"), role: "cancel" },
        {
          label: "Create",
          role: "default",
          disabled: !!invalid || pending || ctx === null,
          onClick: () => void submit(),
        },
      ]}
    >
      <div className={styles.body} role="form" aria-label={tx`New Eloquent Model`}>
        {ctx === null && (
          <div className={styles.error}>
            <T>Not a Laravel project, or the built-in PHP engine isn't running.</T>
          </div>
        )}
        <div className={styles.row}>
          <Input
            data-autofocus
            aria-label="Class name"
            placeholder="Class name, e.g. Post"
            value={form.name}
            disabled={pending}
            onChange={(e) => update({ name: e.target.value })}
          />
          {(ctx?.modules.length ?? 0) > 0 && (
            <Select
              value={form.module}
              options={moduleOptions}
              disabled={pending}
              onChange={(module) => update({ module })}
              aria-label="Module"
            />
          )}
        </div>

        <h3 className={styles.heading}>
          <T>Fields</T>
        </h3>
        {fields.map((f, i) => (
          <div key={i} className={styles.row}>
            <Input
              aria-label={tx`Field name ${i + 1}`}
              placeholder="Column name"
              value={f.name}
              disabled={pending}
              onChange={(e) => setField(i, { name: e.target.value })}
            />
            <Select value={f.ty} options={typeOptions} disabled={pending} onChange={(ty) => setField(i, { ty })} />
            <Input
              aria-label={tx`Default value ${i + 1}`}
              placeholder="Default"
              className={styles.narrow}
              value={f.default}
              disabled={pending}
              onChange={(e) => setField(i, { default: e.target.value })}
            />
            <Checkbox
              checked={f.nullable}
              disabled={pending}
              label="Nullable"
              onChange={(nullable) => setField(i, { nullable })}
            />
            <Checkbox
              checked={f.unique}
              disabled={pending}
              label="Unique"
              onChange={(unique) => setField(i, { unique })}
            />
            <Checkbox checked={f.index} disabled={pending} label="Index" onChange={(index) => setField(i, { index })} />
            <IconButton
              icon="close"
              size="small"
              disabled={pending}
              title={tx`Remove field ${i + 1}`}
              onClick={() => update({ fields: fields.filter((_, j) => j !== i) })}
            />
          </div>
        ))}
        <div>
          <Button size="small" disabled={pending} onClick={() => update({ fields: [...fields, emptyField()] })}>
            <T>Add Field</T>
          </Button>
        </div>

        <h3 className={styles.heading}>
          <T>Relations</T>
        </h3>
        {form.relations.map((r, i) => (
          <div key={i} className={styles.row}>
            <Select
              value={r.kind}
              options={kindOptions}
              disabled={pending}
              onChange={(kind) => setRelation(i, { kind })}
            />
            {r.kind !== "morphTo" && (
              <Select
                value={r.model}
                options={[
                  { value: "", label: "Related model…" },
                  ...(ctx?.models ?? []).map((m) => ({ value: m, label: m.slice(m.lastIndexOf("\\") + 1), detail: m })),
                ]}
                disabled={pending}
                onChange={(model) => setRelation(i, { model })}
                aria-label={tx`Related model ${i + 1}`}
              />
            )}
            <Input
              aria-label={tx`Relation name ${i + 1}`}
              placeholder={r.kind === "morphTo" ? "Name, e.g. commentable" : "Name (optional)"}
              value={r.name}
              disabled={pending}
              onChange={(e) => setRelation(i, { name: e.target.value })}
            />
            <IconButton
              icon="close"
              size="small"
              disabled={pending}
              title={tx`Remove relation ${i + 1}`}
              onClick={() => update({ relations: form.relations.filter((_, j) => j !== i) })}
            />
          </div>
        ))}
        <div>
          <Button
            size="small"
            disabled={pending}
            onClick={() => update({ relations: [...form.relations, emptyRelation()] })}
          >
            <T>Add Relation</T>
          </Button>
        </div>

        <h3 className={styles.heading}>
          <T>Indexes</T>
        </h3>
        {form.indexes.map((x, i) => (
          <div key={i} className={styles.row}>
            <Input
              aria-label={tx`Index columns ${i + 1}`}
              placeholder="Columns, e.g. status, published_at"
              value={x.columns}
              disabled={pending}
              onChange={(e) => setIndex(i, { columns: e.target.value })}
            />
            <Checkbox
              checked={x.unique}
              disabled={pending}
              label="Unique"
              onChange={(unique) => setIndex(i, { unique })}
            />
            <IconButton
              icon="close"
              size="small"
              disabled={pending}
              title={tx`Remove index ${i + 1}`}
              onClick={() => update({ indexes: form.indexes.filter((_, j) => j !== i) })}
            />
          </div>
        ))}
        <div>
          <Button
            size="small"
            disabled={pending}
            onClick={() => update({ indexes: [...form.indexes, { columns: "", unique: false }] })}
          >
            <T>Add Index</T>
          </Button>
        </div>

        <h3 className={styles.heading}>
          <T>Generate</T>
        </h3>
        <div className={styles.checks}>
          <Checkbox
            checked={form.timestamps}
            disabled={pending}
            label="Timestamps"
            onChange={(timestamps) => update({ timestamps })}
          />
          <Checkbox
            checked={form.softDeletes}
            disabled={pending}
            label="Soft deletes"
            onChange={(softDeletes) => update({ softDeletes })}
          />
          <Checkbox
            checked={form.migration}
            disabled={pending}
            label="Migration"
            onChange={(migration) => update({ migration })}
          />
          <Checkbox
            checked={form.factory}
            disabled={pending}
            label="Factory"
            onChange={(factory) => update({ factory })}
          />
          <Checkbox checked={form.seeder} disabled={pending} label="Seeder" onChange={(seeder) => update({ seeder })} />
          <Checkbox
            checked={form.formRequests}
            disabled={pending}
            label="Form Requests"
            onChange={(formRequests) => update({ formRequests })}
          />
          <Checkbox
            checked={form.resource}
            disabled={pending}
            label="JSON resource"
            onChange={(resource) => update({ resource })}
          />
          <Checkbox checked={form.policy} disabled={pending} label="Policy" onChange={(policy) => update({ policy })} />
          <Select
            value={form.controller}
            options={CONTROLLER_OPTIONS}
            disabled={pending}
            onChange={(controller) => update({ controller: controller as ControllerChoice })}
            aria-label="Controller"
          />
        </div>
        {(failure ?? invalid) && form.name.trim() !== "" && (
          <div className={styles.error}>
            <T>{failure ?? invalid!}</T>
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Actions and menus.

/** The Laravel › Generate submenu (empty outside Laravel projects, as far as known). */
export function generateMenu(ctx: LaravelGenerationContext | null): MenuItem[] {
  if (!ctx) return [];
  const known = new Set(ctx.generators.map((g) => g.id));
  const items: MenuItem[] = GENERATORS.filter((g) => known.has(g.id)).map((g) => ({
    kind: "action",
    action: generatorAction(g.id),
  }));
  items.push({ kind: "separator" }, { kind: "action", action: "laravel.generate" });
  return [{ label: "Laravel", icon: "php", submenu: [{ label: "Generate", submenu: items }] }];
}

export function registerLaravelGenerators(): () => void {
  const disposers = [
    registerActions([
      ...GENERATORS.map((g) => ({
        id: generatorAction(g.id),
        title: g.title,
        category: LARAVEL_GENERATORS_CATEGORY,
        when: "projectOpen",
        keywords: g.keywords,
        run: () => g.open(),
      })),
      {
        id: "laravel.generate",
        title: "Laravel Generate…",
        category: "Code",
        when: "projectOpen",
        keywords: ["laravel", "generate", "make", "artisan", "generator"],
        run: () => void executeAction("navigate.searchLaravelGenerators"),
      },
    ]),
    registerMenuGroup({
      id: "laravel.generate",
      menus: ["projectView", "editor", "new"],
      order: 70,
      prepare: async () => {
        await generationContext();
      },
      items: () => generateMenu(knownContext()),
    }),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
