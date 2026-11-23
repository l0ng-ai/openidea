/**
 * IDEA's Export Test Results dialog: HTML or XML, the output file, and whether to
 * open an HTML report in the browser once it is written.
 */
import { useId, useState } from "react";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { Checkbox, Dialog, IconButton, Input, Radio, T } from "@/ui";
import { notifications } from "@/workbench/contributions";
import { confirm } from "@/workbench/messages";
import { exportTestResults, isAbsolutePath, type TestExportFormat } from "./testing/export";
import type { TestResults } from "./testing";
import styles from "./Run.module.css";

/** The format and "open in browser" choice, kept across exports (IDEA remembers them). */
const OPTIONS_KEY = "openidea.run.testExport";

interface ExportOptions {
  format: TestExportFormat;
  openInBrowser: boolean;
}

export function loadExportOptions(): ExportOptions {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(OPTIONS_KEY) ?? "{}") as Partial<ExportOptions>;
    return { format: v.format === "xml" ? "xml" : "html", openInBrowser: v.openInBrowser !== false };
  } catch {
    return { format: "html", openInBrowser: true };
  }
}

function saveExportOptions(o: ExportOptions) {
  try {
    globalThis.localStorage?.setItem(OPTIONS_KEY, JSON.stringify(o));
  } catch {
    /* storage unavailable */
  }
}

/** Runs of dots and characters file systems refuse become one `_`. */
export function defaultExportName(name: string, format: TestExportFormat): string {
  const safe = name.replace(/[/\\:*?"<>|.]+/g, "_").replace(/^[\s_]+|[\s_]+$/g, "");
  return `Test Results - ${safe || "Tests"}.${format}`;
}

interface Destination {
  folder: string;
  fileName: string;
  /** The native picker already asked before replacing this exact path. */
  pickedPath?: string;
}

function destinationFromPicker(path: string): Destination {
  const slash = path.lastIndexOf("/");
  const posix = path.startsWith("/") && !path.startsWith("//");
  const end = (posix ? slash : Math.max(slash, path.lastIndexOf("\\"))) + 1;
  return { folder: path.slice(0, end), fileName: path.slice(end), pickedPath: path };
}

function resolveDestination({ folder, fileName, pickedPath }: Destination, cwd: string): string {
  if (pickedPath) return pickedPath;
  const file = fileName.trim();
  if (!file || isAbsolutePath(file)) return file;
  const dir = folder.trim();
  const posix = dir.startsWith("/") && !dir.startsWith("//");
  const base = dir.replace(posix ? /\/+$/ : /[\\/]+$/, "");
  const path = dir ? `${base}/${file}` : file;
  return isAbsolutePath(path) ? path : `${cwd.replace(/[\\/]+$/, "")}/${path}`;
}

async function exists(path: string): Promise<"file" | "dir" | null> {
  try {
    const kind = await call(commands.fsEntryKind(path));
    return kind === "dir" ? "dir" : "file";
  } catch {
    return null;
  }
}

/** Writes the report; false when the user kept an existing file or the write failed. */
export async function writeTestReport(path: string, text: string, confirmed: boolean): Promise<boolean> {
  const name = path.split(/[\\/]/).pop() ?? path;
  try {
    const kind = await exists(path);
    if (kind === "dir") throw new Error(tx`${path} is a directory`);
    if (kind === "file") {
      if (
        !confirmed &&
        !(await confirm({
          title: "Export Test Results",
          message: tx`File '${name}' already exists. Do you want to overwrite it?`,
          ok: "Overwrite",
        }))
      )
        return false;
      await call(commands.fsDelete(path));
    }
    await call(commands.fsCreateFileBytes(path, Array.from(new TextEncoder().encode(text))));
    return true;
  } catch (e) {
    notifications().notify({
      group: "run",
      level: "error",
      title: "Cannot export test results",
      body: e instanceof Error ? e.message : String(e),
      key: "run-test-export",
    });
    return false;
  }
}

/**
 * Opens the report with the system's browser as a file, without saving open editors; a file outside the project
 * (which that refuses) goes through the built-in server instead.
 */
async function openReport(path: string): Promise<void> {
  try {
    await call(commands.fsOpenWithSystem(path));
  } catch {
    await executeAction("web.openInBrowser", { path });
  }
}

export function ExportTestResultsDialog({
  results,
  name,
  cwd,
  onClose,
}: {
  results: TestResults;
  name: string;
  cwd: string;
  onClose: () => void;
}) {
  const fileNameId = useId();
  const folderId = useId();
  const [options, setOptions] = useState(loadExportOptions);
  const [destination, setDestination] = useState<Destination>(() => ({
    folder: cwd,
    fileName: defaultExportName(name, options.format),
  }));
  const [busy, setBusy] = useState(false);
  const html = options.format === "html";
  const { folder, fileName, pickedPath } = destination;
  const target = resolveDestination(destination, cwd);

  const update = (next: Partial<ExportOptions>) => {
    const merged = { ...options, ...next };
    setOptions(merged);
    saveExportOptions(merged);
    // The file follows the format's extension, as in the Export Data dialog.
    if (next.format) {
      const nextName = fileName.replace(/\.(html|xml)$/i, `.${next.format}`);
      if (nextName !== fileName) setDestination({ folder, fileName: nextName });
    }
  };

  const browse = async () => {
    try {
      const { save } = await import("@/platform/dialog");
      const chosen = await save({
        defaultPath: target || folder || cwd,
        filters: [{ name: html ? "HTML" : "XML", extensions: [options.format] }],
      });
      if (chosen) setDestination(destinationFromPicker(chosen));
    } catch {
      // No dialog (tests): keep typing the path.
    }
  };

  const run = async () => {
    if (!target) return;
    setBusy(true);
    const text = exportTestResults(options.format, results, { name, cwd, date: new Date() });
    const ok = await writeTestReport(target, text, pickedPath !== undefined);
    setBusy(false);
    if (!ok) return;
    onClose();
    notifications().notify({
      group: "run",
      level: "info",
      title: "Test results exported",
      body: target,
      key: "run-test-export",
    });
    if (html && options.openInBrowser) void openReport(target);
  };

  return (
    <Dialog
      open
      title="Export Test Results"
      onClose={onClose}
      width={500}
      buttons={[
        { label: "OK", role: "default", disabled: busy || !target, onClick: () => void run() },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.exportReport}>
        <fieldset className={styles.exportFormats} role="radiogroup">
          <legend>
            <T>Export format:</T>
          </legend>
          <Radio name="test-export-format" label="HTML" checked={html} onChange={() => update({ format: "html" })} />
          <Radio name="test-export-format" label="XML" checked={!html} onChange={() => update({ format: "xml" })} />
        </fieldset>
        <fieldset className={styles.exportOutput}>
          <legend>
            <T>Output</T>
          </legend>
          <label htmlFor={fileNameId}>
            <T>File name</T>
          </label>
          <Input
            id={fileNameId}
            autoSelect
            data-autofocus=""
            value={fileName}
            onChange={(e) => setDestination({ folder, fileName: e.target.value })}
          />
          <label htmlFor={folderId}>
            <T>Folder</T>
          </label>
          <div className={styles.inputWithButton}>
            <Input
              id={folderId}
              value={folder}
              onChange={(e) => setDestination({ folder: e.target.value, fileName })}
            />
            <IconButton icon="folder" title="Browse…" onClick={() => void browse()} />
          </div>
        </fieldset>
        <Checkbox
          checked={html && options.openInBrowser}
          disabled={!html}
          onChange={(v) => update({ openInBrowser: v })}
          label="Open exported file in browser"
        />
      </div>
    </Dialog>
  );
}
