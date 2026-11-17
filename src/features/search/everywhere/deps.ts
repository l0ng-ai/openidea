import { allActions, type Action } from "@/platform/actions";
import { evaluateWhen, type ContextKeys } from "@/platform/context";
import { call, commands, nextRequestId, type LanguageInfo } from "@/platform/ipc";
import { inFileSet } from "@/platform/projectRoots";
import { searchEndpoints, searchableSettings, useProjectViewRoots } from "@/workbench/contributions";
import { projectRoot } from "../common/open";
import { cancelRequest, streamSearch } from "@/platform/textSearch";
import type { SeDeps } from "./controller";
import type { OutsideFile } from "./model";
import { recentActions } from "./store";

/** Backend-backed sources; action enablement is judged against `ctx` (captured on open). */
export function ipcDeps(ctx: ContextKeys): SeDeps {
  let outside: Promise<OutsideFile[]> | null = null;
  return {
    findFiles: (q, limit) => call(commands.findFiles(q, limit)),
    findDirs: (q, limit) => call(commands.findDirs(q, limit)),
    // Listed once per popup: scratch files are few and change only through the IDE.
    outsideFiles: () => (outside ??= listScratchFiles()),
    findSymbols: (q, filter, limit) => call(commands.findSymbols(q, filter, limit)),
    workspaceSymbols: (request, q) => call(commands.lspWorkspaceSymbols(request, q)),
    searchText: async (request, query, onFile) => {
      await streamSearch(request, query, onFile);
    },
    cancel: cancelRequest,
    nextRequestId,
    actions: () => allActions(),
    isEnabled: (a: Action) => {
      try {
        return evaluateWhen(a.when, ctx);
      } catch {
        return false;
      }
    },
    recentFiles: async () => (await call(commands.recentFiles())).map(String),
    recentActions,
    settings: searchableSettings,
    root: projectRoot,
    now: () => performance.now(),
    inFileSet: (set, path) => inFileSet(set, path),
    routes: () => searchEndpoints(projectRoot()),
  };
}

let languages: Promise<LanguageInfo[]> | null = null;

/** The backend's language list (file types of the Files / Symbols filters), loaded once. */
export function loadLanguages(): Promise<LanguageInfo[]> {
  return (languages ??= commands.languages().catch(() => {
    languages = null;
    return [];
  }));
}

const MAX_OUTSIDE_FILES = 2000;
const MAX_OUTSIDE_DEPTH = 4;

/** Files under the project view's Scratches roots, as `<root label>/<relative path>`. */
async function listScratchFiles(): Promise<OutsideFile[]> {
  const out: OutsideFile[] = [];
  const walk = async (dir: string, rel: string, depth: number) => {
    const entries = await call(commands.fsReadDir(dir)).catch(() => []);
    for (const e of entries) {
      if (out.length >= MAX_OUTSIDE_FILES) return;
      const path = e.path;
      if (e.kind === "dir") {
        if (depth < MAX_OUTSIDE_DEPTH) await walk(path, `${rel}/${e.name}`, depth + 1);
      } else out.push({ path, relPath: `${rel}/${e.name}` });
    }
  };
  for (const root of useProjectViewRoots.getState().roots.values())
    if (root.scope === "scratches" && root.path) await walk(root.path, root.label, 0);
  return out;
}
