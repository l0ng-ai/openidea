import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeAction, registerAction } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { useProject } from "@/platform/project";
import type { PhpLanguageLevels, ProjectInfo, Settings } from "@/bindings";

type FsChange = { created: string[]; modified: string[]; removed: string[] };

const mocks = vi.hoisted(() => ({
  notify: vi.fn(),
  level: vi.fn(),
  set: vi.fn(),
  fsChanged: undefined as ((e: FsChange) => void) | undefined,
  component: null as React.ComponentType | null,
}));
vi.mock("@/platform/ipc", () => ({
  call: (p: unknown) => p,
  isTauri: () => true,
  onIdeEvent: (name: string, handler: (e: FsChange) => void) => {
    if (name === "fsChanged") mocks.fsChanged = handler;
    return () => {};
  },
  commands: { sdkPhpLanguageLevel: mocks.level, settingsSet: mocks.set },
}));
vi.mock("@/workbench/contributions", () => ({
  notifications: () => ({ notify: mocks.notify }),
  registerStatusItem: (item: { component: React.ComponentType }) => {
    mocks.component = item.component;
    return () => {};
  },
}));
import { activatePhpStatus } from "../languages/PhpStatus";

const fromComposer: PhpLanguageLevels = {
  effective: { version: "7.4.0", source: "require" },
  auto: { version: "7.4.0", source: "require" },
  member: null,
};

const focus = (language: string, path: string) =>
  act(() => {
    setContext("editorLangId", language);
    setContext("editorPath", path);
  });

let dispose: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.level.mockResolvedValue(fromComposer);
  mocks.set.mockImplementation((_scope: string, _key: string, value: string) =>
    Promise.resolve({ languages: { php: { languageLevel: JSON.parse(value) } } }),
  );
  useProject.setState({ project: { root: "/project" } as ProjectInfo, settings: null });
  setContext("projectOpen", true);
  setContext("editorLangId", null);
  setContext("editorPath", null);
  dispose = activatePhpStatus();
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  dispose();
});

const mount = () => {
  const Component = mocks.component!;
  return render(<Component />);
};

const pick = async (label: string) => {
  await act(() => executeAction("php.languageLevelPopup"));
  fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: label }));
};

describe("PHP language level status", () => {
  it("stays hidden for other editors without asking the backend", async () => {
    mount();
    await focus("typescript", "/project/src/app.ts");
    expect(screen.queryByRole("button")).toBeNull();
    expect(mocks.level).not.toHaveBeenCalled();
  });

  it("shows the effective level of the focused PHP file and where it comes from", async () => {
    mount();
    await focus("php", "/project/src/Invoice.php");
    const button = await screen.findByRole("button", { name: "PHP Language Level: PHP 7.4" });
    expect(button.textContent).toBe("PHP 7.4");
    expect(button.dataset.tooltip).toBe("PHP 7.4.0, the lowest version require.php in composer.json allows");
    expect(mocks.level).toHaveBeenCalledWith("/project/src/Invoice.php");
    await focus("markdown", "/project/README.md");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("names config.platform.php and the language server default", async () => {
    mocks.level.mockResolvedValueOnce({
      effective: { version: "7.2.34", source: "platform" },
      auto: null,
      member: null,
    });
    mount();
    await focus("php", "/project/a.php");
    const button = await screen.findByRole("button", { name: "PHP Language Level: PHP 7.2" });
    expect(button.dataset.tooltip).toBe("PHP 7.2.34, from config.platform.php in composer.json");
    mocks.level.mockResolvedValueOnce({ effective: null, auto: null, member: null });
    await focus("php", "/project/b.php");
    const fallback = await screen.findByRole("button", { name: "PHP Language Level: PHP" });
    expect(fallback.dataset.tooltip).toBe(
      "No PHP version in the settings or composer.json: Intelephense uses its default",
    );
  });

  it("writes the picked level to the project settings", async () => {
    mount();
    await focus("php", "/project/src/Invoice.php");
    await screen.findByRole("button", { name: "PHP Language Level: PHP 7.4" });
    mocks.level.mockResolvedValue({ ...fromComposer, effective: { version: "8.1.0", source: "settings" } });
    await pick("8.1");
    await waitFor(() =>
      expect(mocks.set).toHaveBeenCalledWith("project", "languages.php.languageLevel", JSON.stringify("8.1")),
    );
    const button = await screen.findByRole("button", { name: "PHP Language Level: PHP 8.1" });
    expect(button.dataset.tooltip).toBe("PHP 8.1.0, set in the settings");
    expect(useProject.getState().settings?.languages?.php?.languageLevel).toBe("8.1");
  });

  it("shows what Auto resolves to and clears the level with it", async () => {
    mocks.level.mockResolvedValue({ ...fromComposer, effective: { version: "8.1.0", source: "settings" } });
    useProject.setState({ settings: { languages: { php: { languageLevel: "8.1" } } } as Settings });
    mount();
    await focus("php", "/project/src/Invoice.php");
    await screen.findByRole("button", { name: "PHP Language Level: PHP 8.1" });
    await act(() => executeAction("php.languageLevelPopup"));
    expect(screen.getByRole("menuitemcheckbox", { name: "8.1" }).getAttribute("aria-checked")).toBe("true");
    const auto = screen.getByRole("menuitemcheckbox", { name: /^Auto/ });
    expect(auto.getAttribute("aria-checked")).toBe("false");
    expect(auto.textContent).toContain("7.4");
    mocks.level.mockResolvedValue(fromComposer);
    fireEvent.click(auto);
    await waitFor(() =>
      expect(mocks.set).toHaveBeenCalledWith("project", "languages.php.languageLevel", JSON.stringify("")),
    );
    expect(await screen.findByRole("button", { name: "PHP Language Level: PHP 7.4" })).toBeTruthy();
  });

  it("re-reads the level once after composer.json of the project or a linked project changes", async () => {
    useProject.setState({ project: { root: "/project", workspace: { projects: ["/linked/api"] } } as ProjectInfo });
    mount();
    await focus("php", "/project/src/Invoice.php");
    await screen.findByRole("button", { name: "PHP Language Level: PHP 7.4" });
    vi.useFakeTimers();
    const change = (...modified: string[]) => act(() => mocks.fsChanged!({ created: [], modified, removed: [] }));
    await change("/project/vendor/acme/lib/composer.json", "/project/src/composer.json");
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(mocks.level).toHaveBeenCalledTimes(1);
    for (const file of ["/project/composer.json", "/project/composer.json", "/linked/api/composer.json"]) {
      await change(file);
    }
    await act(() => vi.advanceTimersByTimeAsync(299));
    expect(mocks.level).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(mocks.level).toHaveBeenCalledTimes(2);
  });

  it("re-reads the level when the PHP language level setting changes, not other settings", async () => {
    mount();
    await focus("php", "/project/src/Invoice.php");
    await screen.findByRole("button", { name: "PHP Language Level: PHP 7.4" });
    act(() => useProject.setState({ settings: { editor: { fontSize: 15 } } as Settings }));
    expect(mocks.level).toHaveBeenCalledTimes(1);
    act(() => useProject.setState({ settings: { languages: { php: { languageLevel: "8.1" } } } as Settings }));
    await waitFor(() => expect(mocks.level).toHaveBeenCalledTimes(2));
  });

  it("shows a workspace member's level but leaves its choice to the member's settings", async () => {
    mocks.level.mockResolvedValue({ ...fromComposer, member: "/project/api" });
    mount();
    await focus("php", "/project/api/src/Invoice.php");
    await screen.findByRole("button", { name: "PHP Language Level: PHP 7.4" });
    await act(() => executeAction("php.languageLevelPopup"));
    expect(screen.getByText("Set in the settings of the linked project api")).toBeTruthy();
    const items = screen.getAllByRole("menuitemcheckbox");
    expect(items.map((item) => item.getAttribute("aria-disabled"))).toEqual(items.map(() => "true"));
    expect(screen.getByRole("menuitemcheckbox", { name: /^Auto/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "8.1" }));
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("drops the previous file's level and menu when another PHP file is focused", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.level.mockResolvedValueOnce({ ...fromComposer, member: "/project/api" });
    mount();
    await focus("php", "/project/api/src/Order.php");
    await screen.findByRole("button", { name: "PHP Language Level: PHP 7.4" });
    await act(() => executeAction("php.languageLevelPopup"));
    expect(screen.getByRole("menu")).toBeTruthy();
    mocks.level.mockRejectedValueOnce(new Error("project closed"));
    await focus("php", "/project/src/Invoice.php");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(mocks.level).toHaveBeenLastCalledWith("/project/src/Invoice.php");
    expect(screen.queryByRole("button")).toBeNull();
    warn.mockRestore();
  });

  it("ignores levels it does not list and reports write failures", async () => {
    await executeAction("php.selectLanguageLevel", "9.9");
    expect(mocks.set).not.toHaveBeenCalled();
    mocks.set.mockRejectedValueOnce(new Error("write failed"));
    await executeAction("php.selectLanguageLevel", "8.1");
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ level: "error" }));
    expect(useProject.getState().settings).toBeNull();
  });

  it("opens the PHP settings page while the widget is hidden", async () => {
    const run = vi.fn();
    const off = registerAction({ id: "file.settings", title: "Settings…", run });
    mount();
    await focus("typescript", "/project/src/app.ts");
    await executeAction("php.languageLevelPopup");
    expect(run.mock.calls.map(([ctx]) => ctx.arg)).toEqual(["languages.php"]);
    off();
  });
});
