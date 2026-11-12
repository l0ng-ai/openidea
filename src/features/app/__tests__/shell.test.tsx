import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Action } from "@/platform/actions";
import { keymapReference, KeymapReferenceOverlay, showKeymapReference } from "../KeymapReference";
import { windowTitle } from "../title";
import { aboutRows } from "../AboutDialog";
import { ask, MessagesHost as PromptOverlay } from "@/workbench/messages";
import { usePlatform } from "@/platform/platformInfo";

describe("window title", () => {
  it("is `<project> – <file>` like IDEA", () => {
    expect(windowTitle("openidea", "/p/openidea/src/main.rs")).toBe("openidea – main.rs");
    expect(windowTitle("openidea", null)).toBe("openidea");
    expect(windowTitle(null, null)).toBe("OpenIDEA");
  });
  it("names the host of a remote project", () => {
    expect(windowTitle("rproj", "/home/me/rproj/a.ts", false, "me@server")).toBe("rproj [me@server] – a.ts");
    expect(windowTitle("rproj", null, false, "me@server")).toBe("rproj [me@server]");
  });
});

describe("keymap reference", () => {
  const actions = new Map<string, Action>([
    ["file.save", { id: "file.save", title: "Save All", category: "File", run: () => {} }],
    ["hidden.one", { id: "hidden.one", title: "Hidden", hidden: true, run: () => {} }],
  ]);
  const bindings: Array<[string, string]> = [
    ["Meta+S", "file.save"],
    ["Meta+O", "navigate.gotoClass"],
    ["Meta+-", "code.foldToggle"],
    ["Meta+=", "code.foldToggle"],
    ["Meta+H", "hidden.one"],
    ["Alt+X", "zzz.custom"],
  ];

  it("groups bound actions by category, unknown ones by id prefix", () => {
    const groups = keymapReference(actions, bindings);
    expect(groups.map((g) => g.category)).toEqual(["Code", "File", "Navigate", "Other"]);
    expect(groups.find((g) => g.category === "File")?.entries).toEqual([
      { id: "file.save", title: "Save All", shortcuts: ["⌘S"] },
    ]);
    expect(groups.find((g) => g.category === "Code")?.entries[0]).toMatchObject({
      title: "Fold Toggle",
      shortcuts: ["⌘-", "⌘="],
    });
    expect(groups.flatMap((g) => g.entries).some((e) => e.id === "hidden.one")).toBe(false);
  });

  it("filters by title, id or shortcut", () => {
    expect(keymapReference(actions, bindings, "save").flatMap((g) => g.entries.map((e) => e.id))).toEqual([
      "file.save",
    ]);
    expect(keymapReference(actions, bindings, "⌘O").flatMap((g) => g.entries.map((e) => e.id))).toEqual([
      "navigate.gotoClass",
    ]);
  });

  it("renders the overlay", async () => {
    render(<KeymapReferenceOverlay />);
    act(() => showKeymapReference());
    expect(await screen.findByRole("dialog", { name: "Keymap Reference" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Navigate" })).toBeInTheDocument();
  });
});

describe("about", () => {
  it("lists version, build and platform", () => {
    const rows = aboutRows(
      {
        version: "0.1.0",
        build: "dev",
        profile: "debug",
        os: "macos",
        arch: "aarch64",
        tauri: "2.12.4",
        updates: false,
      },
      "/cfg",
    );
    expect(rows).toEqual([
      ["Version", "0.1.0"],
      ["Build", "dev (debug)"],
      ["Platform", "macOS aarch64"],
      ["Runtime", "Tauri 2.12.4"],
      ["Configuration", "/cfg"],
    ]);
  });
});

describe("prompt", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("resolves with the clicked button and checkbox", async () => {
    render(<PromptOverlay />);
    let result: Promise<{ button: string; checked: boolean }> | undefined;
    act(() => {
      result = ask({
        title: "Exit?",
        body: "Sure?",
        buttons: [{ id: "exit", label: "Exit", primary: true }],
        checkbox: "Don't ask",
      });
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Exit" }));
    await expect(result).resolves.toEqual({ button: "exit", checked: true });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Escape cancels", async () => {
    render(<PromptOverlay />);
    let result: Promise<{ button: string }> | undefined;
    act(() => {
      result = ask({ title: "Q", body: "B", buttons: [{ id: "ok", label: "OK" }] });
    });
    await screen.findByRole("dialog");
    await userEvent.setup().keyboard("{Escape}");
    await expect(result).resolves.toMatchObject({ button: "cancel" });
  });

  it("orders buttons like macOS IDEA, adds one Cancel, and Enter picks the default", async () => {
    const os = usePlatform.getState().os;
    usePlatform.setState({ os: "macos" });
    render(<PromptOverlay />);
    let result: Promise<{ button: string }> | undefined;
    act(() => {
      result = ask({
        title: "Open Project",
        body: "Where?",
        buttons: [
          { id: "same", label: "This Window" },
          { id: "new", label: "New Window", primary: true },
          { id: "cancel", label: "Cancel" },
        ],
      });
    });
    const dialog = await screen.findByRole("dialog");
    const footer = dialog.querySelector("[data-dialog-footer]") as HTMLElement;
    expect([...footer.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Cancel",
      "This Window",
      "New Window",
    ]);
    await userEvent.setup().keyboard("{Enter}");
    await expect(result).resolves.toMatchObject({ button: "new" });
    usePlatform.setState({ os });
  });
});
