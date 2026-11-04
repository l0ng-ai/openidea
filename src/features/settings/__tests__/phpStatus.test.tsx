import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeAction, registerAction } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { useProject } from "@/platform/project";
import type { PhpLanguageLevels, ProjectInfo } from "@/bindings";

const mocks = vi.hoisted(() => ({
  notify: vi.fn(),
  level: vi.fn(),
  set: vi.fn(),
  component: null as React.ComponentType | null,
}));
vi.mock("@/platform/ipc", () => ({
  call: (p: unknown) => p,
  isTauri: () => true,
  onIdeEvent: () => () => {},
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
    mocks.level.mockResolvedValueOnce({ effective: { version: "7.2.34", source: "platform" }, auto: null });
    mount();
    await focus("php", "/project/a.php");
    const button = await screen.findByRole("button", { name: "PHP Language Level: PHP 7.2" });
    expect(button.dataset.tooltip).toBe("PHP 7.2.34, from config.platform.php in composer.json");
    mocks.level.mockResolvedValueOnce({ effective: null, auto: null });
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
    mocks.level.mockResolvedValue({ effective: { version: "8.1.0", source: "settings" }, auto: fromComposer.auto });
    await pick("8.1");
    await waitFor(() =>
      expect(mocks.set).toHaveBeenCalledWith("project", "languages.php.languageLevel", JSON.stringify("8.1")),
    );
    const button = await screen.findByRole("button", { name: "PHP Language Level: PHP 8.1" });
    expect(button.dataset.tooltip).toBe("PHP 8.1.0, set in the settings");
    expect(useProject.getState().settings?.languages?.php?.languageLevel).toBe("8.1");
  });

  it("shows what Auto resolves to and clears the level with it", async () => {
    mocks.level.mockResolvedValue({ effective: { version: "8.1.0", source: "settings" }, auto: fromComposer.auto });
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
