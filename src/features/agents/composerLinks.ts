/**
 * Web links in the composer and in sent messages: bare `https://…` URLs and `[label](url)`
 * links, drawn as chips (an issue or pull request as `repo#12`, a commit as `repo@abc1234`, any
 * other page as its host and path). The text stays as written and is what the agent gets.
 */
import { classifyUrl, cleanMatchedUrl, parseRemoteCoordinates } from "./sessionAssetsModel";

export interface LinkSpan {
  from: number;
  to: number;
  url: string;
  /** The label of a `[label](url)` link. */
  label: string | null;
}

// A URL ends at whitespace, quotes and brackets, and at CJK text or full-width punctuation: Chinese
// runs on without a space after it.
const URL_END = "\\s<>\"'`\\u3000-\\u9fff\\uff00-\\uffef";
// The label may hold `\]` (as `markdownLink` writes it); the URL no parentheses or spaces.
const MARKDOWN_LINK = new RegExp(`\\[((?:\\\\.|[^\\]\\\\\\n]){1,300})\\]\\((https?:\\/\\/[^${URL_END}()]+)\\)`, "g");
// Not inside a word or a path (no lookbehind: older WebKit cannot parse it).
const BARE_URL = new RegExp(`(^|[^\\w/@.-])(https?:\\/\\/[^${URL_END}]+)`, "gi");

/** The `[label](url)` links and bare `http(s)://` URLs of `text`, in order, with their positions in it. */
export function linkSpans(text: string): LinkSpan[] {
  if (!text.includes("://")) return [];
  const out: LinkSpan[] = [];
  for (const m of text.matchAll(MARKDOWN_LINK)) {
    const label = m[1]!.replace(/\\(.)/g, "$1").trim();
    if (label) out.push({ from: m.index, to: m.index + m[0].length, url: m[2]!, label });
  }
  const inLink = (at: number) => out.some((s) => at >= s.from && at < s.to);
  const bare: LinkSpan[] = [];
  for (const m of text.matchAll(BARE_URL)) {
    const from = m.index + m[1]!.length;
    if (inLink(from)) continue;
    const url = cleanMatchedUrl(m[2]!);
    // Only a scheme: nothing to link to yet.
    if (!/^https?:\/\/[^/?#]+/i.test(url)) continue;
    bare.push({ from, to: from + url.length, url, label: null });
  }
  return [...out, ...bare].sort((a, b) => a.from - b.from);
}

export type LinkKind = "pr" | "issue" | "commit" | "web";

export interface LinkInfo {
  kind: LinkKind;
  /** What the chip shows: `repo#12`, `repo@abc1234`, `docs.rs/serde`, or the link's label. */
  text: string;
}

const repoName = (repo: string) => repo.split("/").pop() || repo;

/** How a link is shown as a chip. */
export function linkInfo(url: string, label: string | null = null): LinkInfo {
  const item = classifyUrl(url, true);
  if (item?.kind === "pr" || item?.kind === "issue") {
    // A Linear issue (no number) is named by its own id.
    const text = item.number === null ? item.idLabel : `${repoName(item.repo)}${item.idLabel}`;
    return { kind: item.kind, text: label ?? text };
  }
  if (item?.kind === "commit") return { kind: "commit", text: label ?? `${repoName(item.repo)}@${item.idLabel}` };
  return { kind: "web", text: label ?? webText(url) };
}

/** `docs.rs/serde/latest`: the host without `www.`, then the path (decoded), without the query. */
function webText(url: string): string {
  try {
    const u = new URL(url);
    const host = u.host.replace(/^www\./, "");
    let path = u.pathname.replace(/\/+$/, "");
    try {
      path = decodeURIComponent(path);
    } catch {
      // As written.
    }
    return `${host}${path}`;
  } catch {
    return url;
  }
}

export interface BlobLink {
  /** The forge host and `owner/repo` the link points into. */
  host: string;
  repo: string;
  /** The path segments after `blob/` or `tree/`: the ref, which may hold `/`, then the file's path. */
  segments: string[];
  dir: boolean;
  lines?: { from: number; to: number };
}

/**
 * A GitHub link to a file or folder of a repository (`https://github.com/o/r/blob/main/src/a.ts#L10-L20`,
 * `…/tree/main/src`); `null` for any other URL.
 */
export function blobLink(url: string): BlobLink | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (!/^https?:$/.test(u.protocol) || !(host === "github.com" || host.startsWith("github."))) return null;
  const m = /^\/([^/]+\/[^/]+)\/(blob|tree)\/(.+?)\/?$/.exec(u.pathname);
  if (!m) return null;
  let segments: string[];
  try {
    segments = m[3]!.split("/").map(decodeURIComponent);
  } catch {
    return null;
  }
  if (segments.length < 2 || segments.some((s) => !s || s === "." || s === "..")) return null;
  const l = /^#L(\d+)(?:C\d+)?(?:-L(\d+)(?:C\d+)?)?$/.exec(u.hash);
  const from = l ? Number(l[1]) : undefined;
  return {
    host,
    repo: m[1]!,
    segments,
    dir: m[2] === "tree",
    ...(from !== undefined && { lines: { from, to: l![2] ? Math.max(from, Number(l![2])) : from } }),
  };
}

/** The paths in the repository `link` may name, as its ref may hold `/`: the one after a one-segment ref first. */
export function blobPathCandidates(link: BlobLink): string[] {
  const out: string[] = [];
  for (let i = 1; i < link.segments.length; i++) out.push(link.segments.slice(i).join("/"));
  return out;
}

/** Whether one of the git remotes (fetch URLs) is the repository `link` points into. */
export function isRemoteOf(remoteUrls: readonly string[], link: BlobLink): boolean {
  const repo = link.repo.toLowerCase();
  return remoteUrls.some((url) => {
    const r = parseRemoteCoordinates(url);
    return !!r && r.host === link.host && r.repo.toLowerCase() === repo;
  });
}

/** A pasted single URL, trimmed; `null` when the text is anything else. */
export function pastedUrl(text: string): string | null {
  const url = text.trim();
  return /^https?:\/\/\S+$/i.test(url) ? url : null;
}

/** `[label](url)`, with the label's brackets escaped and the URL's parentheses encoded. */
export function markdownLink(label: string, url: string): string {
  const href = url.replace(/[()]/g, (c) => (c === "(" ? "%28" : "%29"));
  return `[${label.replace(/([[\]\\])/g, "\\$1")}](${href})`;
}
