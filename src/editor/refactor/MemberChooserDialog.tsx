/** IDEA's member chooser for Generate (`memberChooser.ts`). */
import { useState } from "react";
import { Checkbox, Dialog, Spinner, T } from "@/ui";
import { useTx } from "@/platform/i18n";
import {
  chooserTitle,
  generateChosen,
  initialChoice,
  toggled,
  useMemberChooser,
  type MemberChooserRequest,
} from "./memberChooser";
import styles from "./MemberChooserDialog.module.css";

export function MemberChooserDialog() {
  const request = useMemberChooser((s) => s.request);
  if (!request) return null;
  return <MemberChooserDialogInner key={request.seq} request={request} />;
}

function MemberChooserDialogInner({ request }: { request: MemberChooserRequest }) {
  const tx = useTx();
  const { data } = request;
  const [chosen, setChosen] = useState<string[]>(() => initialChoice(data));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A constructor, `__toString()` and `equals()` can be made of no member.
  const ready = !busy && (chosen.length > 0 || ["constructor", "toString", "equals"].includes(data.generator));

  const close = () => {
    useMemberChooser.setState({ request: null });
    request.view.focus();
  };
  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const outcome = await generateChosen(request, chosen);
    if (useMemberChooser.getState().request !== request) return;
    setBusy(false);
    if (outcome.status === "done") close();
    else if (outcome.error) setError(outcome.error);
  };

  return (
    <Dialog
      open
      onClose={close}
      title={tx(chooserTitle(data))}
      width={520}
      buttons={[
        { label: "Select All", role: "extra", onClick: () => setChosen(data.members.map((m) => m.id)) },
        { label: "Select None", role: "extra", onClick: () => setChosen([]) },
        { label: "OK", role: "default", disabled: !ready, onClick: () => void submit() },
        { label: "Cancel", role: "cancel" },
      ]}
      footerStart={busy ? <Spinner size={12} /> : undefined}
    >
      <div className={styles.body}>
        <div className={styles.list} role="group" aria-label={tx("Members")}>
          {data.members.length === 0 && (
            <div className={styles.empty}>
              <T>No members</T>
            </div>
          )}
          {data.members.map((m) => (
            <div key={m.id} className={styles.row}>
              <Checkbox
                label={m.label}
                checked={chosen.includes(m.id)}
                onChange={(on) => setChosen((all) => toggled(data, all, m.id, on))}
              />
              <span className={styles.detail}>{m.detail}</span>
            </div>
          ))}
        </div>
        {error && (
          <span className={styles.error} role="alert">
            {tx(error)}
          </span>
        )}
      </div>
    </Dialog>
  );
}
