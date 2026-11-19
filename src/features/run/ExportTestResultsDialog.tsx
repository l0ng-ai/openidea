/**
 * IDEA's Export Test Results dialog: HTML or XML, the output file, and whether to
 * open an HTML report in the browser once it is written.
 */
import { useState } from "react";
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

/**
 * IDEA's default name, `Test Results - <configuration>.html`. Like IDEA's `PathUtil.suggestFileName`, runs of
 * dots and characters file systems refuse become one `_` (`go test ./...` gives `go test`).
 */
export function defaultExportPath(dir: string, name: string, format: TestExportFormat): string {
  const safe = name.replace(/[/\\:*?"<>|.]+/g, "_").replace(/^[\s_]+|[\s_]+$/g, "");
  return `${dir.replace(/[\\/]+$/, "")}/Test Results - ${safe || "Tests"}.${format}`;
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
  const [options, setOptions] = useState(loadExportOptions);
  const [path, setPath] = useState(() => defaultExportPath(cwd, name, options.format));
  // The save dialog already asked before replacing this file.
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const html = options.format === "html";

  const update = (next: Partial<ExportOptions>) => {
    const merged = { ...options, ...next };
    setOptions(merged);
    saveExportOptions(merged);
    // The file follows the format's extension, as in the Export Data dialog.
    if (next.format) setPath((p) => p.replace(/\.(html|xml)$/i, `.${next.format}`));
  };

  const browse = async () => {
    try {
      const { save } = await import("@/platform/dialog");
      const chosen = await save({
        defaultPath: path,
        filters: [{ name: html ? "HTML" : "XML", extensions: [options.format] }],
      });
      if (chosen) {
        setPath(chosen);
        setPicked(chosen);
      }
    } catch {
      // No dialog (tests): keep typing the path.
    }
  };

  const run = async () => {
    const raw = path.trim();
    if (!raw) return;
    const target = isAbsolutePath(raw) ? raw : `${cwd.replace(/[\\/]+$/, "")}/${raw}`;
    setBusy(true);
    const text = exportTestResults(options.format, results, { name, cwd, date: new Date() });
    const ok = await writeTestReport(target, text, picked === raw);
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
      width={520}
      buttons={[
        { label: "OK", role: "default", disabled: busy || !path.trim(), onClick: () => void run() },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.dialogBody}>
        <div className={styles.exportFormats} role="radiogroup" aria-label="Export format">
          <span>
            <T>Export format:</T>
          </span>
          <Radio name="test-export-format" label="HTML" checked={html} onChange={() => update({ format: "html" })} />
          <Radio name="test-export-format" label="XML" checked={!html} onChange={() => update({ format: "xml" })} />
        </div>
        <label className={styles.exportField}>
          <span>
            <T>Output file:</T>
          </span>
          <div className={styles.inputWithButton}>
            <Input mono aria-label="Output file" value={path} onChange={(e) => setPath(e.target.value)} />
            <IconButton icon="folder" title="Browse…" onClick={() => void browse()} />
          </div>
        </label>
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
