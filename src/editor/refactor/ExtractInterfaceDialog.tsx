/** IDEA's Extract Interface dialog for Java classes (`extractInterface.ts`). */
import { useEffect, useRef, useState } from "react";
import { Checkbox, Dialog, Input, Select, Spinner, T } from "@/ui";
import { useTx } from "@/platform/i18n";
import {
  extractInterface,
  interfaceProblem,
  memberLabel,
  useExtractInterfaceDialog,
  type InterfaceRequest,
} from "./extractInterface";
import styles from "./ExtractInterfaceDialog.module.css";

export function ExtractInterfaceDialog() {
  const request = useExtractInterfaceDialog((s) => s.request);
  if (!request) return null;
  return <ExtractInterfaceDialogInner key={request.seq} request={request} />;
}

function ExtractInterfaceDialogInner({ request }: { request: InterfaceRequest }) {
  const tx = useTx();
  const { info, packages } = request;
  const [name, setName] = useState("");
  const [pkg, setPkg] = useState(() =>
    String(
      Math.max(
        0,
        packages.findIndex((p) => p.current),
      ),
    ),
  );
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const problem = interfaceProblem(trimmed, info.className, checked.size);
  const target = packages[Number(pkg)];
  const ready = !busy && !problem && !!target;
  const allChecked = checked.size === info.members.length;

  // Closing the dialog cancels a refactoring still being checked: it applies nothing.
  const running = useRef<AbortController | null>(null);
  useEffect(() => () => running.current?.abort(), []);
  const close = () => {
    running.current?.abort();
    useExtractInterfaceDialog.setState({ request: null });
    request.view.focus();
  };
  const toggle = (id: string, on: boolean) =>
    setChecked((all) => {
      const next = new Set(all);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const submit = async (preview: boolean) => {
    if (!ready) return;
    const run = (running.current = new AbortController());
    setBusy(true);
    setError(null);
    const members = info.members.map((m) => m.handleIdentifier).filter((id) => checked.has(id));
    const outcome = await extractInterface(request, trimmed, target, members, preview, run.signal);
    if (useExtractInterfaceDialog.getState().request !== request) return;
    setBusy(false);
    if (outcome.status === "done") close();
    else if (outcome.error) setError(outcome.error);
  };

  return (
    <Dialog
      open
      onClose={close}
      title="Extract Interface"
      className={styles.dialog}
      width={560}
      minHeight={360}
      maxHeight={600}
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
        <div className={styles.field}>
          <T>Extract interface from:</T>
          <span className={styles.source}>{info.className}</span>
        </div>
        <label className={styles.field}>
          <T>Interface name:</T>
          <Input mono autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className={styles.field}>
          <T>Package for new interface:</T>
          <Select
            aria-label="Package for new interface"
            value={pkg}
            options={packages.map((p, i) => ({ value: String(i), label: p.name, icon: "package" }))}
            onChange={setPkg}
          />
        </label>
        <div className={styles.table} role="table" aria-label={tx("Members to Form Interface")}>
          <div className={styles.head} role="row">
            <Checkbox
              checked={allChecked}
              indeterminate={checked.size > 0 && !allChecked}
              onChange={(on) => setChecked(on ? new Set(info.members.map((m) => m.handleIdentifier)) : new Set())}
              label={<T>Members to Form Interface</T>}
            />
          </div>
          <div className={styles.rows}>
            {info.members.map((m) => (
              <div key={m.handleIdentifier} className={styles.row} role="row">
                <Checkbox
                  className={styles.member}
                  checked={checked.has(m.handleIdentifier)}
                  onChange={(on) => toggle(m.handleIdentifier, on)}
                  label={<span className={styles.label}>{memberLabel(m)}</span>}
                />
              </div>
            ))}
          </div>
        </div>
        {(error ?? (trimmed && problem)) && (
          <span className={styles.error} role="alert">
            {tx(error ?? problem!)}
          </span>
        )}
      </div>
    </Dialog>
  );
}
