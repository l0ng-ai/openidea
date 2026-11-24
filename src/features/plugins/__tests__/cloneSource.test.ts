import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PluginInfo, UiContribution } from "@/bindings";
import { useCloneSources } from "@/workbench/contributions";
import { createMemoryPluginsBackend, setPluginsBackend } from "../backend";
import { clonePickFromMessage } from "../cloneSource";
import { clearUiContributions, syncUiContributions } from "../projection";
import { defineViewUiPoints } from "../uiPoints";

const plugins = [{ id: "gitee", status: "inactive" }] as PluginInfo[];
const source = (extra: Record<string, unknown> = {}): UiContribution => ({
  pluginId: "gitee",
  point: "cloneSources",
  key: "cloneSources/gitee",
  decl: { id: "gitee", label: "Gitee", web: "clone/index.html", ...extra },
});
const registered = () => useCloneSources.getState().sources.get("plugin:gitee/gitee");
let stop: () => void;

beforeEach(() => {
  clearUiContributions();
  stop = defineViewUiPoints();
});

afterEach(() => {
  clearUiContributions();
  stop();
  setPluginsBackend(null);
});

it("reads the repository a page picked", () => {
  expect(clonePickFromMessage('{"op":"clone-url","url":"https://gitee.com/acme/widgets.git"}')).toEqual({
    url: "https://gitee.com/acme/widgets.git",
    clone: false,
  });
  expect(clonePickFromMessage('{"op":"clone-url","url":"  git@gitee.com:acme/widgets.git  "}')).toEqual({
    url: "git@gitee.com:acme/widgets.git",
    clone: false,
  });
  // A double click asks the dialog to clone right away, like the built-in sources.
  expect(clonePickFromMessage('{"op":"clone-url","url":"https://gitee.com/a/b.git","clone":true}')).toEqual({
    url: "https://gitee.com/a/b.git",
    clone: true,
  });
});

it("leaves everything else to the plugin", () => {
  for (const text of [
    "",
    "not json",
    "[]",
    "null",
    '{"op":"other","url":"https://gitee.com/a/b.git"}',
    '{"op":"clone-url"}',
    '{"op":"clone-url","url":42}',
    '{"op":"clone-url","url":"   "}',
    // A URL with a space is not a clone URL: the dialog's field takes one token.
    '{"op":"clone-url","url":"https://gitee.com/a b"}',
  ]) {
    expect(clonePickFromMessage(text), text).toBeNull();
  }
});

it("registers the source with the dialog as the plugin declared it", () => {
  syncUiContributions([source({ icon: "branch" })], plugins);
  expect(registered()).toMatchObject({ id: "plugin:gitee/gitee", label: "Gitee", icon: "branch", order: 100 });
});

it("falls back to a generic icon, and disposes with the plugin", () => {
  syncUiContributions([source()], plugins);
  expect(registered()?.icon).toBe("branch");
  syncUiContributions([], plugins);
  expect(registered()).toBeUndefined();
});

it("shows a package SVG as the source's icon", async () => {
  setPluginsBackend({
    ...createMemoryPluginsBackend([]),
    assets: async () => [["cloneSourceIcon/gitee", '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>']],
  });
  syncUiContributions([source({ icon: "icon.svg" })], plugins);
  // The asset arrives asynchronously; the source is registered once it does.
  await vi.waitFor(() => expect(registered()?.icon).toContain("pluginIcon/gitee"));
});
