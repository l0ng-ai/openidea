import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: { ...real.commands, dbSources: vi.fn(async () => ({ status: "ok" as const, data: [] })) },
  };
});

const { PageContext } = await import("../components/context");
const { validateSettings } = await import("../model/schema");
const { stage, useSettingsDialog } = await import("../model/staging");
const { LaravelPage } = await import("../languages/LaravelPage");
const { PhpPage } = await import("../languages/LanguagePages");
const { buildPageTree } = await import("../model/pages");
const { LANGUAGE_PAGES } = await import("../pages/languages");

const PAGE = "languages.php.laravel";
const savedDialog = useSettingsDialog.getState();
afterEach(() => {
  cleanup();
  useSettingsDialog.setState(savedDialog, true);
});

const mount = (staged: Record<string, unknown> = {}) => {
  const base = validateSettings({});
  useSettingsDialog.setState({ base, globalBase: base, staged: {} });
  for (const [key, value] of Object.entries(staged)) stage(PAGE, "project", `languages.php.laravel.${key}`, value);
  return render(
    <PageContext.Provider value={{ pageId: PAGE, scope: "project" }}>
      <LaravelPage />
    </PageContext.Provider>,
  );
};

const staged = (key: string) => useSettingsDialog.getState().staged[`project|languages.php.laravel.${key}`]?.value;

const choose = (select: string, option: RegExp) => {
  fireEvent.click(screen.getByRole("button", { name: select }));
  fireEvent.click(screen.getByRole("option", { name: option }));
};

describe("Settings › PHP › Laravel", () => {
  it("is a page below PHP, found by its settings", () => {
    const tree = buildPageTree(LANGUAGE_PAGES.map((p) => ({ ...p, component: p.component! })));
    const langs = tree.find((n) => n.title === "Languages & Frameworks")!;
    const php = langs.children.find((n) => n.title === "PHP")!;
    expect(php.children.map((n) => n.title)).toEqual(["Laravel", "Inspections"]);
    const page = LANGUAGE_PAGES.find((p) => p.id === PAGE)!;
    for (const keyword of ["detection", "modules", "route hints", "database", "inertia", "code generation"]) {
      expect(page.keywords).toContain(keyword);
    }
  });

  it("shows every Laravel setting, and the PHP page no longer does", () => {
    mount();
    for (const section of ["Hints", "Database", "Inertia", "Code Generation"]) {
      expect(screen.getByRole("region", { name: section })).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: "Laravel support" }).textContent).toContain("Auto");
    expect(screen.getByRole("button", { name: "Laravel modules" }).textContent).toContain("Auto");
    expect(screen.getByLabelText<HTMLInputElement>("Show route hints").checked).toBe(true);
    expect(screen.getByLabelText("Laravel database")).toBeTruthy();
    expect(screen.getByLabelText("Inertia page folders")).toBeTruthy();
    expect(screen.getByLabelText("Controller suffix")).toBeTruthy();
    cleanup();

    render(
      <PageContext.Provider value={{ pageId: "languages.php", scope: "project" }}>
        <PhpPage />
      </PageContext.Provider>,
    );
    expect(screen.queryByLabelText("Show route hints")).toBeNull();
    expect(screen.queryByLabelText("Controller suffix")).toBeNull();
  });

  it("stores detection, modules and route hints", () => {
    mount();
    choose("Laravel support", /^Enabled/);
    expect(staged("detection")).toBe("enabled");
    choose("Laravel modules", /^nwidart\/laravel-modules/);
    expect(staged("modules")).toBe("nwidart");
    fireEvent.click(screen.getByLabelText("Show route hints"));
    expect(staged("routeHints")).toBe(false);
  });

  it("turns the other rows off while Laravel support is disabled", () => {
    mount({ detection: "disabled" });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Laravel modules" }).disabled).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>("Show route hints").disabled).toBe(true);
  });

  it("edits the Inertia page folders", () => {
    mount({ inertiaPages: ["resources/js/Pages"] });
    expect(screen.getByText("resources/js/Pages")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const input = screen.getByLabelText("Page folder");
    fireEvent.change(input, { target: { value: " resources/js/Screens " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(staged("inertiaPages")).toEqual(["resources/js/Pages", "resources/js/Screens"]);
  });
});
