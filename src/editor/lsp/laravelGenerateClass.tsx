/**
 * The dialog of the Laravel class generators other than New Model (controller, job,
 * mail, view, migration, test…): a name, the module, and the options the engine lists
 * for the generator (`LaravelGenerator.options`). The engine renders the files
 * (`php_laravel_generate_class`) from the "Laravel …" code templates, the user's edited
 * bodies included. The generators themselves are `CLASS_GENERATORS` of `laravelGenerate`,
 * plus the code generations of the project's `ide.json` files (`ide-json:<id>`), whose
 * input fields (`LaravelGenerator.fields`) the dialog shows below the name.
 */
import { useEffect, useState } from "react";
import { create } from "zustand";
import {
  call,
  commands,
  type LaravelGenerationContext,
  type LaravelGeneratorField,
  type LaravelNewClass,
} from "@/platform/ipc";
import { t, tx } from "@/platform/i18n";
import { ipcPath } from "@/platform/paths";
import { Checkbox, Dialog, Input, Select, T, type SelectOption } from "@/ui";
import { editorService, notifications } from "@/workbench/contributions";
import { whenAllSynced } from "@/editor/api";
import { CLASS_GENERATORS, generationContext, laravelTemplates } from "./laravelGenerate";
import { migrationTimestamp } from "./modelView";
import styles from "./laravelGenerate.module.css";

/** The dialog's form: the engine's request without the generator. */
export type NewClassForm = Omit<LaravelNewClass, "generator" | "module" | "status" | "inputs"> & {
  /** "" = the application. */
  module: string;
  /** As typed. */
  status: string;
  /** The values of an `ide.json` generator's fields by field id; a field missing here has its default. */
  inputs: Record<string, string>;
};

export function emptyClassForm(module = ""): NewClassForm {
  return {
    name: "",
    module,
    model: "",
    related: "",
    table: "",
    create: false,
    event: "",
    queued: true,
    api: false,
    backing: "",
    status: "",
    inputs: {},
  };
}

/** The request of the form for generator `id`. */
export function newClassRequest(id: string, form: NewClassForm): LaravelNewClass {
  const status = Number.parseInt(form.status.trim(), 10);
  return {
    generator: id,
    name: form.name.trim(),
    module: form.module,
    model: form.model.trim(),
    related: form.related.trim(),
    table: form.table.trim(),
    create: form.create,
    event: form.event.trim(),
    queued: form.queued,
    api: form.api,
    backing: form.backing,
    status: Number.isFinite(status) ? status : 0,
    inputs: Object.entries(form.inputs).map(([id, value]) => ({ id, value })),
  };
}

/** The value field `field` has in `form` (its default until changed). */
export const fieldValue = (form: NewClassForm, field: LaravelGeneratorField) => form.inputs[field.id] ?? field.default;

const truthy = (value: string) => !["", "false", "0"].includes(value.trim());

const CLASS_NAME = /^[A-Za-z_][A-Za-z0-9_]*([\\/][A-Za-z_][A-Za-z0-9_]*)*$/;
const VIEW_NAME = /^[A-Za-z0-9_-]+([./][A-Za-z0-9_-]+)*$/;
const MIGRATION_NAME = /^[A-Za-z0-9_ -]+$/;

/** What the name of generator `id` is. */
export function nameKind(id: string): "class" | "view" | "migration" | "none" {
  if (id === "view" || id === "anonymous-component") return "view";
  if (id === "migration") return "migration";
  if (id === "pivot-migration") return "none";
  return "class";
}

/** Why the form can't be submitted yet, or null (the engine checks the rest). `fields`: the
 * input fields of an `ide.json` generator. */
export function newClassError(id: string, form: NewClassForm, fields: LaravelGeneratorField[] = []): string | null {
  const name = form.name.trim();
  const kind = nameKind(id);
  if (kind === "none") {
    if (!form.model.trim() || !form.related.trim()) return "Pick the two models of the pivot table";
    return null;
  }
  if (!name) return "Enter a name";
  if (kind === "class" && !CLASS_NAME.test(name)) return tx`'${name}' is not a valid class name`;
  if (kind === "view" && !VIEW_NAME.test(name.replace(/\.blade\.php$/, "")))
    return tx`'${name}' is not a valid view name`;
  if (kind === "migration" && !MIGRATION_NAME.test(name)) return tx`'${name}' is not a valid migration name`;
  if (form.status.trim() && !/^\d{3}$/.test(form.status.trim())) return "The status is a three-digit HTTP status";
  for (const field of fields) {
    if (field.kind === "checkbox" || field.optional) continue;
    const title = field.title;
    if (!fieldValue(form, field).trim()) return tx`Enter ${title}`;
  }
  return null;
}

/** Runs generator `id`. Answers the created paths. */
export async function generateClass(id: string, form: NewClassForm, now = new Date()): Promise<string[]> {
  const edit = await call(
    commands.phpLaravelGenerateClass(newClassRequest(id, form), laravelTemplates(), migrationTimestamp(now)),
  );
  await whenAllSynced();
  await call(commands.applyWorkspaceEdit(edit));
  return edit.files.flatMap((f) => (f.kind === "create" ? [String(f.path)] : []));
}

// ---------------------------------------------------------------------------
// The dialog.

interface DialogState {
  open: { seq: number; id: string } | null;
}

export const useNewClass = create<DialogState>(() => ({ open: null }));
let seq = 0;

export function openNewClass(id: string): void {
  useNewClass.setState({ open: { seq: ++seq, id } });
}

const close = () => useNewClass.setState({ open: null });

export function NewClassDialog() {
  const open = useNewClass((s) => s.open);
  if (!open) return null;
  return <NewClassPanel key={open.seq} id={open.id} />;
}

const BACKING_OPTIONS: SelectOption[] = [
  { value: "", label: "Pure enum" },
  { value: "string", label: "Backed by string" },
  { value: "int", label: "Backed by int" },
];

function placeholder(id: string): string {
  switch (nameKind(id)) {
    case "view":
      return id === "view" ? "View name, e.g. posts.index" : "Component name, e.g. forms.input";
    case "migration":
      return "Migration name, e.g. add_votes_to_users_table";
    default:
      return "Class name, e.g. Post";
  }
}

function NewClassPanel({ id }: { id: string }) {
  const entry = CLASS_GENERATORS.find((g) => g.id === id);
  const [ctx, setCtx] = useState<LaravelGenerationContext | null | undefined>(undefined);
  const generator = ctx?.generators.find((g) => g.id === id);
  const title = entry?.dialog ?? generator?.title ?? id;
  const fields = generator?.fields ?? [];
  const [form, setForm] = useState<NewClassForm>(() => emptyClassForm());
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
  const update = (change: Partial<NewClassForm>) => {
    setFailure(null);
    setForm((f) => ({ ...f, ...change }));
  };
  const options = new Set(generator?.options ?? []);
  const invalid = newClassError(id, form, fields);
  const setInput = (field: string, value: string) => update({ inputs: { ...form.inputs, [field]: value } });
  const submit = async () => {
    if (invalid || pending) return;
    setPending(true);
    try {
      const paths = await generateClass(id, form);
      close();
      const fileName = paths[0]?.split(/[\\/]/).pop() ?? "";
      notifications().notify({ level: "info", title: tx`Created ${fileName}`, key: "laravel-generate" });
      if (paths[0]) await editorService().openFile(ipcPath(paths[0]), { focus: true });
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
      setPending(false);
    }
  };
  const moduleOptions: SelectOption[] = [
    { value: "", label: "Application", detail: ctx?.namespace ?? "" },
    ...(ctx?.modules ?? []).map((m) => ({ value: m, label: m, detail: "module" })),
  ];
  const modelOptions = (empty: string): SelectOption[] => [
    { value: "", label: empty },
    ...(ctx?.models ?? []).map((m) => ({ value: m, label: m.slice(m.lastIndexOf("\\") + 1), detail: m })),
  ];
  const showError = (failure ?? invalid) && (form.name.trim() !== "" || nameKind(id) === "none" || failure);
  return (
    <Dialog
      open
      title={title}
      onClose={close}
      width={520}
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
      <div className={styles.body} role="form" aria-label={title}>
        {ctx === null && (
          <div className={styles.error}>
            <T>Not a Laravel project, or the built-in PHP engine isn't running.</T>
          </div>
        )}
        <div className={styles.row}>
          {nameKind(id) !== "none" && (
            <Input
              data-autofocus
              aria-label="Name"
              placeholder={placeholder(id)}
              value={form.name}
              disabled={pending}
              onChange={(e) => update({ name: e.target.value })}
            />
          )}
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
        {options.has("model") && (
          <div className={styles.row}>
            <Select
              value={form.model}
              options={modelOptions(nameKind(id) === "none" ? "Model…" : "Model (optional)")}
              disabled={pending}
              onChange={(model) => update({ model })}
              aria-label="Model"
            />
            {options.has("related") && (
              <Select
                value={form.related}
                options={modelOptions("Related model…")}
                disabled={pending}
                onChange={(related) => update({ related })}
                aria-label="Related model"
              />
            )}
          </div>
        )}
        {options.has("table") && (
          <div className={styles.row}>
            <Input
              aria-label="Table"
              placeholder="Table (guessed from the name when empty)"
              value={form.table}
              disabled={pending}
              onChange={(e) => update({ table: e.target.value })}
            />
            {options.has("create") && (
              <Checkbox
                checked={form.create}
                disabled={pending}
                label="Create the table"
                onChange={(create) => update({ create })}
              />
            )}
          </div>
        )}
        {options.has("event") && (
          <div className={styles.row}>
            <Input
              aria-label="Event"
              placeholder="Event class (optional), e.g. OrderShipped"
              value={form.event}
              disabled={pending}
              onChange={(e) => update({ event: e.target.value })}
            />
          </div>
        )}
        {options.has("backing") && (
          <div className={styles.row}>
            <Select
              value={form.backing}
              options={BACKING_OPTIONS}
              disabled={pending}
              onChange={(backing) => update({ backing })}
              aria-label="Backing type"
            />
          </div>
        )}
        {options.has("status") && (
          <div className={styles.row}>
            <Input
              aria-label="HTTP status"
              placeholder="HTTP status, e.g. 403 (500 when empty)"
              value={form.status}
              disabled={pending}
              onChange={(e) => update({ status: e.target.value })}
            />
          </div>
        )}
        {(options.has("queued") || options.has("api")) && (
          <div className={styles.checks}>
            {options.has("queued") && (
              <Checkbox
                checked={form.queued}
                disabled={pending}
                label="Queued"
                onChange={(queued) => update({ queued })}
              />
            )}
            {options.has("api") && (
              <Checkbox
                checked={form.api}
                disabled={pending}
                label="API (no create and edit actions)"
                onChange={(api) => update({ api })}
              />
            )}
          </div>
        )}
        {fields.map((field) => (
          <GeneratorFieldInput
            key={field.id}
            field={field}
            value={fieldValue(form, field)}
            disabled={pending}
            onChange={(value) => setInput(field.id, value)}
          />
        ))}
        {showError && (
          <div className={styles.error}>
            <T>{failure ?? invalid!}</T>
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** An input field of an `ide.json` generator; its title and choices are the file's own text. */
function GeneratorFieldInput({
  field,
  value,
  disabled,
  onChange,
}: {
  field: LaravelGeneratorField;
  value: string;
  disabled: boolean;
  onChange(value: string): void;
}) {
  if (field.kind === "checkbox") {
    return (
      <div className={styles.checks}>
        <Checkbox
          checked={truthy(value)}
          disabled={disabled}
          label={field.title}
          onChange={(on) => onChange(on ? "true" : "")}
        />
      </div>
    );
  }
  if (field.kind === "select") {
    const choices: SelectOption[] = field.options.map((o) => ({ value: o.value, label: o.label }));
    if (field.optional || !field.options.some((o) => o.value === value))
      choices.unshift({ value: "", label: field.title });
    return (
      <div className={styles.row}>
        <Select value={value} options={choices} disabled={disabled} onChange={onChange} aria-label={field.title} />
      </div>
    );
  }
  return (
    <div className={styles.row}>
      <Input
        aria-label={field.title}
        placeholder={field.title}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
