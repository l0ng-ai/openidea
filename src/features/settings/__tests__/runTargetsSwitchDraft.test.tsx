import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, isTauri: () => false };
});

const { PageContext } = await import("../components/context");
const { RunTargetsEditor } = await import("../pages/RunTargetsBody");
const { useSettingsDialog } = await import("../model/staging");
const { DEFAULT_SETTINGS } = await import("../model/schema");
const { DEFAULT_RUN_TARGET } = await import("@/platform/remoteSettings");

const TARGETS = [
  { ...DEFAULT_RUN_TARGET, kind: "compose" as const, id: "odoo110", name: "odoo110", ports: ["8069:8069"] },
  { ...DEFAULT_RUN_TARGET, kind: "compose" as const, id: "odoo170", name: "odoo170", ports: ["9000:9000"] },
];

function mount() {
  const settings = structuredClone(DEFAULT_SETTINGS) as typeof DEFAULT_SETTINGS & Record<string, unknown>;
  settings.runTargets = TARGETS;
  useSettingsDialog.setState({
    base: structuredClone(settings),
    globalBase: settings,
    staged: {},
    query: "",
  });
  render(
    <PageContext.Provider value={{ pageId: "build.runTargets", scope: "global" }}>
      <RunTargetsEditor />
    </PageContext.Provider>,
  );
}

const portsBox = () => screen.getByRole("textbox", { name: "Published ports" }) as HTMLInputElement;

beforeEach(() => {
  Object.assign(window, { __TAURI_INTERNALS__: { transformCallback: () => 1 } });
});
afterEach(() => {
  cleanup();
});

describe("Run Targets detail form", () => {
  it("does not commit an uncommitted ports edit to the target selected while it is open", () => {
    mount();
    // An edit to odoo110's published ports that ListField has not committed yet.
    fireEvent.change(portsBox(), { target: { value: "8069" } });
    // Selecting another target switches selection on mousedown, before the blur commits.
    fireEvent.mouseDown(screen.getByRole("option", { name: /odoo170/ }));
    fireEvent.blur(portsBox());
    // odoo170 keeps its own ports; the uncommitted draft is not written over them.
    expect(portsBox().value).toBe("9000:9000");
    // And odoo110 still holds what it held before the edit was committed anywhere.
    fireEvent.mouseDown(screen.getByRole("option", { name: /odoo110/ }));
    expect(portsBox().value).toBe("8069:8069");
  });
});
