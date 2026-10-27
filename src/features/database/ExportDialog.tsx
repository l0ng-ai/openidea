/**
 * IDEA's Export Data dialog: extractor (format) and its options on the left,
 * a live preview on the right; copies to the clipboard or writes a file.
 */
import { useEffect, useMemo, useState } from "react";
import { call, commands } from "@/platform/ipc";
import { Checkbox, Dialog, IconButton, Input, Select, T } from "@/ui";
import { notifications } from "@/workbench/contributions";
import {
  DEFAULT_EXPORT_OPTIONS,
  EXPORT_FORMATS,
  exportData,
  type ExportData,
  type ExportFormat,
  type ExportOptions,
} from "./export";
import { CodePreview } from "./CodePreview";
import { closeDialog } from "./store";
import styles from "./Database.module.css";

const PREVIEW_ROWS = 100;
/** Formats with a tabular layout (the options apply). */
const TABULAR: ReadonlySet<ExportFormat> = new Set(["csv", "tsv", "markdown"]);

function joinPath(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, "")}/${name}`;
}

export function ExportDialog({
  data,
  source,
  initialFormat = "csv",
}: {
  data: ExportData;
  source: string;
  initialFormat?: ExportFormat;
}) {
  const [format, setFormat] = useState<ExportFormat>(initialFormat);
  const [options, setOptions] = useState<ExportOptions>(DEFAULT_EXPORT_OPTIONS);
  const ext = EXPORT_FORMATS.find((f) => f.id === format)!.extension;
  const [file, setFile] = useState(`${data.table}.${ext}`);
  const [dir, setDir] = useState<string | null>(null);
  useEffect(() => {
    void import("@tauri-apps/api/path")
      .then((p) => p.homeDir())
      .then((home) => {
        setDir(home);
        setFile((f) => (f.includes("/") || f.includes("\\") ? f : joinPath(home, f)));
      })
      .catch(() => {});
  }, []);
  const changeFormat = (f: ExportFormat) => {
    setFormat(f);
    // The file follows the format's extension.
    const next = EXPORT_FORMATS.find((x) => x.id === f)!.extension;
    setFile((path) => path.replace(/\.[^./\\]*$/, `.${next}`));
  };

  const tabular = TABULAR.has(format);
  const effective = tabular ? options : DEFAULT_EXPORT_OPTIONS;
  const preview = useMemo(
    () => exportData(format, { ...data, rows: data.rows.slice(0, PREVIEW_ROWS) }, effective),
    [format, data, effective],
  );
  const text = () => exportData(format, data, effective);
  const set = (k: keyof ExportOptions) => (v: boolean) => setOptions((o) => ({ ...o, [k]: v }));

  const browse = async () => {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const f = EXPORT_FORMATS.find((x) => x.id === format)!;
      const path = await save({ defaultPath: file, filters: [{ name: f.label, extensions: [f.extension] }] });
      if (path) setFile(path);
    } catch {
      // No dialog (tests): keep typing the path.
    }
  };

  const toFile = async () => {
    const path = file.trim();
    if (!path) return;
    const target = /^([a-zA-Z]:)?[\\/]/.test(path) || !dir ? path : joinPath(dir, path);
    try {
      await call(commands.dbExportFile(target, text()));
      notifications().notify({
        level: "info",
        title: `${data.rows.length} rows exported`,
        body: target,
        key: "db-export",
      });
      closeDialog();
    } catch (e) {
      notifications().notify({
        level: "error",
        title: "Cannot export data",
        body: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <Dialog
      open
      onClose={closeDialog}
      title="Export Data"
      width={860}
      buttons={[
        { label: "Cancel", role: "cancel" },
        {
          label: "Copy to Clipboard",
          onClick: () => {
            void navigator.clipboard?.writeText(text());
            closeDialog();
          },
        },
        { label: "Export to File", role: "default", disabled: !file.trim(), onClick: () => void toFile() },
      ]}
    >
      <div className={styles.exportDialog}>
        <div className={styles.exportOptions}>
          <span className={styles.formLabel}>
            <T>Source:</T>
          </span>
          <Input readOnly value={source} aria-label="Source" />
          <span className={styles.formLabel}>
            <T>Extractor:</T>
          </span>
          <Select
            aria-label="Extractor"
            value={format}
            options={EXPORT_FORMATS.map((f) => ({ value: f.id, label: f.label }))}
            onChange={(v) => changeFormat(v as ExportFormat)}
          />
          <Checkbox checked={effective.transpose} disabled={!tabular} onChange={set("transpose")} label="Transpose" />
          <Checkbox
            checked={effective.columnHeader}
            disabled={!tabular}
            onChange={set("columnHeader")}
            label="Add column header"
          />
          <Checkbox
            checked={effective.rowHeader}
            disabled={!tabular}
            onChange={set("rowHeader")}
            label="Add row header"
          />
          <span className={styles.formLabel}>
            <T>Output file:</T>
          </span>
          <div className={styles.formRow}>
            <Input mono aria-label="Output file" value={file} onChange={(e) => setFile(e.target.value)} />
            <IconButton icon="folder" title="Browse…" onClick={() => void browse()} />
          </div>
        </div>
        <div className={styles.exportPreview}>
          <span className={styles.formLabel}>
            <T>Export preview:</T>
          </span>
          <CodePreview
            className={styles.exportPreviewText}
            aria-label="Export preview"
            sql={format === "sql"}
            text={preview + (data.rows.length > PREVIEW_ROWS ? `\n… ${data.rows.length - PREVIEW_ROWS} more rows` : "")}
          />
        </div>
      </div>
    </Dialog>
  );
}
