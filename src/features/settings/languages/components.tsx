/** Shared controls of the interpreter / toolchain settings pages. */
import { useEffect, useMemo, useState } from "react";
import { IconButton, Select, Spinner, type SelectOption } from "@/ui";
import { useProject } from "@/platform/project";
import { useSetting } from "../components/context";
import { choosePath, detectSdks, useSdks, type Sdk, type SdkKind } from "./api";
import { DownloadJdkDialog } from "./DownloadJdkDialog";
import styles from "./Sdk.module.css";

/**
 * Settings that only make sense per project (Project Structure): with a project
 * open they are written to `.openidea/settings.toml`. Toolchain pages instead
 * follow the page's Global / This project switch (`defaultScope: "project"`).
 */
export function useProjectSetting<T>(key: string): [T, (v: T) => void] {
  const hasProject = useProject((s) => !!s.project);
  return useSetting<T>(key, hasProject ? "project" : "global");
}

const HOME = /^(?:\/(?:Users|home)|[A-Za-z]:[\\/]Users)[\\/][^\\/]+/;

/** `~/…` for paths in the home directory. */
export function tildify(path: string): string {
  return path.replace(HOME, "~");
}

export function useDetected(kind: SdkKind): { list: Sdk[]; loading: boolean; error?: string; refresh: () => void } {
  const list = useSdks((s) => s.byKind[kind]);
  const loading = useSdks((s) => !!s.loading[kind]);
  const error = useSdks((s) => s.errors[kind]);
  useEffect(() => {
    void detectSdks(kind);
  }, [kind]);
  return { list: list ?? [], loading: loading || !list, error, refresh: () => void detectSdks(kind, true) };
}

export interface SdkFieldProps {
  kind: SdkKind;
  value: string;
  onChange: (path: string) => void;
  /** Label of the empty value ("Auto-detect", "Bundled"…); omitted = no empty choice. */
  emptyLabel?: string;
  emptyDetail?: string;
  /** Browse for a directory instead of a file. */
  directory?: boolean;
  browseTitle: string;
  "aria-label": string;
  /** Extra fixed choices before the detected ones (e.g. `workspace`). */
  extra?: SelectOption[];
}

/** The "Download JDK…" entry of JDK combos (not a value). */
const DOWNLOAD_JDK = "\u0000download-jdk";

/** IDEA's SDK combo: detected installations, the current custom path, and a browse button; JDK combos also offer Download JDK…. */
export function SdkField({
  kind,
  value,
  onChange,
  emptyLabel,
  emptyDetail,
  directory,
  browseTitle,
  extra,
  ...aria
}: SdkFieldProps) {
  const { list, loading, refresh } = useDetected(kind);
  const options = useMemo<SelectOption[]>(() => {
    const out: SelectOption[] = [];
    if (emptyLabel !== undefined) out.push({ value: "", label: emptyLabel, detail: emptyDetail });
    out.push(...(extra ?? []));
    for (const sdk of list) out.push({ value: sdk.path, label: sdk.name, detail: tildify(sdk.path) });
    if (value && !out.some((o) => o.value === value)) out.push({ value, label: tildify(value), detail: "custom" });
    if (kind === "jdk") out.push({ value: DOWNLOAD_JDK, label: "Download JDK…", icon: "plus" });
    return out;
  }, [list, value, emptyLabel, emptyDetail, extra, kind]);
  const [downloading, setDownloading] = useState(false);
  const browse = async () => {
    const picked = await choosePath({ directory: !!directory, title: browseTitle, defaultPath: value || undefined });
    if (picked) onChange(picked);
  };
  return (
    <span className={styles.sdkField}>
      <Select
        className={styles.sdkSelect}
        value={value}
        options={options}
        onChange={(v) => (v === DOWNLOAD_JDK ? setDownloading(true) : onChange(v))}
        aria-label={aria["aria-label"]}
        placeholder={loading ? "Detecting…" : "<No interpreter>"}
      />
      {loading ? (
        <Spinner size={14} label="Detecting installations" />
      ) : (
        <IconButton icon="refresh" size="small" title="Detect again" onClick={refresh} />
      )}
      <IconButton icon="folder-open" size="small" title="Browse…" onClick={() => void browse()} />
      {downloading && (
        <DownloadJdkDialog
          onClose={() => setDownloading(false)}
          onDownloaded={(sdk) => {
            setDownloading(false);
            onChange(sdk.path);
          }}
        />
      )}
    </span>
  );
}
