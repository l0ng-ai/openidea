import { useEffect, useState } from "react";
import clsx from "clsx";
import { executeAction, useActions } from "@/platform/actions";
import { formatClock, formatDay } from "@/platform/dateFormat";
import { call, commands, onIdeEvent, type UpdateStatus } from "@/platform/ipc";
import { useTx } from "@/platform/i18n";
import { Button } from "@/ui";
import { Row, SearchLabel } from "../components/Form";
import { useLabelMatch } from "../components/context";
import formStyles from "../components/Form.module.css";
import styles from "./Updates.module.css";

export function UpdateVersionRow() {
  const tx = useTx();
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void commands
      .appBuildInfo()
      .then((info) => live && setVersion(info.version))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return (
    <Row label="Current version">
      <span>{version ?? tx("Loading…")}</span>
    </Row>
  );
}

export function UpdateCheckRow() {
  const tx = useTx();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const canCheck = useActions((s) => s.actions.has("app.checkForUpdates"));
  const checkedMatch = useLabelMatch("Last checked");
  const checkMatch = useLabelMatch("Check Now");
  const matched = checkedMatch || checkMatch;
  useEffect(() => {
    let live = true;
    let received = false;
    const off = onIdeEvent("updateStatusChanged", ({ status }) => {
      received = true;
      if (live) setStatus(status);
    });
    void call(commands.appUpdateStatus())
      .then((status) => live && !received && setStatus(status))
      .catch(() => {});
    return () => {
      live = false;
      off();
    };
  }, []);
  const date = status?.lastChecked == null ? null : new Date(status.lastChecked);
  const lastChecked = !status ? tx("Loading…") : date ? `${formatDay(date)} ${formatClock(date)}` : tx("Never");
  return (
    <div className={clsx(styles.checkRow, matched && formStyles.matched)} data-search-match={matched || undefined}>
      <Button
        disabled={!canCheck || !status || status.checking}
        onClick={() => void executeAction("app.checkForUpdates")}
      >
        <SearchLabel text={status?.checking ? "Checking for updates…" : "Check Now"} />
      </Button>
      <div className={styles.checkStatus} role="status">
        <SearchLabel text="Last checked" className={styles.checkedLabel} /> <span>{lastChecked}</span>
      </div>
    </div>
  );
}
