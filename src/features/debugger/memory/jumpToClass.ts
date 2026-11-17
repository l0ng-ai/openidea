import { call, commands, nextRequestId, type SymbolKind, type WorkspaceSymbol } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { maybeEditorService, notifications } from "@/workbench/contributions";

const TYPE_KINDS = new Set<SymbolKind>(["class", "interface", "enum", "struct"]);

/** Some servers put more before the package (`app.jar com.x`); a bare suffix match would also take `com.ax` or `a.x` for `x`. */
function inPackage(container: string | null, pkg: string): boolean {
  const c = container ?? "";
  if (c === pkg) return true;
  return pkg !== "" && c.endsWith(pkg) && /[^\w$.]$/.test(c.slice(0, -pkg.length));
}

/** Opens the source of a JVM class (`com.x.Order$Line[]` opens `com.x.Order`); `false` and a notification when none is found. */
export async function jumpToClass(className: string): Promise<boolean> {
  const outer = className.replace(/(\[\])+$/, "").split("$")[0]!;
  const dot = outer.lastIndexOf(".");
  const simple = outer.slice(dot + 1);
  const pkg = dot < 0 ? "" : outer.slice(0, dot);
  let hit: WorkspaceSymbol | undefined;
  try {
    const symbols = await call(commands.lspWorkspaceSymbols(nextRequestId(), simple));
    hit = symbols.find((s) => s.name === simple && TYPE_KINDS.has(s.kind) && inPackage(s.container, pkg));
  } catch {
    hit = undefined;
  }
  const editor = maybeEditorService();
  if (!hit || !editor) {
    const name = className;
    notifications().notify({ level: "warning", title: tx`Could not find the source of ${name}.` });
    return false;
  }
  const { line, col } = hit.location.range.start;
  await editor.openFile(hit.location.path, { selection: { line, col } });
  return true;
}
