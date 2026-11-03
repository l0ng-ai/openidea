/**
 * "Import from .vscode/launch.json" in Run/Debug Configurations: the backend maps the file's
 * entries (`ide-run` `import`), the configurations join the dialog's draft and are saved with
 * it on OK / Apply. A notification says how many came in and why the others were left out.
 */
import type { ReactNode } from "react";
import { tx } from "@/platform/i18n";
import { call, commands, type RunConfig, type RunImport, type RunImportSource, type SkipReason } from "@/platform/ipc";
import { notifications } from "@/workbench/contributions";

/** The dialog's link for `source`. */
export function importLabel(source: RunImportSource): string {
  switch (source) {
    case "vscode":
      return tx("Import from .vscode/launch.json");
  }
}

/** Why an entry was not imported. */
export function skipReasonText(reason: SkipReason): string {
  switch (reason.kind) {
    case "nameTaken":
      return tx("A configuration with this name already exists");
    case "unsupportedType":
      return tx`The ${reason.type} debugger has no equivalent here`;
    case "unsupportedRequest":
      return tx`Request '${reason.request}' isn't supported`;
    case "unsupportedAttach":
      return tx("Only attaching to a host and port is supported");
    case "variable":
      return tx`Uses ${reason.variable}, which is known only when VS Code starts it`;
    case "nothingToRun":
      return tx("No program, module or command to run");
    case "missingMember":
      return tx`Its configuration '${reason.member}' isn't imported`;
    case "invalid":
      return tx("Not a configuration with a name");
  }
}

/** The notification telling what an import brought in and what it left out. */
export function importSummary(result: RunImport): {
  level: "info" | "warning";
  title: string;
  body?: ReactNode;
  sticky: boolean;
} {
  const n = result.imported.length;
  const file = result.file;
  const title =
    n === 0
      ? tx`No run configurations imported from ${file}`
      : n === 1
        ? tx`Imported ${n} run configuration from ${file}`
        : tx`Imported ${n} run configurations from ${file}`;
  const notes = [
    ...result.skipped.map((s) => tx`Skipped '${s.name || tx("Unnamed")}': ${skipReasonText(s.reason)}`),
    ...result.imported
      .filter((c) => c.ignored.length)
      .map((c) => tx`Left out of '${c.config.name}': ${c.ignored.join(", ")}`),
    ...result.imported
      .filter((c) => c.config.local)
      .map((c) => tx`'${c.config.name}' is saved in run.local.toml because it uses values from this machine`),
  ];
  const lines = n ? [...notes, tx("Click OK or Apply to save them.")] : notes;
  return {
    level: n ? "info" : "warning",
    title,
    ...(lines.length ? { body: lines.map((line, i) => <div key={i}>{line}</div>) } : {}),
    // The reasons stay readable until dismissed.
    sticky: notes.length > 0,
  };
}

/**
 * Configurations from `source` that `draft` (the dialog's configurations, detected ones
 * included) doesn't have by name; null when the file can't be read.
 */
export async function importConfigs(source: RunImportSource, draft: readonly RunConfig[]): Promise<RunConfig[] | null> {
  try {
    const result = await call(commands.runImportConfigs(source, [...draft]));
    notifications().notify({ group: "run", key: "run-import", ...importSummary(result) });
    return result.imported.map((c) => c.config);
  } catch (e) {
    notifications().notify({
      group: "run",
      level: "error",
      title: "Cannot import run configurations",
      body: e instanceof Error ? e.message : String(e),
      key: "run-import",
    });
    return null;
  }
}
