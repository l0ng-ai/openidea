// Ported from JetBrains intellij-community plugins/mcp-server (mcpserver.frontend/src/actions/ShowMcpToolsAction.kt, settings/McpToolFilterPanel.kt `exportToMarkdown`), Apache-2.0.
/**
 * Export to Markdown: the tools offered under the saved settings
 * (`mcpExportToolsMarkdown`), saved to a file the user picks (`mcp_tools.md`)
 * or copied to the clipboard.
 */
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { copyText } from "@/ui";
import { notifications } from "@/workbench/contributions";
import { ask } from "@/workbench/messages";

const KEY = "mcp.exportTools";
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function pickFile(): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  return (
    (await save({
      title: tx("Export MCP Tools"),
      defaultPath: "mcp_tools.md",
      filters: [{ name: "Markdown", extensions: ["md"] }],
    })) ?? null
  );
}

export interface ExportDeps {
  pick?: () => Promise<string | null>;
  write?: (path: string, text: string) => Promise<void>;
  copy?: (text: string) => Promise<void>;
}

async function writeFile(path: string, text: string) {
  // The save dialog already confirmed replacing an existing file.
  await call(commands.fsDelete(path)).catch(() => {});
  await call(commands.fsCreateFileBytes(path, Array.from(new TextEncoder().encode(text))));
}

/** Asks where the Markdown goes (a file or the clipboard), then writes it there. */
export async function exportToolsMarkdown(deps: ExportDeps = {}): Promise<void> {
  const choice = await ask({
    title: "Export MCP Tools",
    body: tx("Save MCP tools information as Markdown"),
    icon: "info",
    buttons: [
      { id: "save", label: "Export to Markdown", primary: true },
      { id: "copy", label: "Copy to Clipboard" },
    ],
  });
  if (choice.button !== "save" && choice.button !== "copy") return;
  try {
    if (choice.button === "copy") {
      const markdown = await commands.mcpExportToolsMarkdown();
      await (deps.copy ?? copyText)(markdown);
      notifications().notify({ level: "info", title: "MCP tools copied to the clipboard", key: KEY, group: "mcp" });
      return;
    }
    const path = await (deps.pick ?? pickFile)();
    if (!path) return;
    const markdown = await commands.mcpExportToolsMarkdown();
    await (deps.write ?? writeFile)(path, markdown);
    notifications().notify({ level: "info", title: "MCP tools exported", body: path, key: KEY, group: "mcp" });
  } catch (e) {
    notifications().notify({
      level: "error",
      title: "Cannot export the MCP tools",
      body: errorText(e),
      key: KEY,
      group: "mcp",
    });
  }
}
