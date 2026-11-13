/** HTTP Client state: selected environment per file, responses, history, running request. */
import { create } from "zustand";
import {
  call,
  commands,
  isCancelled,
  nextRequestId,
  type HttpHistoryEntry,
  type HttpExchange,
  type HttpRequestBlock,
  type RequestId,
} from "@/platform/ipc";
import { writeClipboardText } from "@/platform/clipboard";
import { editorService, notifications, showServiceView, showStatusInfo } from "@/workbench/contributions";

export const SERVICE_VIEW = "httpClient";
const ENV_KEY = "openidea.httpClient.environments";

function readEnvChoices(): Record<string, string> {
  try {
    const raw = localStorage.getItem(ENV_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

interface Running {
  path: string | null;
  index: number;
  request: RequestId;
  /** The request line as written, once parsed. */
  method?: string;
  url?: string;
}

interface HttpClientState {
  /** Selected environment per request file (absent: none). */
  envByFile: Record<string, string>;
  /** Environments available per request file. */
  environments: Record<string, string[]>;
  /** History entries, newest first (this session's runs included). */
  history: HttpHistoryEntry[];
  /** Loaded exchanges by entry id. */
  exchanges: Record<string, HttpExchange>;
  selected: string | null;
  running: Running | null;
}

export const useHttpClient = create<HttpClientState>(() => ({
  envByFile: readEnvChoices(),
  environments: {},
  history: [],
  exchanges: {},
  selected: null,
  running: null,
}));

export function setEnvironment(path: string, env: string | null) {
  useHttpClient.setState((s) => {
    const envByFile = { ...s.envByFile };
    if (env) envByFile[path] = env;
    else delete envByFile[path];
    try {
      localStorage.setItem(ENV_KEY, JSON.stringify(envByFile));
    } catch {
      // Per-viewer convenience only.
    }
    return { envByFile };
  });
}

export async function loadEnvironments(path: string): Promise<string[]> {
  try {
    const names = await call(commands.httpEnvironments(path));
    useHttpClient.setState((s) => ({ environments: { ...s.environments, [path]: names } }));
    return names;
  } catch (e) {
    notifications().notify({
      level: "warning",
      title: "HTTP Client environments",
      body: e instanceof Error ? e.message : String(e),
      key: "http-env",
    });
    return [];
  }
}

/** The environment a run of `path` uses: the chosen one if it still exists. */
export function effectiveEnvironment(path: string | null): string | null {
  if (!path) return null;
  const s = useHttpClient.getState();
  const chosen = s.envByFile[path];
  const available = s.environments[path];
  if (chosen && (!available || available.includes(chosen))) return chosen;
  return null;
}

export async function refreshHistory() {
  try {
    const history = await call(commands.httpHistory());
    useHttpClient.setState({ history });
  } catch {
    // No project.
  }
}

export async function selectEntry(id: string) {
  useHttpClient.setState({ selected: id });
  if (useHttpClient.getState().exchanges[id]) return;
  try {
    const ex = await call(commands.httpHistoryGet(id));
    useHttpClient.setState((s) => ({ exchanges: { ...s.exchanges, [id]: ex } }));
  } catch (e) {
    notifications().notify({
      level: "error",
      title: "Cannot open the response",
      body: e instanceof Error ? e.message : String(e),
    });
  }
}

export async function clearHistory() {
  await call(commands.httpHistoryClear());
  useHttpClient.setState({ history: [], exchanges: {}, selected: null });
}

export function parseRequests(text: string): Promise<HttpRequestBlock[]> {
  return commands.httpRequests(text);
}

/**
 * Sends request `index` of `text` (the buffer of `path`). The response opens
 * in the HTTP Client tool window. Returns false when cancelled or failed early.
 */
export async function runRequest(path: string | null, text: string, index: number): Promise<boolean> {
  const busy = useHttpClient.getState().running;
  if (busy) void commands.cancelRequest(busy.request);
  const request = nextRequestId();
  useHttpClient.setState({ running: { path, index, request } });
  // The tool window shows the request as it is sent, not only once it has answered.
  showServiceView(SERVICE_VIEW, false);
  void parseRequests(text)
    .then((blocks) => {
      const block = blocks.find((b) => b.index === index);
      const running = useHttpClient.getState().running;
      if (block && running?.request === request)
        useHttpClient.setState({ running: { ...running, method: block.method, url: block.url } });
    })
    .catch(() => {});
  try {
    if (path && !useHttpClient.getState().environments[path]) await loadEnvironments(path);
    const ex = await call(commands.httpExecute(request, path, text, index, effectiveEnvironment(path)));
    useHttpClient.setState((s) => ({
      history: [ex.entry, ...s.history.filter((h) => h.id !== ex.entry.id)],
      exchanges: { ...s.exchanges, [ex.entry.id]: ex },
      selected: ex.entry.id,
    }));
    return true;
  } catch (e) {
    if (!isCancelled(e))
      notifications().notify({
        level: "error",
        title: "Cannot send the request",
        body: e instanceof Error ? e.message : String(e),
        key: "http-run",
      });
    return false;
  } finally {
    if (useHttpClient.getState().running?.request === request) useHttpClient.setState({ running: null });
  }
}

/** Convert to cURL and Copy: request `index` of `text`, with the file's environment applied. */
export async function copyAsCurl(path: string | null, text: string, index: number): Promise<void> {
  try {
    if (path && !useHttpClient.getState().environments[path]) await loadEnvironments(path);
    await writeClipboardText(await call(commands.httpCurl(path, text, index, effectiveEnvironment(path))));
    showStatusInfo("The request was copied as a cURL command");
  } catch (e) {
    notifications().notify({
      level: "error",
      title: "Cannot convert the request to cURL",
      body: e instanceof Error ? e.message : String(e),
      key: "http-curl",
    });
  }
}

/** A pasted `curl …` command as request text; null when it isn't one. */
export function requestFromCurl(command: string): Promise<string | null> {
  return commands.httpFromCurl(command);
}

/** Add Environment to Public / Private File: opens the env file that applies to `path`, created if missing. */
export async function openEnvironmentFile(path: string, isPrivate: boolean): Promise<void> {
  try {
    const file = await call(commands.httpEnvironmentFile(path, isPrivate));
    await editorService().openFile(file, { focus: true });
    void loadEnvironments(path);
  } catch (e) {
    notifications().notify({
      level: "error",
      title: "Cannot create the environment file",
      body: e instanceof Error ? e.message : String(e),
      key: "http-env-file",
    });
  }
}

/** Runs every request of the file in order; stops when one is cancelled. */
export async function runAll(path: string | null, text: string): Promise<void> {
  const blocks = await parseRequests(text);
  for (const b of blocks) {
    if (!(await runRequest(path, text, b.index))) return;
  }
}

export function cancelRunning() {
  const r = useHttpClient.getState().running;
  if (r) void commands.cancelRequest(r.request);
}

/** The window switched projects: history, responses and environments belong to the previous one. */
export function resetHttpClient() {
  cancelRunning();
  useHttpClient.setState({ environments: {}, history: [], exchanges: {}, selected: null, running: null });
}
