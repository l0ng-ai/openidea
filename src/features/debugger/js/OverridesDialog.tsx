import { useState } from "react";
import { useTx } from "@/platform/i18n";
import { Button, Checkbox, Dialog, IconButton, Input, T } from "@/ui";
import {
  removeOverride,
  saveOverride,
  toggleOverride,
  useResponseOverrides,
  type ResponseOverride,
} from "./responseOverrides";
import styles from "./Overrides.module.css";

/** A response to start a rule from: a request's own, as the Network tab shows it. */
export interface OverrideDraft {
  pattern: string;
  status: number;
  contentType: string;
  body: string;
}

interface Form {
  /** The rule being edited; absent for one not saved yet. */
  id?: string;
  pattern: string;
  status: string;
  contentType: string;
  body: string;
}

const EMPTY: Form = { pattern: "", status: "200", contentType: "application/json", body: "" };

const formOf = (rule: ResponseOverride): Form => ({
  id: rule.id,
  pattern: rule.pattern,
  status: String(rule.status),
  contentType: rule.contentType,
  body: rule.body,
});

/** The rule a request already has is edited; otherwise the request's response starts a new one. */
function initialForm(draft: OverrideDraft | null | undefined, rules: readonly ResponseOverride[]): Form | null {
  if (!draft) return null;
  const pattern = draft.pattern.trim();
  const existing = rules.find((r) => r.pattern === pattern);
  return existing
    ? formOf(existing)
    : { pattern, status: String(draft.status), contentType: draft.contentType, body: draft.body };
}

function OverridesBody({ onClose, draft }: { onClose: () => void; draft?: OverrideDraft | null }) {
  const tx = useTx();
  const rules = useResponseOverrides((s) => s.rules);
  const [form, setForm] = useState<Form | null>(() => initialForm(draft, useResponseOverrides.getState().rules));
  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const pattern = form?.pattern.trim() ?? "";
  const save = () => {
    if (!form || !pattern) return;
    const enabled = rules.find((r) => r.id === form.id)?.enabled ?? true;
    const id = saveOverride({
      id: form.id,
      pattern,
      status: Number(form.status),
      contentType: form.contentType.trim() || "text/plain",
      body: form.body,
      enabled,
    });
    setForm({ ...form, id, pattern });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Response Overrides"
      width={760}
      aria-label="Response Overrides"
      buttons={[{ label: "Done", role: "default", onClick: onClose }]}
    >
      <div className={styles.root}>
        <div className={styles.side}>
          <div className={styles.sideHead}>
            <span className={styles.sideTitle}>
              <T>Overrides</T>
            </span>
            <IconButton icon="plus" title="Add Override" size="small" onClick={() => setForm({ ...EMPTY })} />
          </div>
          {rules.length === 0 ? (
            <div className={styles.note}>
              <T>No overrides yet</T>
            </div>
          ) : (
            <ul className={styles.list} aria-label={tx("Overrides")}>
              {rules.map((rule) => (
                <li key={rule.id} className={`${styles.item} ${rule.id === form?.id ? styles.itemOn : ""}`}>
                  <Checkbox
                    checked={rule.enabled}
                    onChange={(on) => toggleOverride(rule.id, on)}
                    aria-label={rule.pattern}
                  />
                  <button type="button" className={styles.itemName} onClick={() => setForm(formOf(rule))}>
                    {rule.pattern}
                  </button>
                  <span className={styles.itemStatus}>{rule.status}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {form ? (
          <div className={styles.editor}>
            <label className={styles.field}>
              <span className={styles.label}>
                <T>Requests whose URL contains</T>
              </span>
              <Input
                mono
                value={form.pattern}
                onChange={(e) => set({ pattern: e.target.value })}
                placeholder="e.g. /api/items"
                aria-label="Part of the URL"
              />
            </label>
            {pattern.length > 0 && pattern.length < 3 && (
              <div className={styles.warning}>
                <T>This also replaces every other response whose URL contains it</T>
              </div>
            )}
            <div className={styles.row}>
              <label className={styles.field}>
                <span className={styles.label}>
                  <T>Status</T>
                </span>
                <Input mono value={form.status} onChange={(e) => set({ status: e.target.value })} aria-label="Status" />
              </label>
              <label className={`${styles.field} ${styles.grow}`}>
                <span className={styles.label}>
                  <T>Content type</T>
                </span>
                <Input
                  mono
                  value={form.contentType}
                  onChange={(e) => set({ contentType: e.target.value })}
                  aria-label="Content type"
                />
              </label>
            </div>
            <label className={`${styles.field} ${styles.grow}`}>
              <span className={styles.label}>
                <T>Response body</T>
              </span>
              <textarea
                className={styles.body}
                value={form.body}
                onChange={(e) => set({ body: e.target.value })}
                spellCheck={false}
                aria-label={tx("Response body")}
              />
            </label>
            <div className={styles.actions}>
              <Button size="small" variant="primary" disabled={!pattern} onClick={save}>
                <T>Save</T>
              </Button>
              {form.id && (
                <Button
                  size="small"
                  variant="ghost"
                  onClick={() => {
                    removeOverride(form.id!);
                    setForm(null);
                  }}
                >
                  <T>Remove</T>
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className={`${styles.editor} ${styles.note}`}>
            <T>Select an override, or add one, to edit the response it gives.</T>
          </div>
        )}
      </div>
    </Dialog>
  );
}

/**
 * The page's response overrides: the list, and the editor of one. Opened on a request
 * (`draft`), the editor starts from that request's response.
 */
export function OverridesDialog({
  open,
  onClose,
  draft,
}: {
  open: boolean;
  onClose: () => void;
  draft?: OverrideDraft | null;
}) {
  // Mounted per opening, so the editor starts from the request it was opened on.
  return open ? <OverridesBody onClose={onClose} draft={draft} /> : null;
}
