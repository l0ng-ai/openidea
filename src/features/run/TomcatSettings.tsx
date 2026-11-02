import { useEffect, useRef, useState } from "react";
import { call, commands, type RunConfig, type WebArtifact } from "@/platform/ipc";
import { Select, T } from "@/ui";
import { useTx } from "@/platform/i18n";
import styles from "./Run.module.css";

/** Asynchronous installation validation and project artifact discovery in the configuration editor. */
export function TomcatSettings({ config, onChange }: { config: RunConfig; onChange: (config: RunConfig) => void }) {
  const tx = useTx();
  const [artifacts, setArtifacts] = useState<WebArtifact[]>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const latest = useRef({ config, onChange });
  useEffect(() => {
    latest.current = { config, onChange };
  }, [config, onChange]);
  const select = (artifact: WebArtifact) => {
    const { config, onChange } = latest.current;
    onChange({
      ...config,
      cwd: artifact.module || null,
      params: {
        ...config.params,
        artifact: artifact.id,
        artifactName: artifact.name,
        contextPath: config.params?.contextPath || `/${artifact.name}`,
      },
    });
  };
  useEffect(() => {
    let live = true;
    void call(commands.runTomcatArtifacts())
      .then((items) => {
        if (!live) return;
        setArtifacts(items);
        if (!latest.current.config.params?.artifact && items[0]) select(items[0]);
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
    };
  }, []);
  const home = config.params?.tomcatHome ?? "";
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      setStatus("");
      setError("");
      if (home.trim())
        void call(commands.runTomcatHome(home))
          .then((info) => {
            if (live) setStatus(info.version);
          })
          .catch(() => {
            if (live) setError("Invalid Tomcat installation: check bin/catalina and lib/catalina.jar");
          });
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [home]);
  return (
    <>
      {status && (
        <div className={styles.notice} role="status">
          {status}
        </div>
      )}
      {error && (
        <div className={styles.fieldError} role="alert">
          {tx(error)}
        </div>
      )}
      {(config.params?.deployment ?? "artifact") === "artifact" && (
        <div className={styles.field}>
          <span className={styles.fieldLabel}>
            <T>WAR artifact</T>
          </span>
          <div className={styles.fieldControl}>
            <Select
              aria-label="WAR artifact"
              value={config.params?.artifact || null}
              placeholder="Choose a WAR module"
              options={artifacts.map((a) => ({ value: a.id, label: `${a.name} (${a.tool}: ${a.module || "."})` }))}
              onChange={(id) => {
                const artifact = artifacts.find((a) => a.id === id);
                if (artifact) select(artifact);
              }}
            />
            {!artifacts.length && (
              <span className={styles.chooserMuted}>
                <T>No WAR modules found. Choose a WAR file or an exploded directory.</T>
              </span>
            )}
          </div>
        </div>
      )}
    </>
  );
}
