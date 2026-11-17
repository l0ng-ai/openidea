import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerActions } from "@/platform/actions";
import { clearContext, setContext } from "@/platform/context";
import { applyKeymapSettings, defaultPreset, installKeyboardDispatcher, presetBindings } from "@/platform/keymap";
import { registerProjectActions } from "./actions";
import { MemoryFs, setProjectFsForTests } from "./fs";
import { initProjectTree, loadDir, setSelection } from "./store";

const CONTEXT = ["projectOpen", "vcsAvailable", "projectViewFocus", "toolWindowFocus", "activeToolWindow"];

const compareFiles = vi.fn();
const compareDirectories = vi.fn();
const compareWith = vi.fn();
const showDiff = vi.fn();
let disposers: Array<() => void> = [];

beforeEach(async () => {
  vi.clearAllMocks();
  const fs = new MemoryFs({ "/p/a.txt": "a", "/p/b.txt": "b", "/p/left": null, "/p/right": null }, "/p");
  setProjectFsForTests(fs, "/p");
  initProjectTree("/p", "p");
  await loadDir("/p");
  disposers = [
    registerProjectActions(),
    // The other claimants of ⌘D / Ctrl+D, with `when` and `keyWhen` as they ship.
    registerActions([
      {
        id: "vcs.showDiff",
        title: "Show Diff",
        when: "vcsAvailable",
        keyWhen: "!editorTextFocus && !vcsLogChangesFocus && !vcsLogRevisionFocus",
        run: showDiff,
      },
      {
        id: "vcs.log.changes.showDiff",
        title: "Show Diff",
        when: "vcsAvailable || projectOpen || vcsLogFocus",
        keyWhen: "vcsLogChangesFocus || vcsLogRevisionFocus",
        run: () => undefined,
      },
      { id: "code.duplicateLine", title: "Duplicate Line", when: "editorTextFocus", run: () => undefined },
      { id: "code.deleteLine", title: "Delete Line", when: "editorTextFocus", run: () => undefined },
      { id: "diff.compareFiles", title: "Compare Files", run: ({ arg }) => compareFiles(arg) },
      { id: "diff.compareDirectories", title: "Compare Directories", run: ({ arg }) => compareDirectories(arg) },
      { id: "diff.compareWith", title: "Compare With…", run: ({ arg }) => compareWith(arg) },
    ]),
    installKeyboardDispatcher(window),
  ];
  setContext("projectOpen", true);
  setContext("vcsAvailable", true);
});

afterEach(() => {
  disposers.forEach((dispose) => dispose());
  CONTEXT.forEach(clearContext);
  applyKeymapSettings(defaultPreset(), {});
  setProjectFsForTests(null);
  initProjectTree(null);
});

const press = async (binding: string) => {
  const meta = binding.startsWith("Meta+");
  window.dispatchEvent(
    new KeyboardEvent("keydown", { code: "KeyD", key: "d", metaKey: meta, ctrlKey: !meta, bubbles: true }),
  );
  await new Promise((resolve) => setTimeout(resolve));
};

const select = (...paths: string[]) => setSelection(new Set(paths), paths[0] ?? null);

describe.each(["intellij-macos", "intellij-windows", "eclipse-macos", "eclipse-windows"])(
  "Compare With… shortcut in %s (#3806)",
  (preset) => {
    const binding = () => presetBindings(preset, "project.compareWith")[0]!;
    beforeEach(() => applyKeymapSettings(preset, {}));

    it("compares two files, two folders or one node in the project view instead of showing Git diffs", async () => {
      setContext("projectViewFocus", true);
      setContext("toolWindowFocus", true);
      setContext("activeToolWindow", "project");

      select("/p/a.txt", "/p/b.txt");
      await press(binding());
      expect(compareFiles).toHaveBeenCalledExactlyOnceWith(["/p/a.txt", "/p/b.txt"]);

      select("/p/left", "/p/right");
      await press(binding());
      expect(compareDirectories).toHaveBeenCalledExactlyOnceWith(["/p/left", "/p/right"]);

      select("/p/left");
      await press(binding());
      expect(compareWith).toHaveBeenLastCalledWith({ path: "/p/left", directory: true });
      select("/p/a.txt");
      await press(binding());
      expect(compareWith).toHaveBeenLastCalledWith("/p/a.txt");

      select("/p/left", "/p/a.txt");
      await press(binding());
      expect(compareWith).toHaveBeenCalledTimes(2);
      expect(showDiff).not.toHaveBeenCalled();
    });

    it("leaves the shortcut to Show Diff outside the project view", async () => {
      setContext("toolWindowFocus", true);
      setContext("activeToolWindow", "commit");
      select("/p/a.txt", "/p/b.txt");
      await press(binding());
      expect(showDiff).toHaveBeenCalledOnce();
      expect(compareFiles).not.toHaveBeenCalled();
    });
  },
);
