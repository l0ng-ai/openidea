import { afterEach, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { focusedDiffSource, registerDiffSource, type DiffSource } from "../diffSource";

afterEach(() => {
  document.body.innerHTML = "";
});

const view = () => {
  const outer = document.createElement("div");
  const inner = document.createElement("div");
  const row = document.createElement("button");
  inner.append(row);
  outer.append(inner);
  document.body.append(outer);
  return { outer, inner, row };
};

it("answers with the innermost registered view around the focus, and nothing outside", () => {
  const { outer, inner, row } = view();
  const panel: DiffSource = { show: () => {} };
  const tree: DiffSource = { show: () => {} };
  const offPanel = registerDiffSource(outer, panel);
  const offTree = registerDiffSource(inner, tree);
  const elsewhere = document.createElement("button");
  document.body.append(elsewhere);

  row.focus();
  expect(focusedDiffSource()).toBe(tree);
  offTree();
  expect(focusedDiffSource()).toBe(panel);
  elsewhere.focus();
  expect(focusedDiffSource()).toBeNull();
  offPanel();
});

it("keeps a newer registration when an older one of the same element unregisters", () => {
  const { outer, row } = view();
  const first: DiffSource = { show: () => {} };
  const second: DiffSource = { show: () => {} };
  const offFirst = registerDiffSource(outer, first);
  const offSecond = registerDiffSource(outer, second);
  offFirst();
  row.focus();
  expect(focusedDiffSource()).toBe(second);
  offSecond();
  expect(focusedDiffSource()).toBeNull();
});

/** Source files under `dir`, tests excluded. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

it("leaves the diff actions' keys to the keymap: views register a diff source instead", () => {
  // A view claiming Show Diff's key misses a key the user bound to Show Diff in New Window,
  // and menus and Find Action never pass through key claims.
  const claims = sources(join(__dirname, "../../..")).filter((path) =>
    /bindingsFor\(\s*"vcs\.(showDiff|showDiffInNewWindow)"\s*\)/.test(readFileSync(path, "utf8")),
  );
  expect(claims).toEqual([]);
});
