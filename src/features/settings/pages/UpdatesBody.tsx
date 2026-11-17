import { useEffect, useState } from "react";
import { executeAction, useActions } from "@/platform/actions";
import { formatClock, formatDay } from "@/platform/dateFormat";
import { call, commands, onIdeEvent, type UpdateStatus } from "@/platform/ipc";
import { useTx } from "@/platform/i18n";
import { Button, T } from "@/ui";
import { Row } from "../components/Form";

export function UpdateStatusRows() {
  const tx = useTx();
  const [version, setVersion] = useState<string | null>(null);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const canCheck = useActions((s) => s.actions.has("app.checkForUpdates"));
  useEffect(() => {
    let live = true;
    let received = false;
    const off = onIdeEvent("updateStatusChanged", ({ status }) => {
      received = true;
      if (live) setStatus(status);
    });
    void commands
      .appBuildInfo()
      .then((info) => live && setVersion(info.version))
      .catch(() => {});
    void call(commands.appUpdateStatus())
      .then((status) => live && !received && setStatus(status))
      .catch(() => {});
    return () => {
      live = false;
      off();
    };
  }, []);
  const date = status?.lastChecked == null ? null : new Date(status.lastChecked);
  return (
    <>
      <Row label="Current version">
        <span>{version ?? tx("Loading…")}</span>
      </Row>
      <Row label="Last checked">
        <span>{!status ? tx("Loading…") : date ? `${formatDay(date)} ${formatClock(date)}` : tx("Never")}</span>
        <Button
          disabled={!canCheck || !status || status.checking}
          onClick={() => void executeAction("app.checkForUpdates")}
        >
          <T>{status?.checking ? "Checking for updates…" : "Check Now"}</T>
        </Button>
      </Row>
    </>
  );
}
