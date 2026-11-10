import { allActions, type Action } from "@/platform/actions";
import { evaluateWhen, type ContextKeys } from "@/platform/context";
import { call, commands, nextRequestId, type LanguageInfo } from "@/platform/ipc";
import { inFileSet } from "@/platform/projectRoots";
import { searchEndpoints, searchableSettings } from "@/workbench/contributions";
import { projectRoot } from "../common/open";
import { cancelRequest, streamSearch } from "@/platform/textSearch";
import type { SeDeps } from "./controller";
import { recentActions } from "./store";

/** Backend-backed sources; action enablement is judged against `ctx` (captured on open). */
export function ipcDeps(ctx: ContextKeys): SeDeps {
  return {
    findFiles: (q, limit) => call(commands.findFiles(q, limit)),
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
