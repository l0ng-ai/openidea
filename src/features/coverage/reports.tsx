/**
 * Coverage reports collected elsewhere: "Import a report collected in CI from
 * disk" (lcov, JaCoCo XML, Go cover profile, SimpleCov) and "Manage Coverage Reports"
 * (choose the shown suite, delete suites and remembered imports).
 */
import { useMemo, useState } from "react";
import { create } from "zustand";
import { call, commands, isTauri } from "@/platform/ipc";
import { basename } from "@/platform/project";
import { Dialog, Icon, List, T } from "@/ui";
import { notifications, toolWindowService } from "@/workbench/contributions";
import { formatPercent } from "./model";
import {
  addSuite,
  closeSuite,
  forgetImport,
  importedReports,
  rememberImport,
  reportEntries,
  selectSuite,
  useCoverage,
  type ReportEntry,
  type Suite,
} from "./store";
import styles from "./Coverage.module.css";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function pickReport(): Promise<string | null> {
  const { open } = await import("@/platform/dialog");
  const file = await open({
    multiple: false,
    directory: false,
    title: "Import Coverage Report",
    filters: [
      {
        name: "Coverage reports (lcov, JaCoCo XML, Go cover profile)",
        extensions: ["info", "lcov", "xml", "out", "txt", "cov", "coverprofile", "json"],
      },
      { name: "All files", extensions: ["*"] },
    ],
  });
  return typeof file === "string" ? file : null;
}

/** Imports `path` (asks for a file without one) and shows it like a run's suite. */
export async function importReport(path?: string): Promise<Suite | null> {
  if (!isTauri()) {
    notifications().notify({ group: "run", level: "warning", title: "Importing coverage needs the desktop app" });
    return null;
  }
  const file = path ?? (await pickReport());
  if (!file) return null;
  try {
    const data = await call(commands.coverageImport(file));
    const suite = addSuite(basename(file), data, file);
    rememberImport({ path: file, name: suite.name, importedAt: suite.createdAt });
    try {
      toolWindowService().show("coverage");
    } catch {
      /* no workbench (tests) */
    }
    const [covered, total] = data.files.reduce((a, f) => [a[0]! + f.linesCovered, a[1]! + f.linesTotal], [0, 0]);
    notifications().notify({
      group: "run",
      level: "info",
      key: "coverage-import",
      title: `Imported coverage '${suite.name}': ${formatPercent(covered!, total!)} lines`,
      body: data.files.length ? undefined : "The report covers no files of this project.",
    });
    return suite;
  } catch (e) {
    notifications().notify({
      group: "run",
      level: "error",
      key: "coverage-import",
      title: `Cannot import ${basename(file)}`,
      body: errorText(e),
    });
    return null;
  }
}

const useManageDialog = create<{ open: boolean }>(() => ({ open: false }));

export const openManageReports = () => useManageDialog.setState({ open: true });

export function ManageReportsOverlay() {
  const open = useManageDialog((s) => s.open);
  return open ? <ManageReportsDialog onClose={() => useManageDialog.setState({ open: false })} /> : null;
}

function ManageReportsDialog({ onClose }: { onClose: () => void }) {
  const suites = useCoverage((s) => s.suites);
  const activeId = useCoverage((s) => s.activeId);
  const [imported, setImported] = useState(() => importedReports());
  const entries = useMemo(() => reportEntries(suites, imported), [suites, imported]);
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      entries.findIndex((e) => e.suite?.id === activeId),
    ),
  );
  const current: ReportEntry | undefined = entries[Math.min(active, entries.length - 1)];

  const show = async (entry: ReportEntry | undefined) => {
    if (!entry) return;
    if (entry.suite) selectSuite(entry.suite.id);
    else if (entry.file && !(await importReport(entry.file))) return;
    onClose();
  };
  const remove = (entry: ReportEntry | undefined) => {
    if (!entry) return;
    if (entry.suite) closeSuite(entry.suite.id);
    if (entry.file) {
      forgetImport(entry.file);
      setImported(importedReports());
    }
  };
  const importMore = async () => {
    if (await importReport()) setImported(importedReports());
  };

  return (
    <Dialog
      open
      title="Coverage Reports"
      onClose={onClose}
      width={560}
      buttons={[
        { label: "Import…", role: "extra", onClick: () => void importMore() },
        { label: "Delete", role: "extra", disabled: !current, onClick: () => remove(current) },
        { label: "Show Selected", role: "default", disabled: !current, onClick: () => void show(current) },
        { label: "Cancel", role: "cancel" },
      ]}
    >
      <div className={styles.reports}>
        <List<ReportEntry>
          aria-label="Coverage reports"
          items={entries}
          getKey={(e) => e.key}
          activeIndex={active}
          onActiveChange={setActive}
          onActivate={(e) => void show(e)}
          renderItem={(e) => (
            <span className={styles.reportRow}>
              <Icon name={e.file ? "folder-open" : "run-coverage"} size={16} className={styles.icon} />
              <span className={styles.label}>{e.name}</span>
              <span className={styles.reportDetail}>{e.detail}</span>
              <span className={styles.reportTime}>
                {e.suite?.id === activeId ? <T>shown</T> : e.suite ? null : <T>not loaded</T>}{" "}
                {new Date(e.time).toLocaleString()}
              </span>
            </span>
          )}
          empty={
            <div className={styles.reportsEmpty}>
              <T>No coverage reports. Run with coverage or import a report.</T>
            </div>
          }
        />
      </div>
    </Dialog>
  );
}
