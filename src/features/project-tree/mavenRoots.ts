/** Project-view roots for Maven projects linked from outside the opened folder. */
import { ipcPath, isSameOrInside } from "@/platform/paths";

export interface MavenExternalRoot {
  id: string;
  label: string;
  path: string;
  detail: string;
}

const absolute = (path: string) => path.startsWith("/") || path.startsWith("//") || /^[A-Za-z]:\//.test(path);

/** `dir` against `projectRoot`, with `.` and `..` collapsed. Absolute paths stay absolute. */
export function resolveMavenDir(projectRoot: string, dir: string): string {
  const root = ipcPath(projectRoot).replace(/\/$/, "");
  const raw = ipcPath(dir);
  return lexical(absolute(raw) ? raw : `${root}/${raw}`);
}

function lexical(path: string): string {
  const unc = path.startsWith("//");
  const rooted = path.startsWith("/");
  const drive = /^[A-Za-z]:\//.test(path);
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      const top = parts[parts.length - 1];
      if (top && top !== ".." && !(drive && parts.length === 1)) parts.pop();
      else if (!rooted && !drive) parts.push("..");
      continue;
    }
    parts.push(part);
  }
  if (unc) return `//${parts.join("/")}`;
  if (rooted) return `/${parts.join("/")}`;
  return parts.join("/");
}

/**
 * Top-level Maven projects whose directory is outside `projectRoot`. A module
 * nested in another linked directory is left to that directory's listing.
 */
export function mavenExternalRoots(
  projects: readonly { dir: string; aggregated: boolean }[],
  projectRoot: string,
): MavenExternalRoot[] {
  const root = ipcPath(projectRoot).replace(/\/$/, "");
  const items = projects
    .filter((project) => !project.aggregated)
    .map((project) => resolveMavenDir(root, project.dir))
    .filter((path) => path.length > 0 && !isSameOrInside(path, root));
  const top = items.filter((path) => !items.some((other) => other !== path && isSameOrInside(path, other)));
  top.sort((a, b) => a.localeCompare(b));
  return top.map((path) => ({
    id: `mavenExternal:${path}`,
    label: path.slice(path.lastIndexOf("/") + 1) || path,
    path,
    detail: path,
  }));
}
