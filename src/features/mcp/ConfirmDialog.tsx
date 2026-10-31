/** The oldest pending MCP confirmation as a modal: Allow runs the tool, Deny (Enter / Escape) refuses it. */
import { executeAction } from "@/platform/actions";
import { useTx } from "@/platform/i18n";
import { Dialog, T } from "@/ui";
import { answerConfirm, useMcpConfirms, type McpConfirm } from "./requests";
import { MCP_SETTINGS_PAGE } from "./model";
import styles from "./Mcp.module.css";

export function McpConfirmHost() {
  const head = useMcpConfirms((s) => s.queue[0]);
  const waiting = useMcpConfirms((s) => s.queue.length - 1);
  return head ? <McpConfirmDialog key={head.id} request={head} waiting={waiting} /> : null;
}

function McpConfirmDialog({ request: r, waiting }: { request: McpConfirm; waiting: number }) {
  const t = useTx();
  const deny = () => answerConfirm(r, false);
  return (
    <Dialog
      open
      icon="warning"
      title={t`${r.client} wants to run`}
      onClose={deny}
      width={520}
      footerStart={waiting > 0 ? <span className={styles.waiting}>{t`${waiting} more waiting`}</span> : undefined}
      buttons={[
        { label: "Allow", role: "extra", onClick: () => answerConfirm(r, true) },
        { label: "Deny", role: "default", onClick: deny },
      ]}
    >
      <div className={styles.confirm}>
        <div className={styles.tool}>
          <T>Tool:</T> <span className={styles.mono}>{r.tool}</span>
        </div>
        <pre className={styles.subject} aria-label={t("Command")}>
          {r.subject}
        </pre>
        {r.detail && <div className={styles.detail}>{r.detail}</div>}
        <div className={styles.hint}>
          <T>To run commands without asking, turn on brave mode in</T>{" "}
          <button
            type="button"
            className={styles.link}
            onClick={() => void executeAction("file.settings", MCP_SETTINGS_PAGE)}
          >
            <T>Settings › Tools › MCP Server</T>
          </button>
        </div>
      </div>
    </Dialog>
  );
}
