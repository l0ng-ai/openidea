/**
 * Laravel's Eloquent model view: the panel the native PHP engine's lens on a
 * model class opens (`laravel.modelView`, its argument the class). It shows
 * the table, the primary key and the columns with their types and where each
 * comes from (a migration or the database), the relations, scopes and
 * accessors, and the related factories, resources, policies, observers and
 * migrations (`php_laravel_model_view`). Clicking an item goes to it; its menu
 * also finds usages or renames there. **Add Columns** collects new columns
 * and applies the engine's edit (`php_laravel_add_columns`): a migration
 * adding them, and the columns added to `$fillable`.
 */
import { useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { create } from "zustand";
import { call, commands, type LaravelLocation, type LaravelModelView, type LaravelNewColumn } from "@/platform/ipc";
import { t, tx } from "@/platform/i18n";
import { executeAction } from "@/platform/actions";
import { ipcPath } from "@/platform/paths";
import { Button, Checkbox, Dialog, IconButton, Input, Select, T, showContextMenu, type MenuItem } from "@/ui";
import { editorService, notifications } from "@/workbench/contributions";
import { whenAllSynced } from "@/editor/api";
import { registerClientCommand } from "./clientCommands";
import styles from "./modelView.module.css";

/** The command of the engine's model lens (`ide_php` `MODEL_VIEW_COMMAND`). */
export const MODEL_VIEW_COMMAND = "laravel.modelView";

/** The model class a lens command carries: its one argument. */
export function modelClassOf(args: readonly unknown[]): string | null {
  const [arg] = args;
  return typeof arg === "string" && arg.trim() ? arg.trim() : null;
}

/** The column types offered (Laravel's `Blueprint` methods). */
export const COLUMN_TYPES = [
  "string",
  "text",
  "integer",
  "bigInteger",
  "unsignedBigInteger",
  "foreignId",
  "boolean",
  "decimal",
  "float",
  "date",
  "dateTime",
  "timestamp",
  "json",
  "uuid",
] as const;

/** A row of the Add Columns form. */
export interface ColumnRow {
  name: string;
  ty: string;
  nullable: boolean;
}

export const emptyRow = (): ColumnRow => ({ name: "", ty: "string", nullable: false });

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The columns to add: the rows with a name. */
export function chosenColumns(rows: readonly ColumnRow[]): LaravelNewColumn[] {
  return rows.filter((r) => r.name.trim()).map((r) => ({ name: r.name.trim(), ty: r.ty, nullable: r.nullable }));
}

/** Why the columns can't be added yet, or null. */
export function columnsError(rows: readonly ColumnRow[], existing: readonly string[]): string | null {
  const columns = chosenColumns(rows);
  if (!columns.length) return "Enter at least one column name";
  const seen = new Set(existing.map((name) => name.toLowerCase()));
  for (const c of columns) {
    if (!IDENTIFIER.test(c.name)) return tx`'${c.name}' is not a valid column name`;
    if (seen.has(c.name.toLowerCase())) return tx`The table has a column '${c.name}' already`;
    seen.add(c.name.toLowerCase());
  }
  return null;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** A migration's file-name prefix (`2024_05_01_120000`), as `php artisan make:migration` writes it. */
export function migrationTimestamp(date: Date): string {
  return `${pad(date.getFullYear(), 4)}_${pad(date.getMonth() + 1)}_${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** Where a column comes from. */
export function columnSource(c: LaravelModelView["columns"][number]): string {
  if (c.source !== "database") return tx("migration");
  return c.database ? tx`database ${c.database}` : tx("database");
}

/** `App\Models\Post` → `Post`. */
const shortName = (fqn: string) => fqn.slice(fqn.lastIndexOf("\\") + 1);

export interface ItemActions {
  goto(at: LaravelLocation): void;
  findUsages(at: LaravelLocation): void;
  rename(at: LaravelLocation): void;
}

async function openAt(at: LaravelLocation): Promise<void> {
  close();
  await editorService().openFile(ipcPath(String(at.path)), {
    selection: { line: at.range.start.line, col: at.range.start.col },
    focus: true,
  });
}

const defaultActions: ItemActions = {
  goto: (at) => void openAt(at),
  findUsages: (at) => void openAt(at).then(() => executeAction("find.usages")),
  rename: (at) => void openAt(at).then(() => executeAction("refactor.rename")),
};

type PlainItem = Exclude<MenuItem, { kind: "separator" | "header" | "action" }>;

/** The menu of an item: go to it, find its usages, rename it. */
export function itemMenu(at: LaravelLocation, run: ItemActions, renamable = true): PlainItem[] {
  const items: PlainItem[] = [
    { label: "Go to Declaration", run: () => run.goto(at) },
    { label: "Find Usages", run: () => run.findUsages(at) },
  ];
  if (renamable) items.push({ label: "Rename…", run: () => run.rename(at) });
  return items;
}

interface ViewState {
  open: { seq: number; cls: string } | null;
  actions: ItemActions;
}

export const useModelView = create<ViewState>(() => ({ open: null, actions: defaultActions }));
let seq = 0;

/** Opens the model view of `cls`. */
export function openModelView(cls: string): void {
  useModelView.setState({ open: { seq: ++seq, cls } });
}

const close = () => useModelView.setState({ open: null });

export function ModelViewDialog() {
  const open = useModelView((s) => s.open);
  if (!open) return null;
  return <ModelPanel key={open.seq} cls={open.cls} />;
}

type Loaded = { view: LaravelModelView } | { error: string } | null;

function ModelPanel({ cls }: { cls: string }) {
  const [loaded, setLoaded] = useState<Loaded>(null);
  const [generation, setGeneration] = useState(0);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    let live = true;
    call(commands.phpLaravelModelView(cls)).then(
      (view) => live && setLoaded({ view }),
      (e: unknown) => live && setLoaded({ error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [cls, generation]);
  const view = loaded && "view" in loaded ? loaded.view : null;
  return (
    <Dialog
      open
      title={tx`Eloquent Model ${shortName(cls)}`}
      onClose={close}
      width={720}
      resizable="both"
      minWidth={480}
      minHeight={320}
      footerStart={
        view && !adding ? (
          <Button onClick={() => setAdding(true)}>
            <T>Add Columns…</T>
          </Button>
        ) : undefined
      }
      buttons={[{ label: t("common.close"), role: "cancel" }]}
    >
      <div className={styles.body}>
        {!loaded && (
          <div className={styles.hint}>
            <T>Loading…</T>
          </div>
        )}
        {loaded && "error" in loaded && <div className={styles.error}>{loaded.error}</div>}
        {view && adding && (
          <AddColumns
            view={view}
            onDone={(added) => {
              setAdding(false);
              if (added) setGeneration((g) => g + 1);
            }}
          />
        )}
        {view && !adding && <ModelDetails view={view} />}
      </div>
    </Dialog>
  );
}

/** An item's name: a link going to it, with its menu on right click and on `⋯`. */
function Item({
  at,
  children,
  renamable = true,
}: {
  at: LaravelLocation | null;
  children: ReactNode;
  renamable?: boolean;
}) {
  const actions = useModelView((s) => s.actions);
  if (!at) return <span className={styles.name}>{children}</span>;
  const menu = (e: ReactMouseEvent) => {
    e.preventDefault();
    showContextMenu(e, itemMenu(at, actions, renamable));
  };
  return (
    <span className={styles.item} onContextMenu={menu}>
      <button type="button" className={styles.link} onClick={() => actions.goto(at)}>
        {children}
      </button>
      <IconButton icon="more-horizontal" size="small" className={styles.more} title="Actions" onClick={menu} />
    </span>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className={styles.section} aria-label={title}>
      <h3 className={styles.heading}>
        <T>{title}</T> <span className={styles.count}>{count}</span>
      </h3>
      {count ? (
        children
      ) : (
        <div className={styles.hint}>
          <T>None</T>
        </div>
      )}
    </section>
  );
}

const RELATED_LABELS: Record<string, string> = {
  factory: "Factory",
  resource: "Resource",
  policy: "Policy",
  observer: "Observer",
  migration: "Migration",
};

function ModelDetails({ view }: { view: LaravelModelView }) {
  return (
    <>
      <div className={styles.summary}>
        <span>
          <span className={styles.label}>
            <T>Class:</T>
          </span>{" "}
          <Item at={view.location}>{view.class}</Item>
        </span>
        <span>
          <span className={styles.label}>
            <T>Table:</T>
          </span>{" "}
          <code>{view.table}</code>
        </span>
        <span>
          <span className={styles.label}>
            <T>Primary key:</T>
          </span>{" "}
          <code>
            {view.primaryKey} ({view.keyType})
          </code>
          {view.incrementing && (
            <span className={styles.detail}>
              {" "}
              <T>auto-increment</T>
            </span>
          )}
        </span>
      </div>
      {!view.schemaCertain && (
        <div className={styles.hint}>
          <T>The columns may be incomplete: no migration creating the table was fully understood.</T>
        </div>
      )}
      <Section title="Columns" count={view.columns.length}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>
                <T>Name</T>
              </th>
              <th>
                <T>Type</T>
              </th>
              <th>
                <T>Cast</T>
              </th>
              <th>
                <T>Source</T>
              </th>
              <th>
                <T>Attributes</T>
              </th>
            </tr>
          </thead>
          <tbody>
            {view.columns.map((c) => (
              <tr key={c.name}>
                <td>
                  <Item at={c.location} renamable={false}>
                    {c.name}
                  </Item>
                </td>
                <td>
                  <code>{c.nullable ? `?${c.ty}` : c.ty}</code>
                </td>
                <td>{c.cast ? <code>{c.cast.replace(/^\\/, "")}</code> : null}</td>
                <td>{columnSource(c)}</td>
                <td className={styles.flags}>
                  {[c.fillable && "fillable", c.hidden && "hidden"].filter(Boolean).join(", ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section title="Relations" count={view.relations.length}>
        <ul className={styles.list}>
          {view.relations.map((r) => (
            <li key={r.name}>
              <Item at={r.location}>{r.name}</Item>{" "}
              <span className={styles.detail}>
                {r.kind}
                {r.related ? ` → ${shortName(r.related)}` : ""}
              </span>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Scopes" count={view.scopes.length}>
        <ul className={styles.list}>
          {view.scopes.map((s) => (
            <li key={s.method}>
              <Item at={s.location}>{s.name}</Item> <span className={styles.detail}>{s.method}()</span>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Accessors" count={view.accessors.length}>
        <ul className={styles.list}>
          {view.accessors.map((a) => (
            <li key={a.method}>
              <Item at={a.location}>{a.name}</Item>{" "}
              <span className={styles.detail}>
                {a.ty ?? ""} {a.method}()
              </span>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Related" count={view.related.length}>
        <ul className={styles.list}>
          {view.related.map((r) => (
            <li key={`${r.kind}:${r.name}`}>
              <span className={styles.kind}>
                <T>{RELATED_LABELS[r.kind] ?? r.kind}</T>
              </span>{" "}
              <Item at={r.location} renamable={r.kind !== "migration"}>
                {r.kind === "migration" ? r.name : shortName(r.name)}
              </Item>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

/** Adds the columns: the engine's edit, applied like any workspace edit. */
async function addColumns(cls: string, columns: LaravelNewColumn[], fillable: boolean): Promise<void> {
  const edit = await call(commands.phpLaravelAddColumns(cls, columns, fillable, migrationTimestamp(new Date())));
  await whenAllSynced();
  await call(commands.applyWorkspaceEdit(edit));
}

function AddColumns({ view, onDone }: { view: LaravelModelView; onDone: (added: boolean) => void }) {
  const [rows, setRows] = useState<ColumnRow[]>(() => [emptyRow()]);
  const [fillable, setFillable] = useState(true);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const invalid = columnsError(
    rows,
    view.columns.map((c) => c.name),
  );
  const update = (i: number, change: Partial<ColumnRow>) => {
    setFailure(null);
    setRows((all) => all.map((r, j) => (j === i ? { ...r, ...change } : r)));
  };
  const submit = async () => {
    if (invalid || pending) return;
    setPending(true);
    const columns = chosenColumns(rows);
    try {
      await addColumns(view.class, columns, fillable);
      notifications().notify({
        level: "info",
        title: tx`Added ${columns.length} columns to ${view.table}`,
        key: "laravel-add-columns",
      });
      onDone(true);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
      setPending(false);
    }
  };
  const typeOptions = COLUMN_TYPES.map((ty) => ({ value: ty, label: ty }));
  return (
    <form
      className={styles.form}
      aria-label={tx`Add Columns`}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className={styles.hint}>
        <T>A new migration adds the columns to the table:</T> <code>{view.table}</code>
      </div>
      {rows.map((r, i) => (
        <div key={i} className={styles.columnRow}>
          <Input
            data-autofocus={i === 0 || undefined}
            aria-label={tx`Column name ${i + 1}`}
            placeholder="Column name"
            value={r.name}
            disabled={pending}
            onChange={(e) => update(i, { name: e.target.value })}
          />
          <Select value={r.ty} options={typeOptions} disabled={pending} onChange={(ty) => update(i, { ty })} />
          <Checkbox
            checked={r.nullable}
            disabled={pending}
            label="Nullable"
            onChange={(nullable) => update(i, { nullable })}
          />
          <IconButton
            icon="close"
            size="small"
            disabled={pending || rows.length === 1}
            title={tx`Remove column ${i + 1}`}
            onClick={() => setRows((all) => all.filter((_, j) => j !== i))}
          />
        </div>
      ))}
      <div className={styles.formButtons}>
        <Button size="small" disabled={pending} onClick={() => setRows((all) => [...all, emptyRow()])}>
          <T>Add Row</T>
        </Button>
      </div>
      <Checkbox checked={fillable} disabled={pending} label="Add them to $fillable" onChange={setFillable} />
      {(failure ?? invalid) && (
        <div className={styles.error}>
          <T>{failure ?? invalid!}</T>
        </div>
      )}
      <div className={styles.formButtons}>
        <Button type="submit" variant="primary" disabled={!!invalid || pending}>
          <T>Create Migration</T>
        </Button>
        <Button disabled={pending} onClick={() => onDone(false)}>
          <T>Back</T>
        </Button>
      </div>
    </form>
  );
}

/** The client side of the engine's lens: its command opens the view. */
export function registerModelView(): () => void {
  return registerClientCommand(MODEL_VIEW_COMMAND, (args) => {
    const cls = modelClassOf(args);
    if (cls) openModelView(cls);
  });
}
