import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addContributedIconTheme,
  useContributedIconThemes,
  type IconThemeChoice,
  type IconThemeDetails,
} from "@/platform/themes";
import { useSettingsPages } from "@/workbench/contributions";
import { trackIconThemePages } from "../iconThemePages";
import { validateSettings } from "../model/schema";
import { useSettingsDialog } from "../model/staging";
import { BEHAVIOR_PAGES } from "../pages/behavior";

const savedDialog = useSettingsDialog.getState();
const KEY = "global|appearance.fileIconThemeOptions";
const PAGE = "plugins.p.t";
const staged = () => useSettingsDialog.getState().staged[KEY]?.value as Record<string, Record<string, unknown>>;

const DETAILS: IconThemeDetails = {
  groups: [{ id: "tests", name: "Tests", enabled: false }],
  choices: [
    {
      id: "arrows",
      name: "Arrows style",
      default: "plain",
      options: [
        { id: "plain", name: "Default" },
        { id: "plus", name: "Plus-Minus" },
      ],
    },
  ],
  accent: true,
  settings: [
    {
      title: "Toggles",
      items: [
        { option: "hideFiles", label: "Files on", hint: "Shows file icons", invert: true },
        { option: "hidePsiIcons", label: "Hide symbols" },
      ],
    },
    { title: "Packs", items: [{ option: "groups", columns: 2 }] },
    {
      title: "Looks",
      items: [
        { option: "choice", choice: "arrows" },
        { option: "rowHeight", label: "Line height", default: 30 },
        { option: "accent", label: "Accent", default: "#112233" },
      ],
    },
  ],
};

const theme = (details: IconThemeDetails | null): IconThemeChoice => ({
  id: "p/t",
  label: "Atom",
  settingsPage: PAGE,
  details: async () => details,
});

function select(selected: string, options: unknown = {}) {
  const base = validateSettings({ appearance: { fileIconTheme: selected, fileIconThemeOptions: options } });
  useSettingsDialog.setState({ base, globalBase: base, staged: {} });
}

const page = () => useSettingsPages.getState().pages.get(PAGE);

async function openPage() {
  await waitFor(() => expect(page()).toBeDefined());
  const Page = page()!.component!;
  render(<Page />);
}

let stop: () => void = () => {};

beforeEach(() => {
  stop = trackIconThemePages();
});

afterEach(() => {
  stop();
  useSettingsDialog.setState(savedDialog);
  useContributedIconThemes.setState({ themes: [] });
});

describe("icon theme settings page", () => {
  it("is registered from the theme's settings while the theme is contributed", async () => {
    const remove = addContributedIconTheme(theme(DETAILS));
    await waitFor(() => expect(page()?.title).toBe("Atom"));
    expect(page()?.keywords).toEqual(expect.arrayContaining(["Toggles", "Files on", "Line height", "Tests"]));
    act(remove);
    expect(page()).toBeUndefined();
  });

  it("is not registered for themes without settings", async () => {
    addContributedIconTheme(theme(null));
    addContributedIconTheme({ ...theme({ ...DETAILS, settings: [] }), id: "p/u", settingsPage: "plugins.p.u" });
    await new Promise((r) => setTimeout(r, 0));
    expect(page()).toBeUndefined();
    expect(useSettingsPages.getState().pages.has("plugins.p.u")).toBe(false);
  });

  it("renders the sections and items the theme declares", async () => {
    addContributedIconTheme(theme(DETAILS));
    select("");
    await openPage();
    for (const title of ["Toggles", "Packs", "Looks"]) {
      expect(screen.getByRole("region", { name: title })).toBeInTheDocument();
    }
    expect(screen.getByText("Shows file icons")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /saturation/i })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Files on" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Hide symbols" })).not.toBeChecked();
  });

  it("stages the options with the theme's defaults, keeping other themes' options", async () => {
    addContributedIconTheme(theme(DETAILS));
    select("", { "q/u": { hideFiles: true } });
    await openPage();
    fireEvent.click(screen.getByRole("checkbox", { name: "Files on" }));
    expect(staged()["p/t"]).toMatchObject({ hideFiles: true });
    fireEvent.click(screen.getByRole("checkbox", { name: "Hide symbols" }));
    expect(staged()["p/t"]).toMatchObject({ hidePsiIcons: true });
    fireEvent.click(screen.getByRole("checkbox", { name: "Tests" }));
    expect(staged()["p/t"]).toMatchObject({ groups: { tests: true } });
    fireEvent.click(screen.getByRole("button", { name: "Arrows style" }));
    fireEvent.click(await screen.findByRole("option", { name: "Plus-Minus" }));
    expect(staged()["p/t"]).toMatchObject({ choices: { arrows: "plus" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Line height" }));
    expect(staged()["p/t"]).toMatchObject({ rowHeight: 30 });
    fireEvent.click(screen.getByRole("checkbox", { name: "Accent" }));
    expect(staged()["p/t"]).toMatchObject({ accent: "#112233" });
    expect(staged()["q/u"]).toMatchObject({ hideFiles: true });
  });

  it("is no longer part of Settings › Appearance", () => {
    addContributedIconTheme(theme(DETAILS));
    select("p/t");
    const option = BEHAVIOR_PAGES.find((p) => p.id === "appearance")!
      .sections!.flatMap((s) => s.options)
      .find((o) => o.kind === "custom" && o.label === "File icon theme")!;
    if (option.kind !== "custom") throw new Error("File icon theme row missing");
    const Row = option.component;
    render(<Row />);
    expect(screen.queryByRole("checkbox", { name: "Files on" })).toBeNull();
  });
});
