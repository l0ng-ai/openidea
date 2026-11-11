/** IDEA's Extract Method dialog (`extractMethod.ts`). */
import { useState } from "react";
import { Checkbox, Dialog, IconButton, Input, Select, Spinner, T } from "@/ui";
import { useTx } from "@/platform/i18n";
import {
  choiceProblem,
  cleanChoice,
  declarationText,
  moveParameter,
  refactorExtractMethod,
  useExtractMethodDialog,
  type ExtractChoice,
  type ExtractMethodRequest,
  type ExtractParameter,
  type Visibility,
} from "./extractMethod";
import styles from "./ExtractMethodDialog.module.css";

const VISIBILITIES: { value: Visibility; label: string }[] = [
  { value: "private", label: "Private" },
  { value: "protected", label: "Protected" },
  { value: "public", label: "Public" },
];

export function ExtractMethodDialog() {
  const request = useExtractMethodDialog((s) => s.request);
  if (!request) return null;
  return <ExtractMethodDialogInner key={request.seq} request={request} />;
}

function ExtractMethodDialogInner({ request }: { request: ExtractMethodRequest }) {
  const tx = useTx();
  const { data } = request;
  const [choice, setChoice] = useState<ExtractChoice>(() => ({ ...data.defaults }));
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = choiceProblem(choice);
  const ready = !busy && !problem;
  const params = choice.parameters;
  const current = params[selected];

  const close = () => {
    useExtractMethodDialog.setState({ request: null });
    request.view.focus();
  };
  const change = (part: Partial<ExtractChoice>) => setChoice((c) => ({ ...c, ...part }));
  const update = (i: number, part: Partial<ExtractParameter>) =>
    setChoice((c) => ({ ...c, parameters: c.parameters.map((p, j) => (j === i ? { ...p, ...part } : p)) }));
  const move = (delta: number) => {
    const to = selected + delta;
    if (!current || to < 0 || to >= params.length) return;
    change({ parameters: moveParameter(params, selected, delta) });
    setSelected(to);
  };
  const submit = async (preview: boolean) => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const outcome = await refactorExtractMethod(request, cleanChoice(choice), preview);
    if (useExtractMethodDialog.getState().request !== request) return;
    setBusy(false);
    if (outcome.status === "done") close();
    else if (outcome.error) setError(outcome.error);
  };

  return (
    <Dialog
      open
      onClose={close}
      title={data.function ? "Extract Function" : "Extract Method"}
      width={640}
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
        <div className={styles.fields}>
          <label className={styles.field}>
            <span className={styles.label}>
              <T>Name:</T>
            </span>
            <Input
              mono
              autoFocus
              aria-label="Method name"
              value={choice.name}
              onChange={(e) => change({ name: e.target.value })}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>
              <T>Return type:</T>
            </span>
            <Input
              mono
              aria-label="Return type"
              value={choice.returnType}
              onChange={(e) => change({ returnType: e.target.value })}
            />
          </label>
        </div>
        {!data.function && (
          <div className={styles.options}>
            <span className={styles.label}>
              <T>Visibility:</T>
            </span>
            <Select
              aria-label="Visibility"
              value={choice.visibility || "private"}
              options={VISIBILITIES.map((v) => ({ value: v.value, label: tx(v.label) }))}
              onChange={(visibility) => change({ visibility })}
            />
            <Checkbox
              label="Static"
              checked={choice.static}
              disabled={data.staticRequired || data.usesThis}
              onChange={(on) => change({ static: on })}
            />
          </div>
        )}
        <div className={styles.toolbar}>
          <IconButton icon="arrow-up" title="Move Up" disabled={!current || selected === 0} onClick={() => move(-1)} />
          <IconButton
            icon="arrow-down"
            title="Move Down"
            disabled={!current || selected >= params.length - 1}
            onClick={() => move(1)}
          />
        </div>
        <div className={styles.table} role="table" aria-label={tx("Parameters")}>
          <div className={styles.head} role="row">
            <span role="columnheader" />
            <span role="columnheader">
              <T>Type</T>
            </span>
            <span role="columnheader">
              <T>Name</T>
            </span>
          </div>
          <div className={styles.rows}>
            {params.length === 0 && (
              <div className={styles.empty}>
                <T>No parameters</T>
              </div>
            )}
            {params.map((p, i) => (
              <div
                key={p.oldName}
                className={styles.row}
                role="row"
                aria-selected={i === selected}
                data-selected={i === selected || undefined}
                onFocus={() => setSelected(i)}
                onMouseDown={() => setSelected(i)}
              >
                <Checkbox
                  aria-label="Pass this parameter"
                  checked={p.included}
                  onChange={(included) => update(i, { included })}
                />
                <Input
                  mono
                  aria-label="Type"
                  value={p.type}
                  disabled={!p.included}
                  onChange={(e) => update(i, { type: e.target.value })}
                />
                <Input
                  mono
                  aria-label="Name"
                  value={p.name}
                  disabled={!p.included}
                  onChange={(e) => update(i, { name: e.target.value })}
                />
              </div>
            ))}
          </div>
        </div>
        {params.some((p) => !p.included) && (
          <span className={styles.note}>
            <T>Parameters that are not passed are undefined in the new code.</T>
          </span>
        )}
        {data.duplicates > 0 && (
          <Checkbox
            label={
              data.duplicates === 1
                ? tx("Also replace 1 duplicate of the code")
                : tx`Also replace ${data.duplicates} duplicates of the code`
            }
            checked={choice.replaceDuplicates}
            onChange={(on) => change({ replaceDuplicates: on })}
          />
        )}
        <div className={styles.field}>
          <span className={styles.label}>
            <T>Signature preview:</T>
          </span>
          <code className={styles.preview}>{declarationText(data, choice)}</code>
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
