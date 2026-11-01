import { describe, expect, it } from "vitest";
import type { FileEntry } from "@/bindings";
import { buildModel, DEFAULT_TREE_OPTIONS, type ExtraRoot, withExtraRoots } from "./model";
import { gradleModuleGroups } from "./moduleGroups";

type Shown = { label: string; detail?: string; children?: Shown[] };
const shape = (e: ExtraRoot): Shown => ({
  label: e.label,
  ...(e.detail ? { detail: e.detail } : {}),
  ...(e.children ? { children: e.children.map(shape) } : {}),
});

describe("gradleModuleGroups (IDEA's module groups)", () => {
  // `includeFlat` sibling modules, one with layer modules nested in its folder.
  const flat = [
    { path: ":", dir: "" },
    { path: ":common", dir: "/w/common" },
    { path: ":billing", dir: "/w/billing" },
    ...["core", "api"].map((l) => ({ path: `:billing:${l}`, dir: `/w/billing/modules/${l}` })),
  ];

  it("lists every module of the group, nested ones flattened, as IntelliJ shows it", () => {
    expect(gradleModuleGroups(flat, "Shop", "/w/shop").map(shape)).toEqual([
      {
        label: "Shop",
        children: [
          { label: "api", detail: "Shop.billing.api" },
          { label: "billing", detail: "Shop.billing" },
          { label: "common", detail: "Shop.common" },
          { label: "core", detail: "Shop.billing.core" },
        ],
      },
    ]);
  });

  it("shows no group while every module lives in the project folder", () => {
    const inside = [
      { path: ":", dir: "" },
      { path: ":app", dir: "app" },
      { path: ":libs:core", dir: "libs/core" },
    ];
    expect(gradleModuleGroups(inside, "demo", "/w/demo")).toEqual([]);
  });

  it("keeps a subgroup that no module is named like", () => {
    const projects = [
      { path: ":", dir: "" },
      { path: ":svc", dir: "/w/svc" },
      { path: ":libs:a", dir: "/w/libs/a" },
      { path: ":libs:b", dir: "/w/libs/b" },
    ];
    expect(gradleModuleGroups(projects, "R", "/w/r").map(shape)).toEqual([
      {
        label: "R",
        children: [
          {
            label: "libs",
            children: [
              { label: "a", detail: "R.libs.a" },
              { label: "b", detail: "R.libs.b" },
            ],
          },
          { label: "svc", detail: "R.svc" },
        ],
      },
    ]);
  });
});

const dir = (path: string): FileEntry => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  kind: "dir",
  size: 0,
  mtimeMs: 1,
  ignored: false,
  excluded: false,
  hidden: false,
});

describe("module group nodes in the tree", () => {
  it("lists the group above the project and keeps a nested module whose parent is expanded", () => {
    const listings = new Map([
      ["/w/billing", [dir("/w/billing/modules")]],
      ["/w/billing/modules", [dir("/w/billing/modules/core")]],
    ]);
    const base = buildModel({ path: "/p", name: "p" }, new Map(), DEFAULT_TREE_OPTIONS);
    const group = {
      label: "Shop",
      icon: "gradle-project",
      beforeProject: true,
      children: [
        { label: "billing", icon: "gradle-module", path: "/w/billing" },
        { label: "core", icon: "gradle-module", path: "/w/billing/modules/core" },
      ],
    };
    const m = withExtraRoots(base, [group], listings, DEFAULT_TREE_OPTIONS);
    expect(m.roots.map((r) => r.label)).toEqual(["Shop", "p"]);
    expect(m.children.get(m.roots[0]!.key)!.map((n) => n.label)).toEqual(["billing", "core"]);
  });
});
