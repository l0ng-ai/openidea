/** IDEA's Change Signature dialog for Java methods (`signature.ts`). */
import { useEffect, useRef, useState } from "react";
import type { MethodSignature } from "@/bindings";
import { Checkbox, Dialog, IconButton, Input, Select, Spinner, T, Toolbar } from "@/ui";
import { useTx } from "@/platform/i18n";
import {
  VISIBILITIES,
  changeSignature,
  newParameter,
  parameterRow,
  signatureChanged,
  signatureProblem,
  signatureText,
  useSignatureDialog,
  type ParameterRow,
  type SignatureRequest,
} from "./signature";
import styles from "./ChangeSignatureDialog.module.css";

export function ChangeSignatureDialog() {
  const request = useSignatureDialog((s) => s.request);
  if (!request) return null;
  return <ChangeSignatureDialogInner key={request.seq} request={request} />;
}

function ChangeSignatureDialogInner({ request }: { request: SignatureRequest }) {
  const tx = useTx();
  const { info } = request;
  const [modifier, setModifier] = useState(info.modifier);
  const [returnType, setReturnType] = useState(info.returnType);
  const [methodName, setMethodName] = useState(info.methodName);
  const [rows, setRows] = useState<ParameterRow[]>(() => info.parameters.map(parameterRow));
  const [selected, setSelected] = useState(0);
  const [delegate, setDelegate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signature: MethodSignature = {
    ...info,
    modifier,
    returnType: returnType.trim(),
    methodName: methodName.trim(),
    parameters: rows.map(({ key: _, ...p }) => ({ ...p, type: p.type.trim(), name: p.name.trim() })),
  };
  const problem = signatureProblem(signature);
  const ready = !busy && !problem && signatureChanged(info, signature);
  const current = Math.min(selected, rows.length - 1);

  // Closing the dialog cancels a refactoring still being checked: it applies nothing.
  const running = useRef<AbortController | null>(null);
  useEffect(() => () => running.current?.abort(), []);
  const close = () => {
    running.current?.abort();
    useSignatureDialog.setState({ request: null });
    request.view.focus();
  };
  const update = (key: number, change: Partial<ParameterRow>) =>
    setRows((all) => all.map((r) => (r.key === key ? { ...r, ...change } : r)));
  const add = () => {
    setRows((all) => [...all, newParameter()]);
    setSelected(rows.length);
  };
  const remove = () => {
    if (current < 0) return;
    setRows((all) => all.filter((_, i) => i !== current));
  };
  const move = (by: -1 | 1) => {
    const to = current + by;
    if (current < 0 || to < 0 || to >= rows.length) return;
    setRows((all) => {
      const next = [...all];
      [next[current], next[to]] = [next[to]!, next[current]!];
      return next;
    });
    setSelected(to);
  };
  const submit = async (preview: boolean) => {
    if (!ready) return;
    const run = (running.current = new AbortController());
    setBusy(true);
    setError(null);
    const outcome = await changeSignature(request, signature, delegate, preview, run.signal);
    if (useSignatureDialog.getState().request !== request) return;
    setBusy(false);
    if (outcome.status === "done") close();
    else if (outcome.error) setError(outcome.error);
  };

  return (
    <Dialog
      open
      onClose={close}
      title="Change Signature"
      className={styles.dialog}
      width={640}
      minHeight={380}
      maxHeight={640}
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
        <div className={styles.header}>
          <label className={styles.field}>
            <T>Visibility:</T>
            <Select
              aria-label="Visibility"
              value={modifier}
              options={VISIBILITIES.map((v) => ({ value: v, label: v || tx("package-private") }))}
              onChange={setModifier}
            />
          </label>
          <label className={styles.field}>
            <T>Return type:</T>
            <Input mono value={returnType} onChange={(e) => setReturnType(e.target.value)} />
          </label>
          <label className={styles.field}>
            <T>Name:</T>
            <Input mono autoFocus autoSelect value={methodName} onChange={(e) => setMethodName(e.target.value)} />
          </label>
        </div>
        <div className={styles.parameters}>
          <Toolbar aria-label={tx("Parameters")} className={styles.toolbar}>
            <IconButton icon="plus" title={tx("Add")} onClick={add} />
            <IconButton icon="minus" title={tx("Remove")} disabled={current < 0} onClick={remove} />
            <IconButton icon="arrow-up" title={tx("Move Up")} disabled={current <= 0} onClick={() => move(-1)} />
            <IconButton
              icon="arrow-down"
              title={tx("Move Down")}
              disabled={current < 0 || current >= rows.length - 1}
              onClick={() => move(1)}
            />
          </Toolbar>
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
            </div>
            <div className={styles.rows}>
              {rows.map((row, i) => (
                <div
                  key={row.key}
                  className={styles.row}
                  role="row"
                  aria-selected={i === current}
                  onFocusCapture={() => setSelected(i)}
                >
                  <Input
                    mono
                    variant="bare"
                    aria-label={tx("Type")}
                    value={row.type}
                    autoFocus={row.originalIndex < 0 && !row.type}
                    onChange={(e) => update(row.key, { type: e.target.value })}
                  />
                  <Input
                    mono
                    variant="bare"
                    aria-label={tx("Name")}
                    value={row.name}
                    onChange={(e) => update(row.key, { name: e.target.value })}
                  />
                  <Input
                    mono
                    variant="bare"
                    aria-label={tx("Default value")}
                    value={row.originalIndex < 0 ? row.defaultValue : ""}
                    disabled={row.originalIndex >= 0}
                    onChange={(e) => update(row.key, { defaultValue: e.target.value })}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
        <Checkbox checked={delegate} onChange={setDelegate} label={<T>Delegate via overloading method</T>} />
        <div className={styles.field}>
          <T>Signature Preview</T>
          <pre className={styles.preview}>{signatureText(signature)}</pre>
        </div>
        {(error ?? (signatureChanged(info, signature) ? problem : null)) && (
          <span className={styles.error} role="alert">
            {tx(error ?? problem!)}
          </span>
        )}
      </div>
    </Dialog>
  );
}
