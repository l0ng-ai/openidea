import { useTx } from "@/platform/i18n";
import { Dialog } from "@/ui";
import { answerConfirm, useMcpConfirms } from "./requests";
import styles from "./ConfirmDialog.module.css";

export function McpConfirmHost() {
  const request = useMcpConfirms((s) => s.queue[0]);
  const waiting = useMcpConfirms((s) => s.queue.length - 1);
  const t = useTx();
  if (!request) return null;
  const deny = () => answerConfirm(request, false);
  return (
    <Dialog
      open
      icon="warning"
      title={t`${request.client} wants to run ${request.subject}`}
      onClose={deny}
      width={480}
      footerStart={waiting > 0 ? <span>{t`${waiting} more waiting`}</span> : undefined}
      buttons={[
        { label: "Allow", role: "extra", onClick: () => answerConfirm(request, true) },
        { label: "Deny", role: "default", autoFocus: true, onClick: deny },
      ]}
    >
      <div className={styles.content}>
        <div>{t`Project: ${request.project}`}</div>
        <div>{t`Tool: ${request.tool}`}</div>
        {request.detail && <pre className={styles.detail}>{request.detail}</pre>}
        {request.error && <div role="alert">{t`Could not send the answer: ${request.error}`}</div>}
      </div>
    </Dialog>
  );
}
