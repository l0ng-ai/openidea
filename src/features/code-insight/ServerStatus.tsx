/** Status bar widget listing language servers, with a popup to restart them. */
import { useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { getAction, executeAction } from "@/platform/actions";
import { BarButton, Button, IconButton, Popup, T } from "@/ui";
import { downloadJdkActions } from "@/platform/jdk";
import { relativePath, useProject } from "@/platform/project";
import { STATUS_LABEL, restartServer, servedByOther, serverLabel, serversSummary, useServers } from "./servers";
import styles from "./ServerStatus.module.css";
import { tx } from "@/platform/i18n";

export function ServerStatus() {
  const map = useServers((s) => s.servers);
  const servers = useMemo(() => [...map.values()].sort((a, b) => serverLabel(a).localeCompare(serverLabel(b))), [map]);
  const root = useProject((s) => s.project?.root ?? "");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const summary = serversSummary(servers);
  // features/tools owns installing; without it, fall back to the manual hint text.
  const canInstall = !!getAction("tools.install");
  if (!summary) return null;
  return (
    <>
      <BarButton
        ref={ref}
        aria-expanded={open}
        aria-label={tx`Language servers: ${summary.text}`}
        tooltip="Language servers"
        onClick={() => setOpen((v) => !v)}
      >
        <span className={clsx(styles.dot, styles[summary.tone])} aria-hidden />
        {summary.text}
      </BarButton>
      <Popup
        open={open}
        anchor={ref}
        placement="top-end"
        offset={6}
        onClose={() => setOpen(false)}
        aria-label="Language servers"
      >
        <div className={styles.panel}>
          <div className={styles.header}>
            <T>Language Servers</T>
          </div>
          {servers.map((s) => {
            // jdtls without a JDK new enough to run it: "Download JDK 25".
            const [jdkFix] = s.status === "misconfigured" ? downloadJdkActions(s.message) : [];
            return (
              <div key={s.id} className={styles.server}>
                <div className={styles.line}>
                  <span
                    className={clsx(
                      styles.dot,
                      styles[s.status === "missing" && servedByOther(s, servers) ? "idle" : toneOf(s.status)],
                    )}
                    aria-hidden
                  />
                  <span className={styles.name}>{serverLabel(s)}</span>
                  <span className={styles.status}>{STATUS_LABEL[s.status]}</span>
                  <span className={styles.spacer} />
                  {jdkFix ? (
                    <Button
                      size="small"
                      onClick={() => {
                        setOpen(false);
                        jdkFix.run();
                      }}
                    >
                      {jdkFix.label}
                    </Button>
                  ) : (
                    <>
                      {s.status === "missing" && canInstall && (
                        <Button
                          size="small"
                          aria-label={tx`Install ${s.name}`}
                          onClick={() => {
                            setOpen(false);
                            void executeAction("tools.install", s.name);
                          }}
                        >
                          <T>Install</T>
                        </Button>
                      )}
                      {/* A missing server may have been installed outside the IDE since; restarting looks for it again. */}
                      <IconButton
                        icon="refresh"
                        size="small"
                        title={s.status === "missing" ? tx`Check for ${s.name} again` : tx`Restart ${serverLabel(s)}`}
                        disabled={s.status === "starting"}
                        onClick={() => void restartServer(s.id)}
                      />
                    </>
                  )}
                </div>
                {(s.languages.length > 0 || s.root) && (
                  <div className={styles.meta}>
                    {s.languages.join(", ")}
                    {s.root && s.root !== root ? ` · ${relativePath(root, s.root) || s.root}` : ""}
                  </div>
                )}
                {s.message && (
                  <div className={clsx(styles.message, s.status === "missing" && styles.install)}>{s.message}</div>
                )}
              </div>
            );
          })}
        </div>
      </Popup>
    </>
  );
}

function toneOf(status: string): "ok" | "busy" | "error" | "idle" {
  if (status === "ready") return "ok";
  if (status === "starting" || status === "busy") return "busy";
  if (status === "crashed" || status === "missing" || status === "misconfigured") return "error";
  return "idle";
}
