import { useState } from "react";
import type { AgentProvider } from "@/bindings";
import { tx } from "@/platform/i18n";
import { isRemoteWindow } from "@/platform/remote";
import { openExternalUrl } from "@/platform/openUrl";
import { Button, T } from "@/ui";
import { type manageLocalCli, supportsNpmUpdate, type CliResult, type CliUpdate } from "./localCli";
import styles from "./AgentList.module.css";

export function LocalCliUpdate({ agent, manage }: { agent: AgentProvider; manage: typeof manageLocalCli }) {
  const [busy, setBusy] = useState<"check" | "update" | null>(null);
  const [report, setReport] = useState<{ program: string; result: CliResult } | null>(null);
  const result = report?.program === agent.program ? report.result : null;
  const [error, setError] = useState("");
  if (!supportsNpmUpdate(agent) || isRemoteWindow()) return null;
  const check = async (update?: CliUpdate) => {
    setBusy(update ? "update" : "check");
    setError("");
    setReport(null);
    try {
      setReport({ program: agent.program, result: await manage(agent, update) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>
        <T>CLI version</T>
        <span aria-hidden className={styles.sectionRule} />
      </div>
      <div className={styles.actions}>
        <Button size="small" disabled={!!busy} onClick={() => void check()}>
          {busy === "check" ? tx("Checking…") : tx("Check for updates")}
        </Button>
        {result?.status === "available" && (
          <Button size="small" variant="primary" onClick={() => void check(result)}>
            {tx`Update to ${result.latest}`}
          </Button>
        )}
      </div>
      <div aria-live="polite">
        {busy === "update" && (
          <p className={styles.text}>
            <T>Updating the npm installation…</T>
          </p>
        )}
        {result?.status === "available" && (
          <p
            className={styles.text}
          >{tx`Installed: ${result.current} · npm latest: ${result.latest} · ${result.prefix}`}</p>
        )}
        {result?.status === "permission" && (
          <p className={styles.text}>
            {tx`Installed: ${result.current} · npm latest: ${result.latest}. No write permission for the npm installation at ${result.prefix}.`}{" "}
            <Button
              size="small"
              onClick={() =>
                void openExternalUrl(
                  "https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally",
                )
              }
            >
              <T>View permission fixes</T>
            </Button>
          </p>
        )}
        {result?.status === "updated" && (
          <p className={styles.text}>{tx`Updated to ${result.current}. New sessions will use this version.`}</p>
        )}
        {result?.status === "current" && (
          <p className={styles.text}>{tx`Installed: ${result.current} · No newer npm release.`}</p>
        )}
        {result?.status === "channel" && (
          <p
            className={styles.text}
          >{tx`Installed: ${result.current}. Use your installer to manage this release channel.`}</p>
        )}
        {result?.status === "unmanaged" && (
          <p className={styles.text}>
            <T>This is not a global npm install OpenIDEA can update. Use its original installer.</T>
          </p>
        )}
        {(error || result?.status === "error") && (
          <p role="alert" className={styles.error}>
            {error || (result?.status === "error" && tx`npm could not complete the operation (${result.code}).`)}
          </p>
        )}
      </div>
    </div>
  );
}
