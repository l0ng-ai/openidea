/**
 * Laravel's "Create translation key…" (the native PHP engine's code action on
 * a translation key string, in PHP and Blade): a dialog asking for the text
 * of each locale and which locales to write, then the engine's edit adding
 * the key to those locales' files (`php_laravel_create_translation`).
 * Locales that have the key already are shown with their text and left as
 * they are.
 */
import { useState } from "react";
import { create } from "zustand";
import { call, commands, type TranslationText } from "@/platform/ipc";
import { t, tx } from "@/platform/i18n";
import { Checkbox, Dialog, Input, T } from "@/ui";
import { notifications } from "@/workbench/contributions";
import { whenAllSynced } from "@/editor/api";
import { registerClientCommand } from "./clientCommands";
import styles from "./createTranslation.module.css";

/** The command of the engine's action (`ide_php` `CREATE_TRANSLATION_COMMAND`). */
export const CREATE_TRANSLATION_COMMAND = "laravel.createTranslation";

/** One locale of the request (`ide_php` `LocaleText`). */
export interface LocaleText {
  locale: string;
  /** The locale's text when it has the key, else the suggested one. */
  text: string;
  /** The locale has the key already. */
  exists: boolean;
}

/** What the dialog asks about (`ide_php` `TranslationRequest`). */
export interface TranslationRequest {
  key: string;
  locales: LocaleText[];
}

/** The request a command carries: one argument, its JSON. */
export function translationRequestOf(args: readonly unknown[]): TranslationRequest | null {
  const [arg] = args;
  let value: unknown = arg;
  if (typeof arg === "string") {
    try {
      value = JSON.parse(arg);
    } catch {
      return null;
    }
  }
  const r = value as Partial<TranslationRequest> | null;
  if (!r || typeof r.key !== "string" || !Array.isArray(r.locales)) return null;
  const locales = r.locales.filter(
    (l): l is LocaleText => !!l && typeof l.locale === "string" && typeof l.text === "string",
  );
  return { key: r.key, locales: locales.map((l) => ({ locale: l.locale, text: l.text, exists: !!l.exists })) };
}

/** A locale row of the dialog. */
export interface LocaleRow extends LocaleText {
  /** Write this locale. */
  checked: boolean;
}

export const initialRows = (request: TranslationRequest): LocaleRow[] =>
  request.locales.map((l) => ({ ...l, checked: !l.exists }));

/** The texts to write: the checked locales that lack the key. */
export function chosenTexts(rows: readonly LocaleRow[]): TranslationText[] {
  return rows.filter((r) => r.checked && !r.exists).map((r) => ({ locale: r.locale, text: r.text }));
}

/** Why the dialog can't create the key yet, or null. */
export function rowsError(rows: readonly LocaleRow[]): string | null {
  const chosen = chosenTexts(rows);
  if (!chosen.length) return "Choose at least one locale";
  if (chosen.some((t) => !t.text.trim())) return "Enter the text of every chosen locale";
  return null;
}

/** Writes the key: the engine's edit, applied like any workspace edit. */
async function createKey(key: string, texts: TranslationText[]): Promise<void> {
  const edit = await call(commands.phpLaravelCreateTranslation(key, texts));
  await whenAllSynced();
  await call(commands.applyWorkspaceEdit(edit));
}

interface DialogState {
  request: { seq: number; value: TranslationRequest } | null;
}

const useCreateTranslation = create<DialogState>(() => ({ request: null }));
let seq = 0;

/** Opens the dialog for `request`. */
export function openCreateTranslation(request: TranslationRequest): void {
  useCreateTranslation.setState({ request: { seq: ++seq, value: request } });
}

const close = () => useCreateTranslation.setState({ request: null });

export function CreateTranslationDialog() {
  const request = useCreateTranslation((s) => s.request);
  if (!request) return null;
  return <TranslationForm key={request.seq} request={request.value} />;
}

function TranslationForm({ request }: { request: TranslationRequest }) {
  const [rows, setRows] = useState(() => initialRows(request));
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const invalid = rowsError(rows);
  const update = (i: number, change: Partial<LocaleRow>) => {
    setFailure(null);
    setRows((all) => all.map((r, j) => (j === i ? { ...r, ...change } : r)));
  };
  const submit = async () => {
    if (invalid || pending) return;
    setPending(true);
    try {
      await createKey(request.key, chosenTexts(rows));
      close();
      notifications().notify({
        level: "info",
        title: tx`Created translation key ${request.key}`,
        key: "laravel-translation",
      });
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
      setPending(false);
    }
  };
  const firstEditable = rows.findIndex((r) => !r.exists);
  return (
    <Dialog
      open
      title="Create Translation Key"
      onClose={close}
      width={480}
      buttons={[
        { label: "Create", role: "default", disabled: !!invalid || pending, onClick: () => void submit() },
        { label: t("common.cancel"), role: "cancel" },
      ]}
    >
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className={styles.key}>
          <span className={styles.label}>
            <T>Key:</T>
          </span>{" "}
          <code>{request.key}</code>
        </div>
        <div className={styles.rows}>
          {rows.map((r, i) => (
            <div key={r.locale} className={styles.row}>
              <Checkbox
                className={styles.locale}
                checked={r.checked}
                disabled={r.exists || pending}
                label={r.locale}
                onChange={(checked) => update(i, { checked })}
              />
              <Input
                data-autofocus={i === firstEditable || undefined}
                aria-label={tx`Text in ${r.locale}`}
                value={r.text}
                disabled={r.exists || !r.checked || pending}
                onChange={(e) => update(i, { text: e.target.value })}
              />
            </div>
          ))}
        </div>
        {rows.some((r) => r.exists) && (
          <div className={styles.hint}>
            <T>Locales that have the key already are left as they are.</T>
          </div>
        )}
        {(failure ?? invalid) && (
          <div className={styles.error}>
            <T>{failure ?? invalid!}</T>
          </div>
        )}
      </form>
    </Dialog>
  );
}

/** The client side of the engine's action: its command opens the dialog. */
export function registerCreateTranslation(): () => void {
  return registerClientCommand(CREATE_TRANSLATION_COMMAND, (args) => {
    const request = translationRequestOf(args);
    if (request?.locales.length) openCreateTranslation(request);
  });
}
