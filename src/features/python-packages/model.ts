/** What the Python Packages tool window lists, and the requirement an operation installs. */
import type { PypiPackage, PythonPackage } from "@/platform/ipc";

/** How pip and PyPI compare names (PEP 503). */
export const normalize = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

/** Whether `text` can be a distribution name, so it is worth asking PyPI for. */
export const isPackageName = (text: string) =>
  text.length <= 128 && /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(text);

export type Row =
  | { kind: "section"; id: "installed" | "pypi" }
  | { kind: "installed"; name: string; version: string; latest: string | null }
  | { kind: "pypi"; name: string; latest: string | null };

export const rowKey = (row: Row) => (row.kind === "section" ? `section:${row.id}` : `${row.kind}:${row.name}`);

/**
 * The installed packages matching `query`, then the PyPI projects that are not installed:
 * `found`, the project the query names exactly, and `names`, the search results. `newer`
 * maps a package to its newer release.
 */
export function listRows(
  installed: readonly PythonPackage[],
  newer: ReadonlyMap<string, string> | null,
  found: PypiPackage | null,
  names: readonly string[],
  query: string,
): Row[] {
  // `typing-extensions` finds `typing_extensions`, as pip would.
  const q = normalize(query.trim());
  const rows: Row[] = [];
  for (const p of installed) {
    if (q && !normalize(p.name).includes(q)) continue;
    const latest = newer?.get(p.name);
    rows.push({
      kind: "installed",
      name: p.name,
      version: p.version,
      latest: latest && latest !== p.version ? latest : null,
    });
  }
  if (rows.length) rows.unshift({ kind: "section", id: "installed" });
  const listed = new Set(installed.map((p) => normalize(p.name)));
  const pypi: Row[] = [];
  for (const project of [found, ...names]) {
    if (!project) continue;
    const name = typeof project === "string" ? project : project.name;
    if (listed.has(normalize(name))) continue;
    listed.add(normalize(name));
    pypi.push({ kind: "pypi", name, latest: typeof project === "string" ? null : project.latest });
  }
  if (pypi.length) rows.push({ kind: "section", id: "pypi" }, ...pypi);
  return rows;
}

/** `name==version`, or the bare name for the newest release. */
export const requirementOf = (name: string, version: string | null) => (version ? `${name}==${version}` : name);

/**
 * What pip installs for a repository URL: `git+https://…` and other `vcs+` forms as they are, a
 * plain `https://`, `ssh://` or `git://` URL and scp-like `git@host:path` as Git.
 */
export function vcsRequirement(url: string) {
  const text = url.trim();
  if (/^(https?|ssh|git):\/\//i.test(text)) return `git+${text}`;
  const scp = /^([\w.-]+@[\w.-]+):(?!\/\/)(.+)$/.exec(text);
  return scp ? `git+ssh://${scp[1]}/${scp[2]}` : text;
}

/**
 * Whether `url` (after {@link vcsRequirement}) is a version control URL pip can install, bare
 * (`git+https://…`, `bzr+lp:project`) or as a direct reference (`name @ git+https://…`).
 */
export const isVcsUrl = (url: string) =>
  /^([A-Za-z0-9][\w.-]*(\[[^\]]*\])?\s*@\s*)?((git|hg|svn|bzr)\+[a-z]+:\/\/|bzr\+lp:)\S+$/i.test(url);

/**
 * A path typed for Install from Disk, made explicit so pip never reads it as a PyPI name: a
 * relative one starts with `./` (the host resolves it against the project, and `~/` against home).
 */
export function diskRequirement(path: string) {
  const text = path.trim();
  return /^([./\\~]|[A-Za-z]:[\\/])/.test(text) ? text : `./${text}`;
}

/** A wheel or source archive, which pip can install but not in editable mode. */
export const isArchive = (path: string) => /\.(whl|zip|tar\.gz|tgz|tar\.bz2|tar\.xz)$/i.test(path.trim());

/**
 * `html` with its images, videos and audio taken out, so nothing loads from other sites: an image
 * becomes its alt text. `count` is how many there were.
 */
export function withoutMedia(html: string): { html: string; count: number } {
  const template = document.createElement("template");
  template.innerHTML = html;
  let count = 0;
  for (const el of template.content.querySelectorAll("img, video, audio, source, picture")) {
    if (el.localName === "picture") el.replaceWith(...el.childNodes);
    else if (el.localName === "source") el.remove();
    else {
      count++;
      el.replaceWith(el.getAttribute("alt") ?? "");
    }
  }
  return { html: template.innerHTML, count };
}
