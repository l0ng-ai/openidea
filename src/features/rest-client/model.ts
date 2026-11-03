import defaultState from "./defaultState.json";
import { call, commands, isTauri, type PreparedRequest } from "@/platform/ipc";

export interface KvRow {
  enabled: boolean;
  key: string;
  value: string;
  description: string;
}

export interface AuthConfig {
  type: "none" | "bearer" | "basic" | "apikey";
  bearer: string;
  username: string;
  password: string;
  apiKeyKey: string;
  apiKeyVal: string;
  apiKeyIn: "header" | "query";
}

export interface BodyConfig {
  mode: "none" | "raw" | "form-data" | "urlencoded" | "graphql" | "binary";
  rawLang: string;
  raw: string;
  formData: KvRow[];
  urlencoded: KvRow[];
  graphqlQuery: string;
  graphqlVars: string;
  binaryName: string | null;
}

export interface RequestRecord {
  id: string;
  name: string;
  method: string;
  url: string;
  params: KvRow[];
  auth: AuthConfig;
  headers: KvRow[];
  body: BodyConfig;
  scripts: { preRequest: string; postResponse: string };
  settings: { timeout: number; followRedirects: boolean; disableCache: boolean };
}

export interface Collection {
  id: string;
  name: string;
  expanded: boolean;
  requests: RequestRecord[];
}

export interface Environment {
  id: string;
  name: string;
  variables: KvRow[];
}

export interface ResponseData {
  status: number;
  statusText: string;
  timeMs: number;
  sizeBytes: number;
  headers: [string, string][];
  bodyText: string;
  isJson: boolean;
  json: unknown;
  testResults: { name: string; passed: boolean; error?: string }[];
  cookies: [string, string][];
}

export interface HistoryEntry {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  status: number | null;
  timeMs: number;
  sizeBytes: number;
  response: ResponseData | null;
  error: string | null;
}

export interface ConsoleLog {
  id: string;
  level: "log" | "info" | "warn" | "error";
  message: string;
  timestamp: number;
}

export interface Tab {
  id: string;
  requestId: string | null;
  collectionId: string | null;
  dirty: boolean;
  request: RequestRecord;
  response: ResponseData | null;
  error: string | null;
  sending: boolean;
  testResults: { name: string; passed: boolean; error?: string }[];
}

export interface RestState {
  version: number;
  theme: "light" | "dark";
  workspaceName: string;
  activeRail: "collections" | "environments" | "history";
  sidebarCollapsed: boolean;
  sidebarFilter: string;
  activeEnvId: string | null;
  activeTabId: string;
  activeConfigTab: "params" | "auth" | "headers" | "body" | "scripts" | "settings";
  activeResTab: "body" | "cookies" | "headers" | "tests";
  resViewMode: "pretty" | "raw";
  jsonFolded: boolean;
  environments: Environment[];
  collections: Collection[];
  tabs: Tab[];
  history: HistoryEntry[];
  consoleLogs: ConsoleLog[];
}

const STORAGE_KEY = "OPENIDEA_REST_CLIENT_STATE_V1";

export function createDefaultState(): RestState {
  const def = structuredClone(defaultState) as unknown as RestState;

  for (const col of def.collections) {
    for (const req of col.requests) {
      if (req.params.length > 0 && req.url.includes("?")) {
        const split = req.url.split("?")[0];
        if (split) req.url = split;
      }
    }
  }

  const firstReq = structuredClone(def.collections[0]!.requests[0]!);
  const tab: Tab = {
    id: "tab-get-users",
    requestId: firstReq.id,
    collectionId: def.collections[0]!.id,
    dirty: false,
    request: firstReq,
    response: null,
    error: null,
    sending: false,
    testResults: [],
  };
  def.tabs = [tab];
  def.activeTabId = tab.id;
  def.activeRail = "collections";
  def.history = [];
  def.consoleLogs = [];
  return def;
}

export function loadState(): RestState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as RestState;
      if (parsed && parsed.version === 1 && Array.isArray(parsed.collections) && parsed.collections.length > 0) {
        if (!Array.isArray(parsed.history)) parsed.history = [];
        if (parsed.activeEnvId === undefined) parsed.activeEnvId = null;
        if (!Array.isArray(parsed.consoleLogs)) parsed.consoleLogs = [];
        for (const tab of parsed.tabs) {
          if (tab.error === undefined) tab.error = null;
          if (tab.sending === undefined) tab.sending = false;
          if (!Array.isArray(tab.testResults)) tab.testResults = [];
          if (!tab.request.auth) {
            tab.request.auth = {
              type: "none",
              bearer: "",
              username: "",
              password: "",
              apiKeyKey: "X-API-Key",
              apiKeyVal: "",
              apiKeyIn: "header",
            };
          }
          if (!tab.request.body) {
            tab.request.body = {
              mode: "none",
              rawLang: "json",
              raw: "",
              formData: [],
              urlencoded: [],
              graphqlQuery: "",
              graphqlVars: "{}",
              binaryName: null,
            };
          }
          if (!tab.request.scripts) tab.request.scripts = { preRequest: "", postResponse: "" };
          if (!tab.request.settings)
            tab.request.settings = { timeout: 15000, followRedirects: true, disableCache: false };
          if (!Array.isArray(tab.request.params)) tab.request.params = [];
          if (!Array.isArray(tab.request.headers)) tab.request.headers = [];
        }
        return parsed;
      }
    }
  } catch (e) {
    console.warn("Could not parse saved REST client state.", e);
  }
  return createDefaultState();
}

export function saveState(state: RestState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn("Could not save REST client state.", e);
  }
}

export function uid(prefix = "id"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function envVariablesMap(env: Environment | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!env) return out;
  for (const row of env.variables) {
    if (row.enabled && row.key) out[row.key] = row.value;
  }
  return out;
}

export function resolveVariables(input: string, vars: Record<string, string>): string {
  return input.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, name) => {
    const key = String(name).trim();
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key]! : `{{${key}}}`;
  });
}

export function enabledRows(rows: KvRow[]): KvRow[] {
  return rows.filter((r) => r.enabled && (r.key || r.value || r.description));
}

export function buildQueryString(rows: KvRow[], vars: Record<string, string>): string {
  return enabledRows(rows)
    .map(
      (r) =>
        `${encodeURIComponent(resolveVariables(r.key, vars))}=${encodeURIComponent(resolveVariables(r.value, vars))}`,
    )
    .join("&");
}

export function buildHeaders(headers: KvRow[], auth: AuthConfig, vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of enabledRows(headers)) {
    out[resolveVariables(row.key, vars)] = resolveVariables(row.value, vars);
  }
  if (auth.type === "bearer") {
    const token = resolveVariables(auth.bearer, vars).trim();
    if (token) out["Authorization"] = `Bearer ${token}`;
  } else if (auth.type === "basic") {
    const user = resolveVariables(auth.username, vars);
    const pass = resolveVariables(auth.password, vars);
    if (user || pass) out["Authorization"] = `Basic ${btoa(`${user}:${pass}`)}`;
  } else if (auth.type === "apikey" && auth.apiKeyIn === "header") {
    const key = resolveVariables(auth.apiKeyKey, vars).trim();
    const val = resolveVariables(auth.apiKeyVal, vars);
    if (key) out[key] = val;
  }
  return out;
}

export function bodyPayload(
  body: BodyConfig,
  headers: Record<string, string>,
  vars: Record<string, string>,
): string | undefined {
  if (body.mode === "none") return undefined;
  if (body.mode === "raw") {
    const raw = resolveVariables(body.raw, vars);
    if (body.rawLang === "json" && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
      headers["Content-Type"] = "application/json";
    }
    return raw.trim() ? raw : undefined;
  }
  if (body.mode === "urlencoded") {
    const qs = buildQueryString(body.urlencoded, vars);
    if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type"))
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    return qs || undefined;
  }
  if (body.mode === "graphql") {
    const payload = {
      query: resolveVariables(body.graphqlQuery, vars),
      variables: safeJson(resolveVariables(body.graphqlVars, vars), {}),
    };
    if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type"))
      headers["Content-Type"] = "application/json";
    return JSON.stringify(payload);
  }
  return undefined;
}

export function safeJson(text: string, fallback: unknown = null): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function createTabFromRequest(req: RequestRecord, collectionId: string | null = null): Tab {
  return {
    id: uid("tab"),
    requestId: req.id,
    collectionId,
    dirty: false,
    request: structuredClone(req),
    response: null,
    error: null,
    sending: false,
    testResults: [],
  };
}

export function methodColor(method: string): string {
  switch (method.toUpperCase()) {
    case "GET":
    case "HEAD":
      return "var(--success)";
    case "POST":
      return "var(--warning)";
    case "PUT":
      return "var(--accent)";
    case "PATCH":
      return "#7c4dff";
    case "OPTIONS":
      return "#9c27b0";
    case "DELETE":
      return "var(--danger)";
    default:
      return "var(--fg-secondary)";
  }
}

export interface RunScriptResult {
  logs: ConsoleLog[];
  tests: { name: string; passed: boolean; error?: string }[];
}

export function runPostmanScript(
  code: string,
  _phase: "pre" | "post",
  ctx: {
    request: RequestRecord;
    envVars: Record<string, string>;
    env: Environment | null;
    response?: ResponseData | null;
  },
): RunScriptResult {
  const logs: ConsoleLog[] = [];
  const tests: { name: string; passed: boolean; error?: string }[] = [];
  const pushLog = (level: ConsoleLog["level"], args: unknown[]) => {
    logs.push({
      id: uid("log"),
      level,
      message: args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "),
      timestamp: Date.now(),
    });
  };
  const pm = {
    test: (name: string, fn: () => void) => {
      try {
        fn();
        tests.push({ name, passed: true });
      } catch (e) {
        tests.push({ name, passed: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
    expect: (actual: unknown) => ({
      toBe: (expected: unknown) => {
        if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      },
      toBeTruthy: () => {
        if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`);
      },
      toBeGreaterThan: (n: number) => {
        if (!(Number(actual) > n)) throw new Error(`Expected > ${n}, got ${JSON.stringify(actual)}`);
      },
    }),
    response: ctx.response
      ? {
          code: ctx.response.status,
          text: () => ctx.response!.bodyText,
          json: () => ctx.response!.json ?? safeJson(ctx.response!.bodyText),
        }
      : undefined,
    environment: {
      set: (key: string, value: string) => {
        ctx.envVars[key] = value;
      },
      get: (key: string) => ctx.envVars[key],
    },
    variables: {
      set: (key: string, value: string) => {
        ctx.envVars[key] = value;
      },
      get: (key: string) => ctx.envVars[key],
    },
  };
  const consoleObj = {
    log: (...args: unknown[]) => pushLog("log", args),
    info: (...args: unknown[]) => pushLog("info", args),
    warn: (...args: unknown[]) => pushLog("warn", args),
    error: (...args: unknown[]) => pushLog("error", args),
  };
  try {
    const fn = new Function("pm", "console", "request", code);
    fn(pm, consoleObj, ctx.request);
  } catch (e) {
    pushLog("error", [e instanceof Error ? e.message : String(e)]);
  }
  return { logs, tests };
}

export async function executeRequest(
  tab: Tab,
  env: Environment | null,
): Promise<{
  response: ResponseData | null;
  error: string | null;
  logs: ConsoleLog[];
  tests: { name: string; passed: boolean; error?: string }[];
}> {
  const vars = envVariablesMap(env);
  const pre = runPostmanScript(tab.request.scripts.preRequest ?? "", "pre", {
    request: tab.request,
    envVars: vars,
    env,
  });
  const logs: ConsoleLog[] = [...pre.logs];
  const headers = buildHeaders(tab.request.headers, tab.request.auth, vars);

  let url = resolveVariables(tab.request.url, vars);
  // Ignore any query already present in the URL when enabled params supply it,
  // so Params and URL do not duplicate query parameters at runtime.
  if (enabledRows(tab.request.params).length > 0) {
    const q = url.indexOf("?");
    if (q >= 0) url = url.slice(0, q);
  }
  if (tab.request.auth.type === "apikey" && tab.request.auth.apiKeyIn === "query") {
    const key = resolveVariables(tab.request.auth.apiKeyKey, vars).trim();
    const val = resolveVariables(tab.request.auth.apiKeyVal, vars);
    if (key) {
      const sep = url.includes("?") ? "&" : "?";
      url = `${url}${sep}${encodeURIComponent(key)}=${encodeURIComponent(val)}`;
    }
  }

  const qs = buildQueryString(tab.request.params, vars);
  if (qs) url += (url.includes("?") ? "&" : "?") + qs;

  if (/\{\{[^}]+\}\}/.test(url)) {
    return { response: null, error: `Unresolved variable in URL: ${url}`, logs, tests: [] };
  }
  if (!/^https?:\/\//i.test(url)) {
    return { response: null, error: `Invalid URL (missing protocol): ${url}`, logs, tests: [] };
  }

  const ftHeaders = { ...headers };
  const fetchBody = bodyPayload(tab.request.body, ftHeaders, vars);

  const bodyForBackend = fetchBody ?? null;
  const preparedHeaders: [string, string][] = Object.entries(ftHeaders).map(([k, v]) => [k, v]);

  if (isTauri()) {
    const start = performance.now();
    try {
      const prepared: PreparedRequest = {
        name: null,
        method: tab.request.method,
        url,
        headers: preparedHeaders,
        body: bodyForBackend,
      };
      const r = await call(commands.httpRequest(prepared, tab.request.settings.timeout || 30000));
      const text = r.body ?? "";
      const parsed = safeJson(text);
      const isJson = parsed !== null && (text.trim().startsWith("{") || text.trim().startsWith("["));
      const response: ResponseData = {
        status: r.status,
        statusText: r.statusText || "",
        timeMs: Math.round(performance.now() - start),
        sizeBytes: r.size ?? 0,
        headers: r.headers as [string, string][],
        cookies: [],
        bodyText: text,
        isJson,
        json: isJson ? parsed : text,
        testResults: [],
      };
      const post = runPostmanScript(tab.request.scripts.postResponse ?? "", "post", {
        request: tab.request,
        envVars: vars,
        env,
        response,
      });
      response.testResults = post.tests;
      logs.push(...post.logs);
      return { response, error: null, logs, tests: post.tests };
    } catch (err: unknown) {
      const base = err instanceof Error ? err.message : String(err);
      return { response: null, error: base, logs, tests: [] };
    }
  }

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), tab.request.settings.timeout || 30000);

  const start = performance.now();
  try {
    const res = await fetch(url, {
      method: tab.request.method,
      headers: ftHeaders,
      body: fetchBody,
      signal: controller.signal,
      redirect: tab.request.settings.followRedirects ? "follow" : "manual",
    });
    window.clearTimeout(timeoutId);
    const text = await res.text();
    const sizeBytes = new Blob([text]).size;
    const responseHeaders: [string, string][] = [];
    res.headers.forEach((v, k) => responseHeaders.push([k, v]));
    const parsed = safeJson(text);
    const isJson = parsed !== null && (text.trim().startsWith("{") || text.trim().startsWith("["));
    const response: ResponseData = {
      status: res.status,
      statusText: res.statusText || "",
      timeMs: Math.round(performance.now() - start),
      sizeBytes,
      headers: responseHeaders,
      cookies: [],
      bodyText: text,
      isJson,
      json: isJson ? parsed : text,
      testResults: [],
    };
    const post = runPostmanScript(tab.request.scripts.postResponse ?? "", "post", {
      request: tab.request,
      envVars: vars,
      env,
      response,
    });
    response.testResults = post.tests;
    logs.push(...post.logs);
    return { response, error: null, logs, tests: post.tests };
  } catch (err: unknown) {
    window.clearTimeout(timeoutId);
    const base = err instanceof Error ? err.message : String(err);
    const message = /failed to fetch|load failed/i.test(base)
      ? `${base} (network/CORS/preflight blocked; browsers often require the server to explicitly allow OPTIONS as a CORS method)`
      : base;
    return { response: null, error: message, logs, tests: [] };
  }
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function colorizeJson(text: string): string {
  const tokenRe = /("(?:\\.|[^"\\])*")(\s*:)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],:])/g;
  let out = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(text)) !== null) {
    out += escapeHtml(text.slice(lastIndex, match.index));
    if (match[1]) {
      if (match[2]) {
        out += `<span style="color:var(--syn-property)">${escapeHtml(match[1])}</span><span style="color:var(--syn-punct)">${escapeHtml(match[2])}</span>`;
      } else {
        out += `<span style="color:var(--syn-string)">${escapeHtml(match[1])}</span>`;
      }
    } else if (match[3]) {
      out += `<span style="color:var(--syn-number)">${escapeHtml(match[3])}</span>`;
    } else if (match[4]) {
      out += `<span style="color:var(--syn-keyword)">${escapeHtml(match[4])}</span>`;
    } else if (match[5]) {
      out += `<span style="color:var(--syn-punct)">${escapeHtml(match[5])}</span>`;
    }
    lastIndex = tokenRe.lastIndex;
  }
  out += escapeHtml(text.slice(lastIndex));
  return out;
}

export function colorizeHtml(text: string): string {
  const re = /(<[^>]*>)|([^<]+)/g;
  let out = "";
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match[1]) {
      let tag = escapeHtml(match[1]);
      if (tag.startsWith("&lt;!--")) {
        out += `<span style="color:var(--syn-comment)">${tag}</span>`;
        continue;
      }
      tag = tag.replace(
        /^(&lt;\/?)([a-zA-Z][\w:.-]*)/,
        '$1<span style="color:var(--syn-tag);font-weight:600">$2</span>',
      );
      tag = tag.replace(
        /(\s)([a-zA-Z_:][\w:.-]*)(=)(&quot;)([^&]*?)(&quot;)/g,
        '$1<span style="color:var(--syn-attr)">$2</span>$3$4<span style="color:var(--syn-string)">$5</span>$6',
      );
      tag = tag.replace(
        /(\s)([a-zA-Z_:][\w:.-]*)(=)(&#39;)([^&]*?)(&#39;)/g,
        '$1<span style="color:var(--syn-attr)">$2</span>$3$4<span style="color:var(--syn-string)">$5</span>$6',
      );
      out += tag;
    } else if (match[2]) {
      out += escapeHtml(match[2]);
    }
  }
  return out;
}
