/** The oldest pending askpass prompt as a modal: password / text field, or Yes / No for a host key. */
import { useState } from "react";
import { useTx } from "@/platform/i18n";
import { Checkbox, Dialog, Input } from "@/ui";
import { answerAskpass, askpassAnswer, useAskpass, type AskpassPrompt } from "./askpass";
import styles from "./Ssh.module.css";

export function AskpassHost() {
  const head = useAskpass((s) => s.queue[0]);
  return head ? <AskpassDialog key={head.id} prompt={head} /> : null;
}

function AskpassDialog({ prompt: p }: { prompt: AskpassPrompt }) {
  const tx = useTx();
  const [text, setText] = useState("");
  const [remember, setRemember] = useState(true);
  const done = (choice: Parameters<typeof askpassAnswer>[1]) =>
    answerAskpass(p, askpassAnswer(p.kind, choice), remember);
  const cancel = () => done(null);

  if (p.kind === "confirm")
    return (
      <Dialog
        open
        icon="warning"
        title={tx("SSH")}
        onClose={cancel}
        width={480}
        buttons={[
          { label: "Yes", role: "default", onClick: () => done({ confirm: true }) },
          { label: "No", onClick: () => done({ confirm: false }) },
          { label: "Cancel", role: "cancel" },
        ]}
      >
        <div className={styles.prompt}>{p.prompt}</div>
      </Dialog>
    );

  return (
    <Dialog
      open
      title={tx(p.kind === "secret" ? "SSH Password" : "SSH")}
      onClose={cancel}
      width={440}
      buttons={[
        { label: "OK", role: "default", onClick: () => done({ text }) },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          done({ text });
        }}
      >
        <label className={styles.prompt} htmlFor="askpass-input">
          {p.prompt}
        </label>
        <Input
          id="askpass-input"
          data-autofocus
          type={p.kind === "secret" ? "password" : "text"}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {p.remember && <Checkbox checked={remember} onChange={setRemember} label={tx("Remember for this host")} />}
      </form>
    </Dialog>
  );
}
