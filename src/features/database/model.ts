/** Pure helpers of the database tools: clipboard formats, edits, labels. */
import type {
  DbCellValue,
  DbColor,
  DbProperty,
  DbRowEdit,
  DbSortKey,
  DbSsh,
  DbSslMode,
  DataSource,
} from "@/platform/ipc";
import type { SshConfigValid } from "@/platform/remoteSettings";
import { vendorOf, vendorOfScheme } from "./vendors";

export type Cell = string | null;

/** Tab-separated values (Excel / IDEA "Copy"): NULL is empty, tabs / newlines become spaces. */
export function toTsv(header: readonly string[] | null, rows: ReadonlyArray<readonly Cell[]>): string {
  const clean = (v: Cell) => (v ?? "").replace(/[\t\r\n]+/g, " ");
  const lines = rows.map((r) => r.map(clean).join("\t"));
  if (header) lines.unshift(header.map(clean).join("\t"));
  return lines.join("\n");
}

/** RFC 4180 CSV; NULL is an empty field. */
export function toCsv(header: readonly string[] | null, rows: ReadonlyArray<readonly Cell[]>): string {
  const field = (v: Cell) => {
    const s = v ?? "";
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map((r) => r.map(field).join(","));
  if (header) lines.unshift(header.map(field).join(","));
  return lines.join("\r\n");
}

/** Rows of RFC 4180 text with separator `sep` (quoted fields, `""`, CR LF); a trailing newline adds no row. */
export function parseDelimited(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === sep) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** The separator of delimited text: tab when its first line has more tabs than commas or semicolons. */
export function guessSeparator(text: string): string {
  const first = text.slice(0, text.search(/\r?\n|$/));
  const count = (c: string) => first.split(c).length - 1;
  return [",", "\t", ";"].reduce((best, c) => (count(c) > count(best) ? c : best), ",");
}

/**
 * Insert edits importing `rows` into a table with `columns`: by header name
 * (case-insensitive; unknown names skipped) or by position. `emptyAsNull`
 * turns empty fields into NULL.
 */
export function importEdits(
  rows: readonly string[][],
  columns: readonly string[],
  header: boolean,
  emptyAsNull: boolean,
): { edits: DbRowEdit[]; mapped: string[] } {
  const target = (h: string) => columns.find((c) => c.toLowerCase() === h.trim().toLowerCase()) ?? null;
  const map: Array<string | null> = header
    ? (rows[0] ?? []).map(target)
    : columns.slice(0, Math.max(0, ...rows.map((r) => r.length)));
  const body = header ? rows.slice(1) : rows;
  const edits: DbRowEdit[] = body
    .filter((r) => r.some((v) => v !== ""))
    .map((r) => ({
      kind: "insert",
      values: map.flatMap((column, i) =>
        column === null ? [] : [{ column, value: emptyAsNull && (r[i] ?? "") === "" ? null : (r[i] ?? null) }],
      ),
    }));
  return { edits, mapped: map.filter((c): c is string => c !== null) };
}

/** Pending changes of the table editor. Row indices refer to the loaded page. */
export interface PendingEdits {
  /** row → column → new value. */
  updates: Map<number, Map<string, Cell>>;
  deletes: Set<number>;
  /** New rows: column → value (absent columns use their default). */
  inserts: Array<Map<string, Cell>>;
}

export const emptyEdits = (): PendingEdits => ({ updates: new Map(), deletes: new Set(), inserts: [] });

export function hasEdits(e: PendingEdits): boolean {
  return e.updates.size > 0 || e.deletes.size > 0 || e.inserts.length > 0;
}

/** The DML requests for `edits` of a page with `columns` / `rows`, keyed by `primaryKey`. */
export function buildRowEdits(
  columns: readonly string[],
  rows: ReadonlyArray<readonly Cell[]>,
  primaryKey: readonly string[],
  edits: PendingEdits,
): DbRowEdit[] {
  const keyOf = (row: number): DbCellValue[] =>
    primaryKey.map((c) => ({ column: c, value: rows[row]?.[columns.indexOf(c)] ?? null }));
  const out: DbRowEdit[] = [];
  for (const [row, changes] of edits.updates) {
    if (edits.deletes.has(row) || !changes.size) continue;
    out.push({ kind: "update", key: keyOf(row), values: [...changes].map(([column, value]) => ({ column, value })) });
  }
  for (const row of [...edits.deletes].sort((a, b) => a - b)) out.push({ kind: "delete", key: keyOf(row) });
  for (const ins of edits.inserts)
    out.push({ kind: "insert", values: [...ins].map(([column, value]) => ({ column, value })) });
  return out;
}

/** IDEA's default name of a file data source: the file name without its extension (`shop.db` → `shop`). */
export function fileSourceName(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? file;
  return base.replace(/\.[^.]+$/, "") || base;
}

/** The tree / menu icon of a data source (IDEA shows the vendor's mark). */
export function sourceIcon(s: Pick<DataSource, "vendor" | "driver">): string {
  return vendorOf(s).icon;
}

export function sourceLabel(s: Pick<DataSource, "name" | "driver" | "vendor">): string {
  return `${s.name} (${vendorOf(s).label})`;
}

/** The token of a data source colour (tree rows, console tab). */
export function colorVar(color: DbColor | null | undefined): string | undefined {
  return color ? `var(--db-color-${color})` : undefined;
}

/** `*` / `?` wildcard match of the Schemas tab (case-sensitive, like the server's names). */
export function matchesPattern(name: string, pattern: string): boolean {
  if (!/[*?]/.test(pattern)) return name === pattern;
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${re}$`).test(name);
}

/** The table editor's ORDER BY field for a sort: `name DESC, id`. */
export function formatOrderBy(sort: readonly DbSortKey[]): string {
  return sort.map((k) => (k.descending ? `${k.column} DESC` : k.column)).join(", ");
}

/** Parses the ORDER BY field (`col [ASC|DESC], …`, names matched case-insensitively); null when a part isn't a column. */
export function parseOrderBy(text: string, columns: readonly string[]): DbSortKey[] | null {
  const out: DbSortKey[] = [];
  for (const part of text
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)) {
    const m = /^("?)([^"]+?)\1(?:\s+(asc|desc))?$/i.exec(part);
    const column = m && columns.find((c) => c.toLowerCase() === m[2]!.trim().toLowerCase());
    if (!column) return null;
    out.push({ column, descending: m[3]?.toLowerCase() === "desc" });
  }
  return out;
}

/** Schemas tab › Object filter: `name` matches one of its patterns (comma / space separated; empty: all). */
export function passesObjectFilter(name: string, filter: string | null | undefined): boolean {
  const patterns = (filter ?? "").split(/[\s,]+/).filter(Boolean);
  return !patterns.length || patterns.some((p) => matchesPattern(name.toLowerCase(), p.toLowerCase()));
}

/**
 * The databases / schemas the tree shows (Schemas tab): all of them, or the
 * ones matching a chosen name or pattern; `keep` (the connected database) always stays.
 */
export function shownNames(
  names: readonly string[],
  all: boolean | undefined,
  chosen: readonly string[] | undefined,
  keep?: string | null,
): string[] {
  if (all !== false) return [...names];
  const picks = (chosen ?? []).map((p) => p.trim()).filter(Boolean);
  return names.filter((n) => n === keep || picks.some((p) => matchesPattern(n, p)));
}

/**
 * Connected targets idle for longer than their data source's Auto-disconnect
 * (`lastUsed`: ms of the last statement / introspection; `busy`: running or holding a transaction).
 */
export function idleTargets(
  connected: Iterable<string>,
  sources: readonly DataSource[],
  lastUsed: ReadonlyMap<string, number>,
  busy: (target: string) => boolean,
  now: number,
): string[] {
  const out: string[] = [];
  for (const t of connected) {
    const secs = sources.find((s) => s.id === splitTarget(t).id)?.options?.autoDisconnectSecs;
    if (!secs || busy(t)) continue;
    if (now - (lastUsed.get(t) ?? now) >= secs * 1000) out.push(t);
  }
  return out;
}

export function newSourceId(): string {
  const rnd =
    typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return rnd.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 36);
}

/** What a failed connection needs from the user before retrying. */
export type ConnectRemedy = "password" | "sshSecret" | "trustHostKey" | null;

/**
 * Classifies a connection error: an unknown SSH host key to confirm, a missing
 * or rejected SSH password / passphrase, or a database password. A changed host
 * key is never offered for trust.
 */
export function connectRemedy(
  kind: string | undefined,
  message: string,
  source?: Pick<DataSource, "ssh">,
): ConnectRemedy {
  if (/^Unknown SSH host key/.test(message)) return "trustHostKey";
  if (kind !== "permissionDenied") return null;
  if (/^SSH host key .* has changed/.test(message)) return null;
  if (/^SSH (password|key passphrase) required|^cannot decrypt SSH key/.test(message)) return "sshSecret";
  if (/^SSH authentication failed/.test(message))
    // With OpenSSH config + agent there is nothing to type unless a key is encrypted.
    return source?.ssh?.auth === "openSsh" ? null : "sshSecret";
  return "password";
}

/** The SSH user@host of a data source, for prompts. */
export function sshLabel(source: Pick<DataSource, "ssh">): string {
  const ssh = source.ssh;
  if (!ssh?.host) return "";
  return `${ssh.user ? `${ssh.user}@` : ""}${ssh.host}${ssh.port ? `:${ssh.port}` : ""}`;
}

/** The SSH configuration a tunnel connects with; undefined for the inline fields or a missing one. */
export function sshConfigOf(
  ssh: DbSsh | null | undefined,
  configs: readonly SshConfigValid[],
): SshConfigValid | undefined {
  const id = ssh?.config?.trim();
  return id ? configs.find((c) => c.id === id) : undefined;
}

/** The SSH settings in effect: those of the chosen SSH configuration, else the inline fields. */
export function effectiveSsh(ssh: DbSsh | null | undefined, configs: readonly SshConfigValid[]): DbSsh | null {
  if (!ssh) return null;
  const c = sshConfigOf(ssh, configs);
  return c
    ? { ...ssh, host: c.host, port: c.port, user: c.user, auth: c.auth, keyFile: c.keyFile, saveSecret: c.saveSecret }
    : ssh;
}

/** Whether the SSH tab names a host to tunnel through (always, when the tunnel is off). */
export function sshTunnelReady(ssh: DbSsh | null | undefined, configs: readonly SshConfigValid[]): boolean {
  if (!ssh?.enabled) return true;
  if (ssh.config?.trim()) return !!sshConfigOf(ssh, configs)?.host.trim();
  return !!ssh.host?.trim();
}

/**
 * Connection target (backend `split_target`): a data source id for its configured
 * database, or `<id>:<database>` for another database of the same server.
 */
export function splitTarget(target: string): { id: string; database: string | null } {
  const i = target.indexOf(":");
  return i < 0 ? { id: target, database: null } : { id: target.slice(0, i), database: target.slice(i + 1) || null };
}

/** The target of database `database` of data source `id`; the connected one is the data source itself. */
export function targetOf(id: string, database: string | null, current: string | null): string {
  return !database || database === current ? id : `${id}:${database}`;
}

/** Key of the Database tree node of database `name` of data source `id`. */
export const databaseKey = (id: string, name: string) => `${id}/@${name}`;

const SSL_MODES: Record<string, DbSslMode> = {
  disable: "disable",
  disabled: "disable",
  prefer: "prefer",
  preferred: "prefer",
  require: "require",
  required: "require",
  "verify-ca": "verifyCa",
  verify_ca: "verifyCa",
  "verify-full": "verifyFull",
  verify_identity: "verifyFull",
  "verify-identity": "verifyFull",
};

/**
 * Data Source from URL (and the General tab's URL field): `postgres://user:pass@host:5432/db`,
 * `mysql://…`, `mariadb://…`, wire-compatible products (`redshift://`, `tidb://`…), the
 * `jdbc:` forms of those, `jdbc:sqlite:path` / `sqlite:path`. SSL parameters fill the
 * SSL tab, other parameters become driver properties. Null when the URL names no supported driver.
 */
export function parseSourceUrl(raw: string): { source: Partial<DataSource>; password: string | null } | null {
  const url = raw.trim().replace(/^jdbc:/i, "");
  const sqlite = /^sqlite3?:(?:\/\/)?(.+)$/i.exec(url);
  if (sqlite) {
    const file = sqlite[1]!.replace(/^\/([A-Za-z]:)/, "$1");
    return { source: { driver: "sqlite", file, name: fileSourceName(file) }, password: null };
  }
  const m =
    /^([a-z][a-z0-9]*):\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^:/?,]+|\[[^\]]+\])(?::(\d+))?(?:,[^/?]*)?(?:\/([^?]*))?(?:\?(.*))?$/i.exec(
      url,
    );
  const vendor = m ? vendorOfScheme(m[1]!) : undefined;
  if (!m || !vendor || vendor.driver === "sqlite") return null;
  const dec = (s: string | undefined) => {
    try {
      return s ? decodeURIComponent(s) : "";
    } catch {
      return s ?? "";
    }
  };
  const port = m[5] ? parseInt(m[5], 10) : null;
  if (port !== null && !(port > 0 && port < 65536)) return null;
  let user = dec(m[2]);
  let password = m[3] !== undefined ? dec(m[3]) : null;
  const host = m[4]!.replace(/^\[(.*)\]$/, "$1");
  const source: Partial<DataSource> = {
    driver: vendor.driver,
    host,
    port,
    user,
    database: dec(m[6]).replace(/\/$/, ""),
  };
  if (vendor.id !== vendor.driver) source.vendor = vendor.id;
  const properties: DbProperty[] = [];
  for (const [k, v] of new URLSearchParams(m[7] ?? "")) {
    switch (k.toLowerCase()) {
      case "user":
        user ||= v;
        break;
      case "password":
        password ??= v;
        break;
      case "sslmode":
      case "ssl-mode": {
        const mode = SSL_MODES[v.toLowerCase()];
        if (mode) source.ssl = mode;
        break;
      }
      case "sslrootcert":
      case "ssl-ca":
        source.sslCaFile = v;
        break;
      case "sslcert":
      case "ssl-cert":
        source.sslCertFile = v;
        break;
      case "sslkey":
      case "ssl-key":
        source.sslKeyFile = v;
        break;
      default:
        properties.push({ name: k, value: v });
    }
  }
  source.user = user;
  if (properties.length) source.properties = properties;
  return { source, password };
}
