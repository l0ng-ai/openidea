/**
 * Navigate › Test / Test Subject (⇧⌘T): from a class to its tests and back,
 * by the naming conventions of `testNaming.ts` and the project's source /
 * test roots. One match opens it; several show a chooser; with none (or
 * always, in the chooser) "Create New Test…" creates one from the file templates.
 */
import { basename, dirname } from "@/platform/project";
import { tx } from "@/platform/i18n";
import { isTestFile, rootOfPath } from "@/platform/projectRoots";
import type { RootFolder } from "@/platform/languageSettings";
import {
  isTestName,
  newTestName,
  rankCandidates,
  rustTestModuleOffset,
  splitName,
  subjectNamesFor,
  testNamesFor,
} from "./testNaming";

export type ChooserItem = {
  label: string;
  run: () => void | Promise<void>;
} & ({ kind: "target"; detail: string } | { kind: "create" });

export interface TestNavDeps {
  projectRoot: () => string | null;
  roots: () => RootFolder[];
  /** Absolute paths of project files named exactly `name`. */
  findByName: (name: string) => Promise<string[]>;
  open: (path: string, offset?: number) => Promise<void>;
  choose: (title: string, items: ChooserItem[]) => void;
  hint: (text: string) => void;
  /** Create New Test… in `directory` (file templates), or a Rust test module in the file itself. */
  createTest: (req: { directory: string; name: string; extension: string; subject: string }) => void;
  createRustTestModule: () => void;
  /** Name of the top-level class, interface, enum or object around the caret, if any. */
  classAtCaret?: () => Promise<string | null>;
}

/** Languages whose files are named after a class but may declare several top-level ones. */
const CLASS_FILE = /\.(java|kt|scala|groovy|cs)$/;

/** The file name as the class at the caret would have it (`Helper.java` inside `Widget.java`), else the file's own. */
async function subjectFileName(path: string, deps: TestNavDeps): Promise<string> {
  const name = basename(path);
  if (!CLASS_FILE.test(name) || !deps.classAtCaret) return name;
  const cls = await deps.classAtCaret().catch(() => null);
  return cls ? cls + splitName(name).ext : name;
}

const isRustIntegrationTest = (path: string) => path.endsWith(".rs") && /\/tests\/[^/]+\.rs$/.test(path);

export function isTestSide(path: string, roots: readonly RootFolder[]): boolean {
  return isTestFile(path, [...roots]) || isTestName(basename(path)) || isRustIntegrationTest(path);
}

/** Path below the innermost root (`com/x/Foo.java` for `src/main/java/com/x/Foo.java`). */
function belowRoot(root: string | null, roots: readonly RootFolder[]) {
  return (path: string): string | null => {
    if (!root || !path.startsWith(root + "/")) return null;
    const rel = path.slice(root.length + 1);
    const r = rootOfPath(path, [...roots]);
    return r && r.path ? rel.slice(r.path.length + 1) : rel;
  };
}

const commonSegments = (a: string, b: string) => {
  const x = a.split("/");
  const y = b.split("/");
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
};

/** Where Create New Test… puts the test: the mirrored package under the closest test root, else next to the file. */
export function testDirectoryFor(path: string, projectRoot: string | null, roots: readonly RootFolder[]): string {
  const dir = dirname(path);
  if (!projectRoot) return dir;
  const own = rootOfPath(path, [...roots]);
  const tests = roots.filter((r) => r.kind === "test");
  if (!own || own.kind !== "source" || !tests.length) return dir;
  const best = [...tests].sort((a, b) => commonSegments(own.path, b.path) - commonSegments(own.path, a.path))[0]!;
  const ownBase = own.path ? `${projectRoot}/${own.path}` : projectRoot;
  const relDir = dir === ownBase ? "" : dir.slice(ownBase.length + 1);
  const base = best.path ? `${projectRoot}/${best.path}` : projectRoot;
  return relDir ? `${base}/${relDir}` : base;
}

async function findAll(names: readonly string[], self: string, deps: TestNavDeps): Promise<string[]> {
  const found = await Promise.all(names.map((n) => deps.findByName(n).catch(() => [] as string[])));
  return [...new Set(found.flat())].filter((p) => p !== self);
}

function relLabel(root: string | null, path: string) {
  return root && path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
}

export async function gotoTestOrSubject(path: string, text: string, deps: TestNavDeps): Promise<void> {
  const roots = deps.roots();
  const root = deps.projectRoot();
  const name = await subjectFileName(path, deps);
  const { stem, ext } = splitName(name);
  const rank = (paths: string[]) => rankCandidates(path, paths, belowRoot(root, roots));

  if (isTestSide(path, roots)) {
    const subjects = rank((await findAll(subjectNamesFor(name), path, deps)).filter((p) => !isTestSide(p, roots)));
    if (subjects.length === 1) return deps.open(subjects[0]!);
    if (!subjects.length) return deps.hint("No test subject found");
    return deps.choose(
      tx`Choose Test Subject for ${stem} (${subjects.length} found)`,
      subjects.map((p) => ({
        kind: "target",
        label: basename(p),
        detail: relLabel(root, dirname(p)),
        run: () => deps.open(p),
      })),
    );
  }

  const tests = rank((await findAll(testNamesFor(name), path, deps)).filter((p) => isTestSide(p, roots)));
  const items: ChooserItem[] = tests.map((p) => ({
    kind: "target",
    label: basename(p),
    detail: relLabel(root, dirname(p)),
    run: () => deps.open(p),
  }));
  // Rust unit tests live in the file's own `#[cfg(test)]` module.
  const inFile = path.endsWith(".rs") ? rustTestModuleOffset(text) : null;
  if (inFile !== null)
    items.unshift({
      kind: "target",
      label: "mod tests",
      detail: `${name} (#[cfg(test)])`,
      run: () => deps.open(path, inFile),
    });
  if (items.length === 1) return void (await items[0]!.run());
  const create: ChooserItem = {
    kind: "create",
    label: "Create New Test…",
    run: () =>
      path.endsWith(".rs")
        ? deps.createRustTestModule()
        : deps.createTest({
            directory: testDirectoryFor(path, root, roots),
            name: splitName(newTestName(name)).stem,
            extension: ext.replace(/^\./, ""),
            subject: name,
          }),
  };
  deps.choose(tx`Choose Test for ${stem} (${items.length} found)`, [...items, create]);
}
