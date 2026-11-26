/** Which "New › Package" flavour a folder offers, from the project's roots. */
import { rootFor, type RootFolder } from "@/platform/languageSettings";
import { isJvmSourcePackage } from "@/ui/folderPresentation";
import type { PackageKind } from "./paths";

const PY_BUILD = /(^|\/)(pyproject\.toml|setup\.py|setup\.cfg|Pipfile|requirements\.txt)$/;

const moduleDir = (buildFile: string) =>
  buildFile.includes("/") ? buildFile.slice(0, buildFile.lastIndexOf("/")) : "";
const within = (rel: string, dir: string) => !dir || rel === dir || rel.startsWith(`${dir}/`);

/**
 * `jvm` inside a Java / Kotlin source or test root (IDEA shows "Package" there
 * instead of "Directory"); `python` inside a Python module (PyCharm's "Python Package").
 */
export function packageKindAt(
  rel: string,
  roots: readonly RootFolder[],
  detected: readonly RootFolder[] = [],
): PackageKind | null {
  if (rootFor(roots, rel)?.kind === "excluded") return null;
  if (isJvmSourcePackage(rel, roots)) return "jvm";
  // A root `pyproject.toml` must not claim `frontend/src`, a root that
  // `frontend/package.json` detected, unless a deeper Python module holds the folder.
  let python = -1;
  let other = -1;
  for (const r of [...roots, ...detected]) {
    if (!r.detectedFrom) continue;
    if (PY_BUILD.test(r.detectedFrom)) {
      const dir = moduleDir(r.detectedFrom);
      if (within(rel, dir)) python = Math.max(python, dir.length);
    } else if (within(rel, r.path)) other = Math.max(other, r.path.length);
  }
  return python >= 0 && python >= other ? "python" : null;
}
