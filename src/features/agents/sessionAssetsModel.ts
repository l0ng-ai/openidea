/**
 * Extracts and normalizes a session's relevant Pull Requests, created Issues, References
 * (Issues, Commits, Discussions), and Artifacts (Websites, Files) from the task's
 * conversation entries and live Git/GitHub metadata.
 */
import type { AgentEntry, AgentTask, PullRequestSummary } from "@/bindings";
import { basename } from "@/platform/project";
import { fileHref, pathLink } from "./conversation";
import { fencedBlocks, messageTokens, parseMention, resolveTyped } from "./composerModel";

export type PullRequestAssetState = "open" | "merged" | "closed" | "draft";
export type IssueAssetState = "open" | "closed";

export interface RemoteItemMeta {
  title?: string;
  state?: PullRequestAssetState | IssueAssetState;
}

export interface SessionPullRequest {
  key: string;
  host: string;
  repo: string;
  number: number;
  idLabel: string;
  title: string;
  state: PullRequestAssetState;
  url: string;
  /** `"owner/repo"` when hosted on `github.com` (eligible for `gh api` enrichment). */
  githubRepo: string | null;
  hasExplicitTitle: boolean;
  hasExplicitState: boolean;
}

export interface SessionIssue {
  key: string;
  host: string;
  repo: string;
  number: number | null;
  idLabel: string;
  title: string;
  state: IssueAssetState;
  url: string;
  githubRepo: string | null;
  hasExplicitTitle: boolean;
  hasExplicitState: boolean;
}

export type SessionReferenceKind = "issue" | "commit" | "discussion";

export interface SessionReference {
  key: string;
  kind: SessionReferenceKind;
  idLabel: string;
  title: string;
  state?: IssueAssetState;
  url: string;
  repo: string;
  githubIssue?: { repo: string; number: number };
  hasExplicitTitle: boolean;
  hasExplicitState: boolean;
}

export type SessionArtifact =
  | {
      key: string;
      kind: "website";
      title: string;
      url: string;
    }
  | {
      key: string;
      kind: "file";
      name: string;
      path: string;
      rel: string | null;
      externalBinary: boolean;
    };

export interface SessionAssetsData {
  pullRequests: SessionPullRequest[];
  createdIssues: SessionIssue[];
  references: SessionReference[];
  artifacts: SessionArtifact[];
}

export interface ParsedRemote {
  host: string;
  repo: string;
  kind: "github" | "gitlab" | "other";
}

const DISMISSED_ASSETS_KEY = "openidea.agents.dismissedAssets.v1";

function loadAllDismissed(): Record<string, string[]> {
  try {
    const raw = globalThis.localStorage?.getItem(DISMISSED_ASSETS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, string[]>;
  } catch {
    return {};
  }
}

export function loadTaskDismissed(taskId: string): Set<string> {
  const list = loadAllDismissed()[taskId];
  return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
}

export function saveTaskDismissed(taskId: string, keys: ReadonlySet<string>) {
  try {
    const all = loadAllDismissed();
    if (keys.size === 0) delete all[taskId];
    else all[taskId] = [...keys];
    globalThis.localStorage?.setItem(DISMISSED_ASSETS_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable */
  }
}

export function clearDismissedAssets(taskId: string) {
  saveTaskDismissed(taskId, new Set());
}

const DEFAULT_BRANCHES = new Set(["main", "master", "develop", "dev", "trunk", "head"]);

/** True when `branch` is a feature/topic branch worth checking for an associated PR. */
export function isFeatureBranch(branch: string | null | undefined): branch is string {
  if (!branch) return false;
  const clean = branch.trim();
  if (!clean || DEFAULT_BRANCHES.has(clean.toLowerCase())) return false;
  // Detached SHA.
  if (/^[0-9a-f]{7,40}$/i.test(clean)) return false;
  return true;
}

/**
 * Parses a git remote URL (`https://github.com/o/r.git`, `git@github.com:o/r.git`,
 * SSH aliases like `git@github-personal:o/r.git`, or `ssh://git@host/o/r.git`).
 */
export function parseRemoteCoordinates(remoteUrl: string | null | undefined): ParsedRemote | null {
  const raw = remoteUrl?.trim();
  if (!raw) return null;
  let host = "";
  let path = "";
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):([^\s]+)$/.exec(raw);
  if (scp && !raw.includes("://")) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    try {
      const parsed = new URL(raw);
      host = parsed.hostname;
      path = parsed.pathname.replace(/^\/+/, "");
    } catch {
      return null;
    }
  }
  path = path.replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!host || !path || !path.includes("/")) return null;
  const lowerHost = host.toLowerCase();
  const kind = lowerHost.includes("github") ? "github" : lowerHost.includes("gitlab") ? "gitlab" : "other";
  const normalizedHost =
    kind === "github" && !lowerHost.includes(".")
      ? "github.com"
      : kind === "github" && /^github[-_]/.test(lowerHost)
        ? "github.com"
        : kind === "gitlab" && /^gitlab[-_]/.test(lowerHost)
          ? "gitlab.com"
          : lowerHost;
  return { host: normalizedHost, repo: path, kind };
}

/** Strips fenced code blocks from Markdown text so example URLs in code snippets aren't treated as assets. */
export function stripFencedCode(text: string): string {
  const lines = text.split("\n");
  const blocks = fencedBlocks(lines);
  if (!blocks.length) return text;
  const keep = lines.slice();
  for (const b of blocks) {
    const end = b.close ?? lines.length - 1;
    for (let i = b.open; i <= end; i++) keep[i] = "";
  }
  return keep.join("\n");
}

/** Strips trailing sentence punctuation from a matched URL while keeping balanced `(...)`. */
export function cleanMatchedUrl(raw: string): string {
  let url = raw.trim();
  while (url.length > 0) {
    const last = url[url.length - 1]!;
    if (last === ")") {
      const opens = [...url].filter((c) => c === "(").length;
      const closes = [...url].filter((c) => c === ")").length;
      if (closes <= opens) break;
      url = url.slice(0, -1);
      continue;
    }
    if (last === "]") {
      const opens = [...url].filter((c) => c === "[").length;
      const closes = [...url].filter((c) => c === "]").length;
      if (closes <= opens) break;
      url = url.slice(0, -1);
      continue;
    }
    if (/[.,;:!?>'"`}]/.test(last)) {
      url = url.slice(0, -1);
      continue;
    }
    break;
  }
  return url;
}

interface ExtractedLink {
  url: string;
  label: string | null;
}

/** Extracts `[label](url)` links and bare `http(s)://...` URLs from text, in appearance order. */
export function extractLinks(text: string): ExtractedLink[] {
  const out: ExtractedLink[] = [];
  const markdownSpans: Array<[number, number]> = [];
  const mdRe = /\[([^\][\n]{1,300})\]\(\s*(https?:\/\/[^\s<>)]+(?:\([^\s<>()]*\)[^\s<>)]*)*)\s*\)/g;
  for (const m of text.matchAll(mdRe)) {
    const start = m.index ?? 0;
    markdownSpans.push([start, start + m[0].length]);
    const label = m[1]!.replace(/[`*_~]/g, "").trim();
    const url = cleanMatchedUrl(m[2]!);
    if (url) out.push({ url, label: label || null });
  }
  const insideMarkdown = (idx: number) => markdownSpans.some(([s, e]) => idx >= s && idx < e);
  const bareRe = /https?:\/\/[^\s<>[\]"'`]+/g;
  for (const m of text.matchAll(bareRe)) {
    const idx = m.index ?? 0;
    if (insideMarkdown(idx)) continue;
    const url = cleanMatchedUrl(m[0]);
    if (url) out.push({ url, label: null });
  }
  return out;
}

type ClassifiedUrl =
  | {
      kind: "pr";
      key: string;
      host: string;
      repo: string;
      number: number;
      idLabel: string;
      url: string;
      githubRepo: string | null;
    }
  | {
      kind: "issue";
      key: string;
      host: string;
      repo: string;
      number: number | null;
      idLabel: string;
      url: string;
      githubRepo: string | null;
      fallbackTitle?: string;
    }
  | {
      kind: "discussion";
      key: string;
      repo: string;
      idLabel: string;
      url: string;
    }
  | {
      kind: "commit";
      key: string;
      repo: string;
      idLabel: string;
      url: string;
    }
  | {
      kind: "website";
      key: string;
      url: string;
      fallbackTitle: string;
    }
  | null;

const NOISE_HOSTS = new Set([
  "www.w3.org",
  "w3.org",
  "schemas.microsoft.com",
  "schemas.openxmlformats.org",
  "json-schema.org",
  "json.schemastore.org",
  "schemastore.org",
  "avatars.githubusercontent.com",
  "user-images.githubusercontent.com",
  "camo.githubusercontent.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
  "img.shields.io",
  "shields.io",
  "badge.fury.io",
  "registry.npmjs.org",
  "crates.io",
  "static.crates.io",
  "pypi.org",
  "files.pythonhosted.org",
  "api.github.com",
  "uploads.github.com",
]);

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

const DASHBOARD_HOST_PATTERNS = [
  /datadoghq\./i,
  /dataexplorer\.azure\.com$/i,
  /portal\.azure\.com$/i,
  /grafana/i,
  /kibana/i,
  /sentry\.io$/i,
  /honeycomb\.io$/i,
  /newrelic\.com$/i,
  /docs\.google\.com$/i,
  /notion\.so$/i,
  /notion\.site$/i,
  /figma\.com$/i,
  /confluence/i,
  /sharepoint\.com$/i,
  /slack\.com$/i,
  /linear\.app$/i,
];

function isDashboardOrDocUrl(u: URL): boolean {
  return DASHBOARD_HOST_PATTERNS.some((re) => re.test(u.hostname));
}

function formatWebsiteTitle(u: URL): string {
  const host = u.hostname.replace(/^www\./i, "");
  const path = u.pathname.replace(/\/+$/, "");
  if (/datadoghq\./i.test(host)) {
    const dash = /^\/dashboard\/([^/?#]+)(?:\/([^/?#]+))?/.exec(path);
    if (dash) {
      const id = dash[1]!;
      const slug = dash[2] ? decodeURIComponent(dash[2]).replace(/[-_]+/g, " ").trim() : "";
      return slug ? `Datadog Dashboard: ${slug} (${id})` : `Datadog Dashboard (${id})`;
    }
    const nb = /^\/notebook\/(\d+)(?:\/([^/?#]+))?/.exec(path);
    if (nb) {
      const id = nb[1]!;
      const slug = nb[2] ? decodeURIComponent(nb[2]).replace(/[-_]+/g, " ").trim() : "";
      return slug ? `Datadog Notebook: ${slug} (${id})` : `Datadog Notebook (${id})`;
    }
  }
  if (/dataexplorer\.azure\.com$/i.test(host) && path.startsWith("/dashboards")) {
    return `ADX Dashboard (${host}${path})`;
  }
  if (!path || path === "/") return host;
  const shownPath = path.length > 48 ? `${path.slice(0, 45)}…` : path;
  return `${host}${shownPath}`;
}

export function classifyUrl(raw: string, allowLoopback = false): ClassifiedUrl {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  if (NOISE_HOSTS.has(host)) return null;
  if (!allowLoopback && LOOPBACK_HOSTS.has(host)) return null;
  const pathname = u.pathname;

  // GitHub-style hosts (`github.com` or GHE `github.*`)
  if (host === "github.com" || host.startsWith("github.") || host.includes(".github.")) {
    const pr = /^\/([^/]+\/[^/]+)\/pulls?\/(\d+)(?:[/?#]|$)/.exec(pathname);
    if (pr) {
      const repo = pr[1]!;
      const number = Number(pr[2]!);
      return {
        kind: "pr",
        key: `pr:${host}/${repo.toLowerCase()}#${number}`,
        host,
        repo,
        number,
        idLabel: `#${number}`,
        url: `${u.protocol}//${u.host}/${repo}/pull/${number}`,
        githubRepo: host === "github.com" ? repo : null,
      };
    }
    const issue = /^\/([^/]+\/[^/]+)\/issues\/(\d+)(?:[/?#]|$)/.exec(pathname);
    if (issue) {
      const repo = issue[1]!;
      const number = Number(issue[2]!);
      return {
        kind: "issue",
        key: `issue:${host}/${repo.toLowerCase()}#${number}`,
        host,
        repo,
        number,
        idLabel: `#${number}`,
        url: `${u.protocol}//${u.host}/${repo}/issues/${number}`,
        githubRepo: host === "github.com" ? repo : null,
      };
    }
    const discussion = /^\/([^/]+\/[^/]+)\/discussions\/(\d+)(?:[/?#]|$)/.exec(pathname);
    if (discussion) {
      const repo = discussion[1]!;
      const number = Number(discussion[2]!);
      return {
        kind: "discussion",
        key: `discussion:${host}/${repo.toLowerCase()}#${number}`,
        repo,
        idLabel: `#${number}`,
        url: `${u.protocol}//${u.host}/${repo}/discussions/${number}`,
      };
    }
    const commit = /^\/([^/]+\/[^/]+)\/commit\/([0-9a-f]{7,40})(?:[/?#]|$)/i.exec(pathname);
    if (commit) {
      const repo = commit[1]!;
      const sha = commit[2]!;
      return {
        kind: "commit",
        key: `commit:${host}/${repo.toLowerCase()}@${sha.slice(0, 7).toLowerCase()}`,
        repo,
        idLabel: sha.slice(0, 7),
        url: `${u.protocol}//${u.host}/${repo}/commit/${sha}`,
      };
    }
    // Bare repository root or `.git` clone URLs are not standalone website artifacts.
    if (/^\/[^/]+\/[^/]+\/?$/.test(pathname) || pathname.endsWith(".git")) return null;
  }

  // GitLab hosts
  if (host === "gitlab.com" || host.startsWith("gitlab.") || host.includes(".gitlab.")) {
    const mr = /^\/(.+?)\/-\/merge_requests\/(\d+)(?:[/?#]|$)/.exec(pathname);
    if (mr) {
      const repo = mr[1]!;
      const number = Number(mr[2]!);
      return {
        kind: "pr",
        key: `pr:${host}/${repo.toLowerCase()}!${number}`,
        host,
        repo,
        number,
        idLabel: `!${number}`,
        url: `${u.protocol}//${u.host}/${repo}/-/merge_requests/${number}`,
        githubRepo: null,
      };
    }
    const issue = /^\/(.+?)\/-\/issues\/(\d+)(?:[/?#]|$)/.exec(pathname);
    if (issue) {
      const repo = issue[1]!;
      const number = Number(issue[2]!);
      return {
        kind: "issue",
        key: `issue:${host}/${repo.toLowerCase()}#${number}`,
        host,
        repo,
        number,
        idLabel: `#${number}`,
        url: `${u.protocol}//${u.host}/${repo}/-/issues/${number}`,
        githubRepo: null,
      };
    }
    const commit = /^\/(.+?)\/-\/commit\/([0-9a-f]{7,40})(?:[/?#]|$)/i.exec(pathname);
    if (commit) {
      const repo = commit[1]!;
      const sha = commit[2]!;
      return {
        kind: "commit",
        key: `commit:${host}/${repo.toLowerCase()}@${sha.slice(0, 7).toLowerCase()}`,
        repo,
        idLabel: sha.slice(0, 7),
        url: `${u.protocol}//${u.host}/${repo}/-/commit/${sha}`,
      };
    }
    if (pathname.endsWith(".git")) return null;
  }

  // Linear issues (`https://linear.app/<workspace>/issue/<ENG-123>/<optional-slug>`)
  if (host === "linear.app") {
    const lin = /^\/([^/]+)\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/([^/?#]+))?/.exec(pathname);
    if (lin) {
      const workspace = lin[1]!;
      const identifier = lin[2]!.toUpperCase();
      const slug = lin[3] ? decodeURIComponent(lin[3]).replace(/[-_]+/g, " ").trim() : undefined;
      return {
        kind: "issue",
        key: `issue:linear.app/${identifier.toLowerCase()}`,
        host,
        repo: workspace,
        number: null,
        idLabel: identifier,
        url: `${u.protocol}//${u.host}/${workspace}/issue/${identifier}${lin[3] ? `/${lin[3]}` : ""}`,
        githubRepo: null,
        fallbackTitle: slug,
      };
    }
  }

  if (pathname.endsWith(".git")) return null;
  if (/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|eot)$/i.test(pathname) && !isDashboardOrDocUrl(u)) {
    return null;
  }

  const canonical = `${u.protocol}//${host}${u.port ? `:${u.port}` : ""}${pathname.replace(/\/+$/, "") || "/"}${u.search}`;
  return {
    kind: "website",
    key: `web:${canonical}`,
    url: raw,
    fallbackTitle: formatWebsiteTitle(u),
  };
}

const GENERIC_LABELS = new Set([
  "link",
  "here",
  "url",
  "website",
  "open",
  "view",
  "source",
  "pr",
  "pull request",
  "issue",
  "commit",
  "discussion",
]);

/** Cleans a Markdown link label into a human title, or returns `null` when it only repeats the ID/URL. */
function meaningfulLabel(label: string | null | undefined, idLabel?: string): string | null {
  if (!label) return null;
  let cleaned = label.trim().replace(/\s+/g, " ");
  if (!cleaned || /^https?:\/\//i.test(cleaned)) return null;
  if (GENERIC_LABELS.has(cleaned.toLowerCase())) return null;
  if (idLabel) {
    const esc = idLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const isShortSha = /^[0-9a-f]{7}$/i.test(idLabel);
    const idPattern = isShortSha ? `${esc}[0-9a-f]{0,33}` : esc;
    if (
      new RegExp(`^(?:(?:PR|Pull Request|Issue|MR|Merge Request|Discussion|Commit)\\s+)?${idPattern}$`, "i").test(
        cleaned,
      )
    ) {
      return null;
    }
    // Strip leading `#123`, `owner/repo#123:`, `Discussion #309:`, `a4f91c2 —`, or `ENG-123:` prefix when followed by the title.
    const stripped = cleaned
      .replace(
        new RegExp(
          `^(?:(?:PR|Pull Request|Issue|MR|Merge Request|Discussion|Commit)\\s+)?(?:[\\w.-]+\\/[\\w.-]+[@/]?)?${idPattern}(?:\\s*[-–—:]\\s*|\\s+)`,
          "i",
        ),
        "",
      )
      .replace(/^(?:[\w.-]+\/[\w.-]+)?[#!]\d+\s*(?:[-–—:]\s*)?/i, "")
      .trim();
    if (!stripped) return null;
    cleaned = stripped;
  }
  return cleaned;
}

const ARTIFACT_EXTENSIONS = new Set([
  "md",
  "mdx",
  "markdown",
  "rst",
  "adoc",
  "asciidoc",
  "txt",
  "pdf",
  "doc",
  "docx",
  "rtf",
  "odt",
  "csv",
  "tsv",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "ipynb",
  "parquet",
  "excalidraw",
  "svg",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "mp4",
  "mov",
  "webm",
  "html",
  "htm",
  "zip",
  "tgz",
]);

/** Binary document formats opened via the OS viewer rather than the IDE text editor. */
const EXTERNAL_BINARY_EXTENSIONS = new Set([
  "doc",
  "docx",
  "rtf",
  "odt",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "parquet",
  "mp4",
  "mov",
  "webm",
  "zip",
  "tgz",
]);

const BOILERPLATE_FILENAMES = new Set([
  "agents.md",
  "claude.md",
  "gemini.md",
  "copilot-instructions.md",
  "readme.md",
  "readme.txt",
  "readme",
  "contributing.md",
  "changelog.md",
  "license",
  "license.md",
  "license.txt",
  "third_party_licenses.md",
  "security.md",
  "code_of_conduct.md",
  "pull_request_template.md",
]);

/** Rich standalone document/diagram formats that count as artifacts even when only read. */
const STANDALONE_ARTIFACT_EXTENSIONS = new Set([
  "pdf",
  "doc",
  "docx",
  "rtf",
  "odt",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "ipynb",
  "parquet",
  "excalidraw",
]);

const IGNORED_READ_SEGMENTS = [
  "/.github/",
  "/.claude/",
  "/.agents/",
  "/.cursor/",
  "/node_modules/",
  "/target/",
  "/dist/",
  "/.git/",
  "/src/ui/expui/",
  "/src/ui/openidea/",
  "/src/ui/brands/",
  "/fixtures/",
];

function isInternalTempPath(normalizedPath: string): boolean {
  return (
    normalizedPath.includes("/openidea-copilot/") || /\/(?:\d+-)?copilot-tool-output-[\w-]+\.\w+$/i.test(normalizedPath)
  );
}

function extOf(filePath: string): string {
  const base = basename(filePath).toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1) : "";
}

function isSessionArtifactDir(normalizedPath: string): boolean {
  return normalizedPath.includes("/.copilot/session-state/") && normalizedPath.includes("/files/");
}

function isArtifactCandidate(normalizedPath: string, source: "edit" | "read" | "mention"): boolean {
  if (!normalizedPath || normalizedPath.endsWith("/")) return false;
  if (isInternalTempPath(normalizedPath)) return false;
  if (isSessionArtifactDir(normalizedPath)) return true;
  const ext = extOf(normalizedPath);
  if (!ARTIFACT_EXTENSIONS.has(ext)) return false;
  if (source === "edit") return true;
  const name = basename(normalizedPath).toLowerCase();
  if (BOILERPLATE_FILENAMES.has(name)) return false;
  if (IGNORED_READ_SEGMENTS.some((seg) => normalizedPath.includes(seg))) return false;
  if (source === "read") {
    return STANDALONE_ARTIFACT_EXTENSIONS.has(ext);
  }
  return true;
}

function normalizeState(
  stateRaw: string | null | undefined,
  merged?: boolean | null,
  draft?: boolean | null,
): PullRequestAssetState | null {
  if (merged) return "merged";
  if (draft) return "draft";
  const s = stateRaw?.trim().toLowerCase();
  if (s === "merged") return "merged";
  if (s === "draft") return "draft";
  if (s === "closed") return "closed";
  if (s === "open" || s === "opened") return "open";
  return null;
}

function parseRepoFlag(cmd: string): string | null {
  const m =
    /(?:^|\s)(?:-R|--repo)(?:=|\s+)["']?(?:https?:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)["']?(?:\.git)?(?=\s|$|[|;&)])/.exec(
      cmd,
    );
  return m?.[1] ?? null;
}

function parseTitleFlag(cmd: string): string | null {
  const m = /(?:^|\s)(?:-t|--title)(?:=|\s+)(?:"([^"]+)"|'([^']+)')/.exec(cmd);
  return (m?.[1] ?? m?.[2])?.trim() || null;
}

interface GhCliMatch {
  kind: "pr" | "issue";
  subcommand: string;
  number?: number;
  url?: string;
  repoFlag: string | null;
  titleFlag: string | null;
}

/** Finds `gh pr ...` and `gh issue ...` invocations inside a shell command string. */
function parseGhCliCommands(command: string): GhCliMatch[] {
  const out: GhCliMatch[] = [];
  const re =
    /\bgh\s+(pr|issue)\s+(view|checks|diff|edit|merge|ready|reopen|close|review|comment|checkout|create|status)\b([^\n|;&]*)/g;
  for (const m of command.matchAll(re)) {
    const kind = m[1] as "pr" | "issue";
    const subcommand = m[2]!;
    const args = m[3] ?? "";
    const repoFlag = parseRepoFlag(args);
    const titleFlag = parseTitleFlag(args);
    const urlMatch = /https?:\/\/[^\s"'`)]+/.exec(args);
    if (urlMatch) {
      out.push({ kind, subcommand, url: cleanMatchedUrl(urlMatch[0]), repoFlag, titleFlag });
      continue;
    }
    if (subcommand !== "create" && subcommand !== "status") {
      // Strip flags that take an argument so we don't mistake `-R owner/repo` or `--jq ...` for a number.
      const stripped = args
        .replace(/(?:-R|--repo|--jq|-q|--template|-t|--json|--body|-b)(?:=|\s+)(?:"[^"]*"|'[^']*'|\S+)/g, " ")
        .trim();
      const numMatch = /(?:^|\s)#?(\d+)\b/.exec(` ${stripped}`);
      if (numMatch) {
        out.push({ kind, subcommand, number: Number(numMatch[1]!), repoFlag, titleFlag });
        continue;
      }
    }
    if (subcommand === "create") {
      out.push({ kind, subcommand, repoFlag, titleFlag });
    }
  }
  return out;
}

/** Extracts PR/Issue metadata from JSON objects inside tool outputs (`gh pr view --json`, MCP responses). */
function extractJsonMetadata(output: string): Array<{
  url: string;
  title?: string;
  state?: PullRequestAssetState;
}> {
  if (!output.includes("{") || (!output.includes("/pull/") && !output.includes("/issues/"))) return [];
  const results: Array<{ url: string; title?: string; state?: PullRequestAssetState }> = [];
  const candidates: unknown[] = [];
  const trimmed = output.trim();
  for (const line of trimmed.startsWith("{") || trimmed.startsWith("[") ? [trimmed] : trimmed.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{") && !s.startsWith("[")) continue;
    try {
      candidates.push(JSON.parse(s));
    } catch {
      /* not standalone JSON */
    }
  }
  const visit = (node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || depth > 5) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const rec = node as Record<string, unknown>;
    const url =
      typeof rec.html_url === "string"
        ? rec.html_url
        : typeof rec.url === "string" && /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/(?:pulls?|issues)\/\d+/.test(rec.url)
          ? rec.url
          : null;
    if (url) {
      const title = typeof rec.title === "string" ? rec.title.trim() : undefined;
      const merged = rec.merged === true || (typeof rec.merged_at === "string" && rec.merged_at.length > 0);
      const draft = rec.draft === true || rec.isDraft === true;
      const state = normalizeState(typeof rec.state === "string" ? rec.state : null, merged, draft) ?? undefined;
      results.push({ url, title, state });
    }
    for (const v of Object.values(rec)) {
      if (v && typeof v === "object") visit(v, depth + 1);
    }
  };
  for (const c of candidates) visit(c, 0);
  return results;
}

function relativeIfUnder(bases: readonly string[], absPath: string): string | null {
  const norm = resolveTyped("", absPath.replace(/\\/g, "/"));
  for (const b of bases) {
    if (!b) continue;
    const base = resolveTyped(b, ".");
    if (norm === base) return null;
    if (norm.startsWith(`${base}/`)) return norm.slice(base.length + 1);
  }
  return null;
}

export interface ExtractAssetsOptions {
  task: Pick<AgentTask, "cwd" | "projectRoot">;
  entries: readonly AgentEntry[] | null;
  remoteUrl?: string | null;
  branchPullRequests?: readonly PullRequestSummary[];
  remoteMeta?: ReadonlyMap<string, RemoteItemMeta>;
  dismissed?: ReadonlySet<string>;
}

export function extractSessionAssets({
  task,
  entries,
  remoteUrl,
  branchPullRequests,
  remoteMeta,
  dismissed,
}: ExtractAssetsOptions): SessionAssetsData {
  const remote = parseRemoteCoordinates(remoteUrl);
  const defaultGithubRepo = remote?.kind === "github" && remote.host === "github.com" ? remote.repo : null;
  const bases = [task.cwd, task.projectRoot ?? ""].filter(Boolean);

  const prs = new Map<string, SessionPullRequest & { seq: number }>();
  const createdIssues = new Map<string, SessionIssue & { seq: number }>();
  const references = new Map<string, SessionReference & { seq: number }>();
  const websites = new Map<
    string,
    Extract<SessionArtifact, { kind: "website" }> & { seq: number; hasLabel: boolean }
  >();
  const files = new Map<string, Extract<SessionArtifact, { kind: "file" }> & { seq: number }>();

  let seq = 0;

  const touchPr = (
    item: Omit<SessionPullRequest, "title" | "state" | "hasExplicitTitle" | "hasExplicitState">,
    title?: string | null,
    state?: PullRequestAssetState | null,
    bumpOrder = true,
  ) => {
    const existing = prs.get(item.key);
    const cleanTitle = title?.trim() || null;
    if (existing) {
      if (bumpOrder) existing.seq = ++seq;
      if (cleanTitle && (!existing.hasExplicitTitle || cleanTitle.length > existing.title.length)) {
        existing.title = cleanTitle;
        existing.hasExplicitTitle = true;
      }
      if (state) {
        existing.state = state;
        existing.hasExplicitState = true;
      }
      return;
    }
    prs.set(item.key, {
      ...item,
      title: cleanTitle ?? item.repo,
      state: state ?? "open",
      hasExplicitTitle: !!cleanTitle,
      hasExplicitState: !!state,
      seq: ++seq,
    });
  };

  const touchIssue = (
    item: Omit<SessionIssue, "title" | "state" | "hasExplicitTitle" | "hasExplicitState">,
    opts: {
      created?: boolean;
      title?: string | null;
      fallbackTitle?: string | null;
      state?: IssueAssetState | null;
    } = {},
  ) => {
    const cleanTitle = opts.title?.trim() || null;
    if (opts.created || createdIssues.has(item.key)) {
      // Promote from `references` if it was seen before `gh issue create` completed.
      const prevRef = references.get(item.key);
      if (prevRef) references.delete(item.key);
      const existing = createdIssues.get(item.key);
      if (existing) {
        existing.seq = ++seq;
        if (cleanTitle) {
          existing.title = cleanTitle;
          existing.hasExplicitTitle = true;
        }
        if (opts.state) {
          existing.state = opts.state;
          existing.hasExplicitState = true;
        }
        return;
      }
      createdIssues.set(item.key, {
        ...item,
        title: cleanTitle ?? (prevRef?.hasExplicitTitle ? prevRef.title : null) ?? opts.fallbackTitle ?? item.repo,
        state: opts.state ?? prevRef?.state ?? "open",
        hasExplicitTitle: !!(cleanTitle || prevRef?.hasExplicitTitle),
        hasExplicitState: !!(opts.state || prevRef?.hasExplicitState),
        seq: ++seq,
      });
      return;
    }

    const existing = references.get(item.key);
    if (existing) {
      existing.seq = ++seq;
      if (cleanTitle && (!existing.hasExplicitTitle || cleanTitle.length > existing.title.length)) {
        existing.title = cleanTitle;
        existing.hasExplicitTitle = true;
      }
      if (opts.state) {
        existing.state = opts.state;
        existing.hasExplicitState = true;
      }
      return;
    }
    references.set(item.key, {
      key: item.key,
      kind: "issue",
      idLabel: item.idLabel,
      title: cleanTitle ?? opts.fallbackTitle ?? item.repo,
      state: opts.state ?? "open",
      url: item.url,
      repo: item.repo,
      githubIssue: item.githubRepo && item.number !== null ? { repo: item.githubRepo, number: item.number } : undefined,
      hasExplicitTitle: !!cleanTitle,
      hasExplicitState: !!opts.state,
      seq: ++seq,
    });
  };

  const touchOtherReference = (
    kind: "commit" | "discussion",
    key: string,
    idLabel: string,
    repo: string,
    url: string,
    title?: string | null,
  ) => {
    const cleanTitle = title?.trim() || null;
    const existing = references.get(key);
    if (existing) {
      existing.seq = ++seq;
      if (cleanTitle && !existing.hasExplicitTitle) {
        existing.title = cleanTitle;
        existing.hasExplicitTitle = true;
      }
      return;
    }
    references.set(key, {
      key,
      kind,
      idLabel,
      title: cleanTitle ?? repo,
      url,
      repo,
      hasExplicitTitle: !!cleanTitle,
      hasExplicitState: true,
      seq: ++seq,
    });
  };

  const touchWebsite = (key: string, url: string, fallbackTitle: string, label?: string | null) => {
    const cleanLabel = meaningfulLabel(label);
    const existing = websites.get(key);
    if (existing) {
      existing.seq = ++seq;
      if (cleanLabel && (!existing.hasLabel || cleanLabel.length > existing.title.length)) {
        existing.title = cleanLabel;
        existing.hasLabel = true;
      }
      return;
    }
    websites.set(key, {
      key,
      kind: "website",
      url,
      title: cleanLabel ?? fallbackTitle,
      hasLabel: !!cleanLabel,
      seq: ++seq,
    });
  };

  const touchFile = (rawPath: string, source: "edit" | "read" | "mention") => {
    const trimmed = rawPath.trim();
    if (!trimmed || /^[a-z][a-z\d+.-]*:/i.test(trimmed)) return;
    const abs = trimmed.startsWith("/") ? resolveTyped("", trimmed) : resolveTyped(task.cwd, trimmed);
    if (!isArtifactCandidate(abs, source)) return;
    const key = `file:${abs}`;
    const existing = files.get(key);
    if (existing) {
      existing.seq = ++seq;
      return;
    }
    const ext = extOf(abs);
    files.set(key, {
      key,
      kind: "file",
      name: basename(abs) || abs,
      path: abs,
      rel: relativeIfUnder(bases, abs),
      externalBinary: EXTERNAL_BINARY_EXTENSIONS.has(ext),
      seq: ++seq,
    });
  };

  const ingestUrl = (
    rawUrl: string,
    label: string | null,
    opts: { allowWebsites: boolean; allowLoopback: boolean; createdIssue?: boolean } = {
      allowWebsites: true,
      allowLoopback: false,
    },
  ) => {
    const classified = classifyUrl(rawUrl, opts.allowLoopback);
    if (!classified) return;
    switch (classified.kind) {
      case "pr":
        touchPr(classified, meaningfulLabel(label, classified.idLabel));
        break;
      case "issue":
        touchIssue(classified, {
          created: opts.createdIssue,
          title: meaningfulLabel(label, classified.idLabel),
          fallbackTitle: classified.fallbackTitle ?? null,
        });
        break;
      case "discussion":
        touchOtherReference(
          "discussion",
          classified.key,
          classified.idLabel,
          classified.repo,
          classified.url,
          meaningfulLabel(label, classified.idLabel),
        );
        break;
      case "commit":
        touchOtherReference(
          "commit",
          classified.key,
          classified.idLabel,
          classified.repo,
          classified.url,
          meaningfulLabel(label, classified.idLabel),
        );
        break;
      case "website":
        if (opts.allowWebsites) {
          touchWebsite(classified.key, classified.url, classified.fallbackTitle, label);
        }
        break;
    }
  };

  const ingestProse = (text: string) => {
    const prose = stripFencedCode(text);
    for (const link of extractLinks(prose)) {
      ingestUrl(link.url, link.label, { allowWebsites: true, allowLoopback: true });
    }
    // Markdown relative/absolute file links (`[Report](docs/report.md)`).
    for (const m of prose.matchAll(/\[([^\][\n]{1,200})\]\(\s*([^)\s]+)\s*\)/g)) {
      const file = fileHref(m[2]!, task.cwd);
      if (file) touchFile(file.path, "mention");
    }
    // `@file` mentions in messages.
    for (const tok of messageTokens(prose)) {
      if (tok.kind !== "file") continue;
      const mention = parseMention(tok.value);
      if (mention && !mention.dir) touchFile(mention.rel, "mention");
    }
    // Inline code spans naming an artifact file (`storage_session_spec.docx`, `/tmp/report.md`).
    for (const m of prose.matchAll(/`([^`\n]{3,240})`/g)) {
      const link = pathLink(m[1]!, task.cwd);
      if (link) touchFile(link.path, "mention");
    }
  };

  // Seed branch PRs first so conversation activity after them naturally ranks newer if touched again.
  for (const bpr of branchPullRequests ?? []) {
    const classified = classifyUrl(bpr.url);
    if (classified?.kind !== "pr") continue;
    const state = normalizeState(bpr.state, false, bpr.isDraft) ?? "open";
    touchPr(classified, bpr.title, state);
  }

  for (const entry of entries ?? []) {
    if (entry.type === "user") {
      ingestProse(entry.text);
      const imageCount = entry.images?.length ?? 0;
      const attachedFiles = entry.attachments.slice(0, Math.max(0, entry.attachments.length - imageCount));
      for (const a of attachedFiles) touchFile(a, "mention");
      continue;
    }
    if (entry.type === "agent" || entry.type === "message") {
      ingestProse(entry.text);
      continue;
    }
    if (entry.type === "subagent") {
      if (entry.prompt) ingestProse(entry.prompt);
      if (entry.reply) ingestProse(entry.reply);
      continue;
    }
    if (entry.type === "tool") {
      const edited = entry.kind === "edit" || entry.kind === "move" || entry.diffs.length > 0;
      for (const diff of entry.diffs) touchFile(diff.path, "edit");
      if (edited || entry.kind === "read") {
        for (const loc of entry.locations) touchFile(loc, edited ? "edit" : "read");
      }
      if (entry.kind === "fetch") {
        for (const link of extractLinks(entry.title)) {
          ingestUrl(link.url, link.label, { allowWebsites: true, allowLoopback: false });
        }
      }
      if (entry.kind === "execute") {
        const cliMatches = parseGhCliCommands(entry.title);
        const createsPr = cliMatches.find((c) => c.kind === "pr" && c.subcommand === "create");
        const createsIssue = cliMatches.find((c) => c.kind === "issue" && c.subcommand === "create");
        for (const cli of cliMatches) {
          if (cli.url) {
            ingestUrl(cli.url, cli.titleFlag, {
              allowWebsites: false,
              allowLoopback: false,
              createdIssue: cli.kind === "issue" && cli.subcommand === "create",
            });
            continue;
          }
          const targetRepo = cli.repoFlag ?? defaultGithubRepo;
          if (cli.number !== undefined && targetRepo) {
            const url =
              cli.kind === "pr"
                ? `https://github.com/${targetRepo}/pull/${cli.number}`
                : `https://github.com/${targetRepo}/issues/${cli.number}`;
            ingestUrl(url, cli.titleFlag, { allowWebsites: false, allowLoopback: false });
          }
        }
        if (entry.output) {
          for (const meta of extractJsonMetadata(entry.output)) {
            const classified = classifyUrl(meta.url);
            if (classified?.kind === "pr") {
              touchPr(classified, meta.title, meta.state);
            } else if (classified?.kind === "issue") {
              const issueState: IssueAssetState | null =
                meta.state === "closed" ? "closed" : meta.state ? "open" : null;
              touchIssue(classified, {
                created: !!createsIssue,
                title: meta.title ?? createsIssue?.titleFlag ?? null,
                state: issueState,
              });
            }
          }
          for (const link of extractLinks(entry.output)) {
            let allowDashboard = false;
            try {
              allowDashboard = isDashboardOrDocUrl(new URL(link.url));
            } catch {
              /* invalid URL */
            }
            ingestUrl(link.url, link.label ?? (createsPr?.titleFlag || createsIssue?.titleFlag || null), {
              allowWebsites: allowDashboard,
              allowLoopback: false,
              createdIssue: !!createsIssue,
            });
          }
        }
        continue;
      }
      // Other tools (e.g. GitHub / Linear / Datadog MCP calls): inspect structured JSON and explicit links.
      for (const link of extractLinks(entry.title)) {
        ingestUrl(link.url, link.label, { allowWebsites: false, allowLoopback: false });
      }
      if (entry.output) {
        for (const meta of extractJsonMetadata(entry.output)) {
          const classified = classifyUrl(meta.url);
          if (classified?.kind === "pr") {
            touchPr(classified, meta.title, meta.state);
          } else if (classified?.kind === "issue") {
            const issueState: IssueAssetState | null = meta.state === "closed" ? "closed" : meta.state ? "open" : null;
            touchIssue(classified, { title: meta.title, state: issueState });
          }
        }
        for (const link of extractLinks(entry.output)) {
          let allowDashboard = false;
          try {
            allowDashboard = isDashboardOrDocUrl(new URL(link.url));
          } catch {
            /* invalid URL */
          }
          ingestUrl(link.url, link.label, { allowWebsites: allowDashboard, allowLoopback: false });
        }
      }
    }
  }

  // Apply live `gh api` metadata enrichment (`title` and `state`).
  if (remoteMeta?.size) {
    for (const pr of prs.values()) {
      const meta = remoteMeta.get(pr.key);
      if (!meta) continue;
      if (meta.title) {
        pr.title = meta.title;
        pr.hasExplicitTitle = true;
      }
      if (meta.state) {
        pr.state = meta.state;
        pr.hasExplicitState = true;
      }
    }
    for (const issue of createdIssues.values()) {
      const meta = remoteMeta.get(issue.key);
      if (!meta) continue;
      if (meta.title) {
        issue.title = meta.title;
        issue.hasExplicitTitle = true;
      }
      if (meta.state === "open" || meta.state === "closed") {
        issue.state = meta.state;
        issue.hasExplicitState = true;
      }
    }
    for (const ref of references.values()) {
      const meta = remoteMeta.get(ref.key);
      if (!meta) continue;
      if (meta.title) {
        ref.title = meta.title;
        ref.hasExplicitTitle = true;
      }
      if (meta.state === "open" || meta.state === "closed") {
        ref.state = meta.state;
        ref.hasExplicitState = true;
      }
    }
  }

  const keep = (key: string) => !dismissed?.has(key);
  const byNewest = <T extends { seq: number }>(map: Map<string, T>): Array<Omit<T, "seq">> =>
    [...map.values()]
      .filter((item) => keep((item as unknown as { key: string }).key))
      .sort((a, b) => b.seq - a.seq)
      .map(({ seq: _seq, ...rest }) => rest);

  const sortedWebsites: SessionArtifact[] = [...websites.values()]
    .filter((w) => keep(w.key))
    .sort((a, b) => b.seq - a.seq)
    .map(({ seq: _seq, hasLabel: _hasLabel, ...rest }) => rest);
  const sortedFiles: SessionArtifact[] = [...files.values()]
    .filter((f) => keep(f.key))
    .sort((a, b) => b.seq - a.seq)
    .map(({ seq: _seq, ...rest }) => rest);

  return {
    pullRequests: byNewest(prs),
    createdIssues: byNewest(createdIssues),
    references: byNewest(references),
    artifacts: [...sortedWebsites, ...sortedFiles],
  };
}
