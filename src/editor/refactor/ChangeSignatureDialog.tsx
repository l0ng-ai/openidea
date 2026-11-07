/** IDEA's Change Signature dialog (`changeSignature.ts`). */
import { useState } from "react";
import { Dialog, IconButton, Input, Spinner, T } from "@/ui";
import { useTx } from "@/platform/i18n";
import {
  changeOf,
  initialRows,
  isChanged,
  moveRow,
  newRow,
  refactorChangeSignature,
  rowProblem,
  signatureText,
  useChangeSignatureDialog,
  type ChangeSignatureRequest,
  type ParamRow,
} from "./changeSignature";
import styles from "./ChangeSignatureDialog.module.css";

export function ChangeSignatureDialog() {
  const request = useChangeSignatureDialog((s) => s.request);
  if (!request) return null;
  return <ChangeSignatureDialogInner key={request.seq} request={request} />;
}

function ChangeSignatureDialogInner({ request }: { request: ChangeSignatureRequest }) {
  const tx = useTx();
  const { signature } = request.data;
  const [rows, setRows] = useState<ParamRow[]>(() => initialRows(signature));
  const [returnType, setReturnType] = useState(signature.returnType);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = rowProblem(rows);
  const ready = !busy && !problem && isChanged(signature, rows, returnType);
  const current = rows[selected];

  const close = () => {
    useChangeSignatureDialog.setState({ request: null });
    request.view.focus();
  };
  const update = (key: string, change: Partial<ParamRow>) =>
    setRows((all) => all.map((r) => (r.key === key ? { ...r, ...change } : r)));
  const add = () => {
    setRows((all) => [...all, newRow()]);
    setSelected(rows.length);
  };
  const remove = () => {
    if (!current || current.promoted) return;
    setRows((all) => all.filter((r) => r.key !== current.key));
    setSelected((i) => Math.max(0, Math.min(i, rows.length - 2)));
  };
  const move = (delta: number) => {
    if (!current) return;
    const to = selected + delta;
    if (to < 0 || to >= rows.length) return;
    setRows((all) => moveRow(all, selected, delta));
    setSelected(to);
  };
  const submit = async (preview: boolean) => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const outcome = await refactorChangeSignature(request, changeOf(signature, rows, returnType), preview);
    if (useChangeSignatureDialog.getState().request !== request) return;
    setBusy(false);
    if (outcome.status === "done") close();
    else if (outcome.error) setError(outcome.error);
  };

  return (
    <Dialog
      open
      onClose={close}
      title="Change Signature"
      width={720}
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
        <div className={styles.name}>
          <span className={styles.label}>
            <T>Name:</T>
          </span>
          <span className={styles.mono}>{signature.name}</span>
        </div>
        {!signature.constructor && (
          <label className={styles.field}>
            <span className={styles.label}>
              <T>Return type:</T>
            </span>
            <Input mono aria-label="Return type" value={returnType} onChange={(e) => setReturnType(e.target.value)} />
          </label>
        )}
        <div className={styles.toolbar}>
          <IconButton icon="plus" title="Add Parameter" onClick={add} />
          <IconButton icon="minus" title="Remove Parameter" disabled={!current || current.promoted} onClick={remove} />
          <IconButton icon="arrow-up" title="Move Up" disabled={!current || selected === 0} onClick={() => move(-1)} />
          <IconButton
            icon="arrow-down"
            title="Move Down"
            disabled={!current || selected >= rows.length - 1}
            onClick={() => move(1)}
          />
        </div>
        <div className={styles.table} role="table" aria-label={tx("Parameters")}>
          <div className={styles.head} role="row">
            <span role="columnheader">
              <T>Type</T>
            </span>
            <span role="columnheader">
              <T>Name</T>
            </span>
            <span role="columnheader">
              <T>Default value</T>
            </span>
            <span role="columnheader">
              <T>Value at call sites</T>
            </span>
          </div>
          <div className={styles.rows}>
            {rows.length === 0 && (
              <div className={styles.empty}>
                <T>No parameters</T>
              </div>
            )}
            {rows.map((row, i) => (
              <div
                key={row.key}
                className={styles.row}
                role="row"
                aria-selected={i === selected}
                data-selected={i === selected || undefined}
                onFocus={() => setSelected(i)}
                onMouseDown={() => setSelected(i)}
              >
                <Input
                  mono
                  aria-label="Type"
                  value={row.type}
                  onChange={(e) => update(row.key, { type: e.target.value })}
                />
                <Input
                  mono
                  aria-label="Name"
                  value={row.name}
                  disabled={row.promoted}
                  title={row.promoted ? tx("A promoted property: rename the property instead") : undefined}
                  onChange={(e) => update(row.key, { name: e.target.value })}
                />
                <Input
                  mono
                  aria-label="Default value"
                  value={row.defaultValue}
                  disabled={row.variadic}
                  onChange={(e) => update(row.key, { defaultValue: e.target.value })}
                />
                <Input
                  mono
                  aria-label="Value at call sites"
                  value={row.callValue}
                  disabled={row.oldIndex !== null || row.variadic}
                  onChange={(e) => update(row.key, { callValue: e.target.value })}
                />
              </div>
            ))}
          </div>
        </div>
        <div className={styles.field}>
          <span className={styles.label}>
            <T>Signature preview:</T>
          </span>
          <code className={styles.preview}>{signatureText(signature.name, rows, returnType)}</code>
        </div>
        {(error ?? problem) && (
          <span className={styles.error} role="alert">
            {tx(error ?? problem ?? "")}
          </span>
        )}
      </div>
    </Dialog>
  );
}
