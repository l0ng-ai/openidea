/**
 * System Settings › HTTP Proxy as the UI consumes it (mirrors
 * `ide-core::proxy_settings` defaults). Normalisation never throws.
 */
export type ProxyModeValid = "none" | "auto" | "manual";
export type ProxyKindValid = "http" | "socks";

export interface ProxySettingsValid {
  mode: ProxyModeValid;
  kind: ProxyKindValid;
  host: string;
  port: number;
  /** Comma-separated host globs reached directly (`*.example.com, 192.168.*`). */
  noProxy: string;
  authenticate: boolean;
  login: string;
  /** Kept in the saved passwords by the backend, not in settings.toml. */
  password: string;
}

export const PROXY_DEFAULT_PORT: Record<ProxyKindValid, number> = {
  http: 80,
  socks: 1080,
};
export const PROXY_PORT_LIMITS = { min: 1, max: 65535 } as const;

export const DEFAULT_PROXY: ProxySettingsValid = {
  mode: "auto",
  kind: "http",
  host: "",
  port: PROXY_DEFAULT_PORT.http,
  noProxy: "",
  authenticate: false,
  login: "",
  password: "",
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown) => (typeof v === "string" ? v : "");

export function validateProxy(raw: unknown): ProxySettingsValid {
  const p = obj(raw);
  const mode: ProxyModeValid = p.mode === "none" || p.mode === "manual" ? p.mode : "auto";
  const kind: ProxyKindValid = p.kind === "socks" ? "socks" : "http";
  const port =
    typeof p.port === "number" &&
    Number.isInteger(p.port) &&
    p.port >= PROXY_PORT_LIMITS.min &&
    p.port <= PROXY_PORT_LIMITS.max
      ? p.port
      : PROXY_DEFAULT_PORT[kind];
  return {
    mode,
    kind,
    host: str(p.host),
    port,
    noProxy: str(p.noProxy),
    authenticate: p.authenticate === true,
    login: str(p.login),
    password: str(p.password),
  };
}

/** Switching HTTP ⇄ SOCKS moves a default port along. */
export function withProxyKind(p: ProxySettingsValid, kind: ProxyKindValid): ProxySettingsValid {
  const port = p.port === PROXY_DEFAULT_PORT[p.kind] ? PROXY_DEFAULT_PORT[kind] : p.port;
  return { ...p, kind, port };
}

/** What keeps a manual configuration from working (as the backend checks it), or `null`. */
export function proxyProblem(p: ProxySettingsValid): string | null {
  if (p.mode !== "manual") return null;
  const host = p.host.trim();
  if (!host) return "Proxy host is empty";
  if (/[/@\s]/.test(host)) return "Invalid proxy host";
  if (p.port < PROXY_PORT_LIMITS.min || p.port > PROXY_PORT_LIMITS.max) {
    return "Proxy port must be between 1 and 65535";
  }
  if (p.authenticate && !p.login.trim()) return "Proxy login is empty";
  return null;
}
