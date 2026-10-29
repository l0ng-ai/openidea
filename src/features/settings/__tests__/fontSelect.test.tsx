import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { FontFamily } from "@/platform/ipc";

const installed: FontFamily[] = [
  { name: "Andale Mono", monospaced: true },
  { name: "Arial", monospaced: false },
  { name: "Courier New", monospaced: true },
  { name: "Georgia", monospaced: false },
  { name: "Helvetica Neue", monospaced: false },
  { name: "Maple Mono NF CN", monospaced: true },
  { name: "Menlo", monospaced: true },
  { name: "Monaco", monospaced: true },
  { name: "PingFang SC", monospaced: false },
  { name: "Sarasa Term SC", monospaced: true },
];
const systemFontFamilies = vi.fn(async () => ({ status: "ok" as const, data: installed }));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...real, commands: { ...real.commands, systemFontFamilies: () => systemFontFamilies() } };
});

import { resetSystemFontsForTests } from "@/platform/systemFonts";
import { FontSelect } from "../components/FontSelect";

afterEach(() => resetSystemFontsForTests());

async function open(ui: React.ReactElement, label: string) {
  render(ui);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: label }));
  return screen.getAllByRole("option").map((o) => o.textContent);
}

describe("FontSelect", () => {
  it("lists every installed family plus the bundled one, sorted", async () => {
    const names = await open(<FontSelect value="Menlo" onChange={() => {}} aria-label="Font" />, "Font");
    expect(names).toEqual([
      "Andale Mono",
      "Arial",
      "Courier New",
      "Georgia",
      "Helvetica Neue",
      "JetBrains Mono",
      "Maple Mono NF CN",
      "Menlo",
      "Monaco",
      "PingFang SC",
      "Sarasa Term SC",
    ]);
  });

  it("filters to monospaced families when asked, keeping the current one", async () => {
    const names = await open(
      <FontSelect value="PingFang SC" onChange={() => {}} monospacedOnly aria-label="Font" />,
      "Font",
    );
    expect(names).toEqual([
      "Andale Mono",
      "Courier New",
      "JetBrains Mono",
      "Maple Mono NF CN",
      "Menlo",
      "Monaco",
      "PingFang SC",
      "Sarasa Term SC",
    ]);
  });

  it("keeps a current family that isn't installed here", async () => {
    render(<FontSelect value="Fira Code" onChange={() => {}} monospacedOnly aria-label="Font" />);
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Font" })).toHaveTextContent("Fira Code");
  });

  it("offers None first for fallback fonts, without the bundled family", async () => {
    const names = await open(
      <FontSelect value="" onChange={() => {}} none aria-label="Fallback font" />,
      "Fallback font",
    );
    expect(names[0]).toBe("None");
    expect(names).not.toContain("JetBrains Mono");
    expect(names).toHaveLength(installed.length + 1);
  });

  it("jumps to the family typed as a prefix", async () => {
    const onChange = vi.fn();
    await open(<FontSelect value="Arial" onChange={onChange} aria-label="Font" />, "Font");
    const popup = document.querySelector("[data-autofocus]")!;
    fireEvent.keyDown(popup, { key: "m", timeStamp: 1000 });
    fireEvent.keyDown(popup, { key: "e", timeStamp: 1100 });
    fireEvent.keyDown(popup, { key: "Enter", timeStamp: 1200 });
    expect(onChange).toHaveBeenCalledWith("Menlo");
  });

  it("reads the font list once", async () => {
    systemFontFamilies.mockClear();
    render(
      <>
        <FontSelect value="Menlo" onChange={() => {}} aria-label="A" />
        <FontSelect value="Menlo" onChange={() => {}} aria-label="B" />
      </>,
    );
    await act(async () => {});
    expect(systemFontFamilies).toHaveBeenCalledTimes(1);
  });
});
