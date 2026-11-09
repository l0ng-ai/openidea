import { afterEach, describe, expect, it } from "vitest";
import { executeAction, getAction, registerActions } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { _resetI18nForTests, setLocale } from "@/platform/i18n";
import { usePlatform } from "@/platform/platformInfo";
import { resolveMenuItems, useContextMenuStore, type MenuItem } from "@/ui";
import { provideEditorService, registerMenuGroup, type EditorService } from "@/workbench/contributions";
import { registerProjectActions, selectInTargets } from "./actions";
import { revealLabel } from "./contextMenu";

const labels = (items: MenuItem[]) => resolveMenuItems(items).map((r) => (r.kind === "separator" ? "-" : r.label));

const disposers: Array<() => void> = [];
afterEach(() => {
  disposers.splice(0).forEach((d) => d());
  useContextMenuStore.setState({ menu: null });
});

describe("Open in Terminal", () => {
  it("opens the edited file's folder unless the Project view has focus", async () => {
    const opened: unknown[] = [];
    disposers.push(
      registerProjectActions(),
      registerActions([{ id: "terminal.openAt", title: "Open Terminal At", run: ({ arg }) => void opened.push(arg) }]),
      () => setContext("projectOpen", false),
      () => setContext("projectViewFocus", false),
    );
    setContext("projectOpen", true);
    provideEditorService({ activePath: () => "/p/src/a.ts" } as unknown as EditorService);
    await executeAction("project.openInTerminal");
    expect(opened).toEqual(["/p/src"]);
    await executeAction("project.openInTerminal", "/p/docs/readme.md");
    expect(opened.at(-1)).toBe("/p/docs");
  });
});

describe("Select In (⌥F1)", () => {
  it.each([
    ["macos", "Finder", "Reveal in Finder"],
    ["windows", "Explorer", "Show in Explorer"],
    ["linux", "Files", "Show in Files"],
  ])("uses the platform store for %s menus and action titles", (os, name, title) => {
    const previous = usePlatform.getState().os;
    try {
      usePlatform.setState({ os });
      disposers.push(registerProjectActions());
      expect(revealLabel()).toBe(name);
      expect(labels(selectInTargets("/p/a.ts"))).toContain(name);
      expect(getAction("project.revealInFinder")?.title).toBe(title);
    } finally {
      usePlatform.setState({ os: previous });
    }
  });

  it("retranslates the file manager action after registering in Chinese", async () => {
    const previous = usePlatform.getState().os;
    try {
      usePlatform.setState({ os: "windows" });
      await setLocale("zh");
      disposers.push(registerProjectActions());
      expect(getAction("project.revealInFinder")?.title).toBe("在资源管理器中显示");
      await setLocale("en");
      expect(getAction("project.revealInFinder")?.title).toBe("Show in Explorer");
    } finally {
      usePlatform.setState({ os: previous });
      _resetI18nForTests();
    }
  });

  it("lists the project view, contributed targets, Finder and the terminal", () => {
    disposers.push(
      registerMenuGroup({
        id: "test.selectIn",
        menus: ["selectIn"],
        items: () => [{ label: "Structure", run: () => {} }],
      }),
      registerActions([{ id: "terminal.openAt", title: "Open Terminal At", run: () => {} }]),
    );
    expect(labels(selectInTargets("/p/src/a.ts"))).toEqual([
      "Select In",
      "Project View",
      "Structure",
      "-",
      revealLabel(),
      "Terminal",
    ]);
  });

  it("without a path shows the chooser for the active file; with one selects it in the project view", async () => {
    disposers.push(registerProjectActions(), () => setContext("projectOpen", false));
    setContext("projectOpen", true);
    provideEditorService({ activePath: () => "/p/src/a.ts" } as unknown as EditorService);
    expect(getAction("navigate.selectInProjectView")?.title).toBe("Select in Project View");
    await executeAction("navigate.selectIn");
    expect(useContextMenuStore.getState().menu?.items[1]).toMatchObject({ label: "Project View" });
    useContextMenuStore.setState({ menu: null });
    await executeAction("navigate.selectIn", { path: "/p/src/a.ts" });
    expect(useContextMenuStore.getState().menu).toBeNull();
  });
});
