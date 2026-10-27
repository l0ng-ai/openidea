/**
 * IDEA's Download JDK dialog: vendor, Java version and location; downloads the
 * latest build (SHA-256 verified) with progress and Cancel, then selects it.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { call, commands, isCancelled, isTauri, nextRequestId, type JdkReleases, type Sdk } from "@/platform/ipc";
import { downloadJdk, TEMURIN, type JdkDownload } from "@/platform/jdk";
import { Dialog, IconButton, Input, ProgressBar, Select, type SelectOption, T } from "@/ui";
import { choosePath, rememberSdk } from "./api";
import styles from "./Sdk.module.css";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function DownloadJdkDialog({
  initialVersion,
  onClose,
  onDownloaded,
}: {
  /** Preselected Java version (e.g. the one jdtls needs); default: the newest LTS. */
  initialVersion?: number;
  onClose: () => void;
  onDownloaded: (sdk: Sdk) => void;
}) {
  const [vendors, setVendors] = useState<SelectOption[]>([{ value: TEMURIN, label: "Eclipse Temurin" }]);
  const [vendor, setVendor] = useState(TEMURIN);
  const [releases, setReleases] = useState<JdkReleases | null>(null);
  const [version, setVersion] = useState<string | null>(initialVersion ? String(initialVersion) : null);
  const [location, setLocation] = useState("");
  const [job, setJob] = useState<JdkDownload | null>(null);
  const [progress, setProgress] = useState<{ fraction: number | null; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const locationId = useId();

  useEffect(() => {
    if (!isTauri()) return;
    commands
      .jdkDownloadVendors()
      .then((list) => setVendors(list.map((v) => ({ value: v.id, label: v.name }))))
      .catch(() => {});
    void call(commands.jdkDownloadLocation())
      .then((dir) => setLocation((cur) => cur || dir))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    const request = nextRequestId();
    let live = true;
    call(commands.jdkDownloadReleases(vendor, request))
      .then((r) => {
        if (!live) return;
        setReleases(r);
        setVersion((v) => (v && r.versions.includes(Number(v)) ? v : String(r.recommended)));
      })
      .catch((e: unknown) => live && !isCancelled(e) && setError(`Cannot list the Java versions: ${errorText(e)}`));
    return () => {
      live = false;
      void commands.cancelRequest(request).catch(() => {});
    };
  }, [vendor]);

  const versionOptions = useMemo<SelectOption[]>(
    () =>
      (releases?.versions ?? []).map((v) => ({
        value: String(v),
        label: String(v),
        detail: releases?.lts.includes(v) ? "LTS" : undefined,
      })),
    [releases],
  );

  const download = () => {
    if (!version) return;
    setError(null);
    setProgress({ fraction: null, message: "Resolving the latest build…" });
    const next = downloadJdk(vendor, Number(version), location.trim() || null, (e) =>
      setProgress((p) =>
        e.type === "progress"
          ? { fraction: e.fraction, message: e.message }
          : { fraction: p?.fraction ?? null, message: e.text },
      ),
    );
    setJob(next);
    next.promise
      .then((sdk) => {
        rememberSdk("jdk", sdk);
        onDownloaded(sdk);
      })
      .catch((e: unknown) => {
        if (!isCancelled(e)) setError(errorText(e));
        setProgress(null);
      })
      .finally(() => setJob(null));
  };

  const vendorName = vendors.find((v) => v.value === vendor)?.label ?? vendor;
  return (
    <Dialog
      open
      onClose={() => (job ? job.cancel() : onClose())}
      title="Download JDK"
      width={520}
      aria-label="Download JDK"
      buttons={[
        { label: "Download", role: "default", disabled: !version || !!job, onClick: download },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.form}>
        <div className={styles.downloadGrid}>
          <span>
            <T>Vendor:</T>
          </span>
          <Select value={vendor} options={vendors} onChange={setVendor} disabled={!!job} aria-label="Vendor" />
          <span>
            <T>Version:</T>
          </span>
          <Select
            value={version}
            options={versionOptions}
            onChange={setVersion}
            disabled={!!job}
            placeholder={releases ? "Select a version" : "Loading…"}
            aria-label="Version"
          />
          <label htmlFor={locationId}>
            <T>Location:</T>
          </label>
          <div className={styles.pathRow}>
            <Input
              id={locationId}
              mono
              className={styles.pathInput}
              value={location}
              disabled={!!job}
              onChange={(e) => setLocation(e.target.value)}
            />
            <IconButton
              icon="folder-open"
              size="small"
              title="Browse…"
              disabled={!!job}
              onClick={async () => {
                const p = await choosePath({ directory: true, title: "JDK Location", defaultPath: location });
                if (p) setLocation(p);
              }}
            />
          </div>
        </div>
        <div className={styles.note}>
          {vendorName} {version ?? ""} is unpacked into a folder of its own in {location || "…"}, where JDK detection
          finds it.
        </div>
        {progress && (
          <div className={styles.downloadProgress}>
            <ProgressBar value={progress.fraction} aria-label="Downloading JDK" />
            <span className={styles.note}>{progress.message}</span>
          </div>
        )}
        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}
      </div>
    </Dialog>
  );
}
