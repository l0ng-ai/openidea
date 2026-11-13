/** Shared controls of the interpreter / toolchain settings pages. */
import { useEffect, useMemo, useState } from "react";
import { IconButton, Select, Spinner, type SelectOption } from "@/ui";
import type { IconName } from "@/ui/icons";
import { useProject } from "@/platform/project";
import { call, commands, isTauri } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
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
  /**
   * Paths not offered as choices (interpreters removed from the IDE-wide list). The current
   * value stays selectable as a custom entry, so a hidden interpreter still in use does not
   * disappear from the combo.
   */
  exclude?: readonly string[];
  /** Icon of a detected choice (e.g. the interpreter's environment type). */
  optionIcon?: (sdk: Sdk) => IconName;
  /** Oldest usable Java version: older JDKs are marked, and Download JDK preselects it. */
  minJava?: number | null;
  /** The configured value no longer exists (PyCharm's "Invalid" SDK): kept selectable, marked as such. */
  invalid?: boolean;
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
  exclude,
  optionIcon,
  minJava,
  invalid,
  ...aria
}: SdkFieldProps) {
  const { list, loading, refresh } = useDetected(kind);
  const options = useMemo<SelectOption[]>(() => {
    const out: SelectOption[] = [];
    const norm = (path: string) => path.replace(/\\/g, "/").toLowerCase();
    const excluded = new Set((exclude ?? []).map(norm));
    if (emptyLabel !== undefined) out.push({ value: "", label: emptyLabel, detail: emptyDetail });
    out.push(...(extra ?? []));
    for (const sdk of list) {
      if (excluded.has(norm(sdk.path))) continue;
      const major = minJava ? javaMajor(sdk.version) : null;
      const tooOld = major !== null && !!minJava && major < minJava;
      const detail = tooOld ? tx`too old, needs JDK ${minJava}+ · ${tildify(sdk.path)}` : tildify(sdk.path);
      if (out.some((option) => option.value === sdk.path)) continue;
      out.push({ value: sdk.path, label: sdk.name, detail, icon: optionIcon?.(sdk) });
    }
    if (value && !out.some((o) => o.value === value)) {
      out.push(
        invalid
          ? { value, label: tx`Invalid — ${tildify(value)}`, detail: tildify(value), keywords: "invalid missing" }
          : { value, label: tildify(value), detail: "custom" },
      );
    }
    if (kind === "jdk") out.push({ value: DOWNLOAD_JDK, label: "Download JDK…", icon: "plus" });
    return out;
  }, [list, value, emptyLabel, emptyDetail, extra, exclude, optionIcon, kind, minJava, invalid]);
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
          initialVersion={minJava ?? undefined}
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

/** Feature release of a JDK version string: `21.0.3` → 21, `1.8.0_392` → 8. */
export function javaMajor(version: string | null | undefined): number | null {
  const m = /^(\d+)(?:\.(\d+))?/.exec(version ?? "");
  if (!m) return null;
  const major = Number(m[1]) === 1 && m[2] ? Number(m[2]) : Number(m[1]);
  return Number.isFinite(major) ? major : null;
}

/** The Java version the installed jdtls needs; `null` until known (or not installed). */
function useJdtlsRequiredJava(): number | null {
  const [required, setRequired] = useState<number | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    call(commands.jdtlsRequiredJava())
      .then((r) => live && setRequired(r))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return required;
}

/**
 * The language server JDK row's hint, stating the installed jdtls' Java requirement
 * and whether the chosen JDK (`value`) meets it, and that requirement for [`SdkField`]'s `minJava`.
 */
export function useJdtlsJdk(hint: string, value: string): { hint: string; minJava: number | null } {
  const required = useJdtlsRequiredJava();
  const { list } = useDetected("jdk");
  if (!required) return { hint, minJava: null };
  const major = javaMajor(list.find((sdk) => sdk.path === value)?.version);
  const tooOld = major !== null && major < required;
  const need = tooOld
    ? tx`The installed jdtls needs JDK ${required} or newer; the selected JDK ${major} is too old for it.`
    : tx`The installed jdtls needs JDK ${required} or newer.`;
  return { hint: `${tx(hint)} ${need}`, minJava: required };
}
