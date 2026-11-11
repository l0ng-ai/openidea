import { useEffect, useState } from "react";
import { executeAction, useActions } from "@/platform/actions";
import { formatClock, formatDay } from "@/platform/dateFormat";
import { call, commands, onIdeEvent, type UpdateStatus } from "@/platform/ipc";
import { useTx } from "@/platform/i18n";
import { Button, T } from "@/ui";
import { Row } from "../components/Form";
import type { PageSpec } from "./spec";

function UpdateStatusRows() {
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

export const UPDATES_PAGE: PageSpec = {
  id: "general.updates",
  title: "Updates",
  order: 3,
  keywords: ["update", "upgrade", "version", "automatic", "GitHub", "CNB"],
  sections: [
    {
      options: [
        {
          kind: "custom",
          label: "Current version",
          keywords: ["Last checked", "Check Now"],
          component: UpdateStatusRows,
        },
        {
          kind: "toggle",
          key: "general.autoCheckUpdates",
          label: "Check for updates automatically",
          hint: "At startup and every 4 hours while OpenIDEA runs. Each new version is announced once per session.",
        },
        {
          kind: "toggle",
          key: "general.showWhatsNewAfterUpdate",
          label: "Show What's New after an update",
          hint: "Opens a page with the release notes when a new version starts. Help › What's New opens it any time.",
        },
        {
          kind: "select",
          key: "general.updateSource",
          label: "Update source",
          hint: "Where updates are downloaded from. If it can't be reached, the other source is tried.",
          options: [
            { value: "auto", label: "Automatic" },
            { value: "github", label: "GitHub" },
            { value: "cnb", label: "CNB (China mirror)" },
          ],
        },
      ],
    },
  ],
};
