/** IDEA's Pull Members Up and Push Members Down dialogs (`hierarchy.ts`). */
import { useState } from "react";
import { Checkbox, Dialog, Select, Spinner, T } from "@/ui";
import { useTx } from "@/platform/i18n";
import {
  abstractForced,
  choicesOf,
  initialRows,
  refactorHierarchy,
  titleOf,
  useHierarchyDialog,
  type HierarchyRequest,
  type MemberRow,
} from "./hierarchy";
import styles from "./HierarchyDialog.module.css";

export function HierarchyDialog() {
  const request = useHierarchyDialog((s) => s.request);
  if (!request) return null;
  return <HierarchyDialogInner key={request.seq} request={request} />;
}

function HierarchyDialogInner({ request }: { request: HierarchyRequest }) {
  const tx = useTx();
  const { kind, info } = request;
  const pullUp = kind === "pullUp";
  const [target, setTarget] = useState<string | null>(info.targets[0]?.id ?? null);
  const [rows, setRows] = useState<MemberRow[]>(() => initialRows(info));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toInterface = pullUp && !!info.targets.find((t) => t.id === target)?.interface;
  const ready = rows.some((r) => r.checked) && (!pullUp || !!target) && !busy;

  const close = () => {
    useHierarchyDialog.setState({ request: null });
    request.view.focus();
  };
  const update = (id: string, change: Partial<MemberRow>) =>
    setRows((all) => all.map((r) => (r.id === id ? { ...r, ...change } : r)));
  const submit = async (preview: boolean) => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const outcome = await refactorHierarchy(
      request,
      pullUp ? target : null,
      choicesOf(rows, kind, toInterface),
      preview,
    );
    if (useHierarchyDialog.getState().request !== request) return;
    setBusy(false);
    if (outcome.status === "done") close();
    else if (outcome.error) setError(outcome.error);
  };

  return (
    <Dialog
      open
      onClose={close}
      title={titleOf(kind)}
      className={styles.dialog}
      width={560}
      minHeight={300}
      maxHeight={560}
      resizable="both"
      buttons={[
        { label: "Preview", role: "extra", disabled: !ready, onClick: () => void submit(true) },
        { label: "Refactor", role: "default", disabled: !ready, onClick: () => void submit(false) },
        { label: "Cancel", role: "cancel" },
      ]}
      footerStart={
        busy ? (
          <span className={styles.busy}>
            <Spinner size={12} />
            <T>Checking for conflicts…</T>
          </span>
        ) : undefined
      }
    >
      <div className={styles.body}>
        {pullUp ? (
          <label className={styles.field}>
            <span>{tx`Pull up members of ${info.className} to:`}</span>
            <Select
              aria-label="Destination class"
              value={target}
              options={info.targets.map((t) => ({
                value: t.id,
                label: t.qualifiedName,
                icon: t.interface ? "interface" : "class",
              }))}
              onChange={setTarget}
            />
          </label>
        ) : (
          <div className={styles.field}>
            <span>{tx`Push members of ${info.className} down to:`}</span>
            <span className={styles.targets}>{info.targets.map((t) => t.name).join(", ")}</span>
          </div>
        )}
        <div
          className={styles.table}
          role="table"
          aria-label={pullUp ? tx("Members to be pulled up") : tx("Members to be pushed down")}
        >
          <div className={styles.head} role="row">
            <span role="columnheader">
              <T>Member</T>
            </span>
            <span role="columnheader">{pullUp ? <T>Make abstract</T> : <T>Keep abstract</T>}</span>
          </div>
          <div className={styles.rows}>
            {rows.map((row) => {
              const forced = abstractForced(row, kind, toInterface);
              return (
                <div key={row.id} className={styles.row} role="row">
                  <Checkbox
                    className={styles.member}
                    checked={row.checked}
                    onChange={(checked) => update(row.id, { checked })}
                    label={<span className={styles.label}>{row.label}</span>}
                  />
                  <Checkbox
                    aria-label={pullUp ? "Make abstract" : "Keep abstract"}
                    checked={row.checked && (forced || (row.abstractable && row.makeAbstract))}
                    disabled={!row.checked || forced || !row.abstractable}
                    onChange={(makeAbstract) => update(row.id, { makeAbstract })}
                  />
                </div>
              );
            })}
          </div>
        </div>
        {toInterface && (
          <span className={styles.hint}>
            <T>Methods pulled up to an interface are declared abstract there.</T>
          </span>
        )}
        {error && (
          <span className={styles.error} role="alert">
            {tx(error)}
          </span>
        )}
      </div>
    </Dialog>
  );
}
