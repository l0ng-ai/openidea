import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { usePlatform } from "@/platform/platformInfo";
import { ConsoleModel } from "./console";
import { ConsoleView } from "./ConsoleView";

// Only the rows in `mounted` render, like a virtualized list before it catches up with a scroll.
const virtual = vi.hoisted(() => ({ mounted: new Set<number>() }));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 20,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, start: index * 20, size: 20, key: index })).filter((item) =>
        virtual.mounted.has(item.index),
      ),
    scrollToIndex: () => {},
    measureElement: () => {},
    measure: () => {},
  }),
}));

const SHORT = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
const WIDE = `${"x".repeat(3_000)} needle`;

beforeEach(() => {
  usePlatform.setState({ os: "macos" });
  virtual.mounted = new Set(Array.from({ length: 10 }, (_, i) => i));
});
afterEach(() => vi.restoreAllMocks());

describe("Run console find on a wide line", () => {
  it("scrolls the current match into view sideways once its row has rendered", () => {
    const reveal = vi.spyOn(Element.prototype, "scrollIntoView");
    const model = new ConsoleModel();
    model.append({ kind: "stdout", text: `${SHORT}\n${WIDE}\n${WIDE}\n` });
    const view = (version: number) => (
      <ConsoleView model={model} version={version} softWrap={false} follow={false} onFollowChange={() => {}} cwd="/" />
    );
    const { rerender } = render(view(1));
    fireEvent.keyDown(screen.getByRole("log"), { key: "f", code: "KeyF", metaKey: true });
    fireEvent.change(screen.getByRole("textbox", { name: "Find in console" }), { target: { value: "needle" } });
    expect(screen.getByText("1/2")).toBeInTheDocument();
    // The row of the match is not mounted yet: nothing to reveal.
    expect(reveal).not.toHaveBeenCalled();

    virtual.mounted = new Set([39, 40, 41]);
    rerender(view(1));
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(reveal).toHaveBeenLastCalledWith({ block: "nearest", inline: "nearest" });
    const target = reveal.mock.contexts[0] as Element;
    expect(target.textContent).toBe("needle");
    expect(target.closest("[data-index]")?.getAttribute("data-index")).toBe("40");

    // New output keeps the view where the user left it.
    model.append({ kind: "stdout", text: "more\n" });
    rerender(view(2));
    expect(reveal).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(screen.getByRole("search"), { key: "Enter" });
    expect(screen.getByText("2/2")).toBeInTheDocument();
    expect(reveal).toHaveBeenCalledTimes(2);
    expect((reveal.mock.contexts[1] as Element).closest("[data-index]")?.getAttribute("data-index")).toBe("41");
  });

  it("reveals the match again as typing grows it from the same start", () => {
    const reveal = vi.spyOn(Element.prototype, "scrollIntoView");
    const model = new ConsoleModel();
    model.append({ kind: "stdout", text: `${SHORT}\n${"x".repeat(3_000)} farneedle\n` });
    virtual.mounted = new Set([39, 40]);
    render(<ConsoleView model={model} version={1} softWrap={false} follow={false} onFollowChange={() => {}} cwd="/" />);
    fireEvent.keyDown(screen.getByRole("log"), { key: "f", code: "KeyF", metaKey: true });
    const input = screen.getByRole("textbox", { name: "Find in console" });
    fireEvent.change(input, { target: { value: "f" } });
    expect((reveal.mock.contexts.at(-1) as Element).textContent).toBe("f");
    const calls = reveal.mock.calls.length;
    fireEvent.change(input, { target: { value: "farneedle" } });
    expect(reveal.mock.calls.length).toBe(calls + 1);
    expect((reveal.mock.contexts.at(-1) as Element).textContent).toBe("farneedle");
  });

  it("does not reveal again when output grows the matched open line", () => {
    const reveal = vi.spyOn(Element.prototype, "scrollIntoView");
    const model = new ConsoleModel();
    model.append({ kind: "stdout", text: `${SHORT}\nDownloading...` });
    virtual.mounted = new Set([39, 40]);
    const view = (version: number) => (
      <ConsoleView model={model} version={version} softWrap={false} follow={false} onFollowChange={() => {}} cwd="/" />
    );
    const { rerender } = render(view(1));
    fireEvent.keyDown(screen.getByRole("log"), { key: "f", code: "KeyF", metaKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Regex" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Find in console" }), { target: { value: "Downloading.*" } });
    expect(reveal).toHaveBeenCalledTimes(1);
    model.append({ kind: "stdout", text: "...." });
    rerender(view(2));
    expect(screen.getByRole("log").querySelector("[data-find-current]")?.textContent).toBe("Downloading.......");
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it("does not turn Scroll to End back on when the reveal scrolls sideways", () => {
    vi.spyOn(Element.prototype, "scrollIntoView");
    const onFollowChange = vi.fn();
    const model = new ConsoleModel();
    model.append({ kind: "stdout", text: `${"x".repeat(3_000)} farneedle\n` });
    virtual.mounted = new Set([0]);
    render(
      <ConsoleView model={model} version={1} softWrap={false} follow={false} onFollowChange={onFollowChange} cwd="/" />,
    );
    const log = screen.getByRole("log");
    fireEvent.keyDown(log, { key: "f", code: "KeyF", metaKey: true });
    fireEvent.change(screen.getByRole("textbox", { name: "Find in console" }), { target: { value: "farneedle" } });
    onFollowChange.mockClear();
    // The output fits, so the console is at the end; only scrollLeft moved.
    fireEvent.scroll(log);
    expect(onFollowChange).not.toHaveBeenCalled();
    // A vertical scroll in the same frame still counts, as before.
    Object.defineProperty(log, "scrollTop", { get: () => 40, set: () => {}, configurable: true });
    fireEvent.scroll(log);
    expect(onFollowChange).toHaveBeenCalledWith(true);
  });

  it("reveals a match across the 8,000-character cut at its start, not at its continuation", () => {
    const reveal = vi.spyOn(Element.prototype, "scrollIntoView");
    const model = new ConsoleModel();
    model.append({ kind: "stdout", text: `${SHORT}\n${"x".repeat(7_997)}t3boundary${"z".repeat(300)}\n` });
    model.flush();
    // A fresh element each time: React skips re-rendering an identical one.
    const view = () => (
      <ConsoleView model={model} version={1} softWrap={false} follow={false} onFollowChange={() => {}} cwd="/" />
    );
    const { rerender } = render(view());
    fireEvent.keyDown(screen.getByRole("log"), { key: "f", code: "KeyF", metaKey: true });
    fireEvent.change(screen.getByRole("textbox", { name: "Find in console" }), { target: { value: "t3boundary" } });
    virtual.mounted = new Set([41]);
    rerender(view());
    expect(reveal).not.toHaveBeenCalled();
    virtual.mounted = new Set([40, 41]);
    rerender(view());
    expect(reveal).toHaveBeenCalledTimes(1);
    expect((reveal.mock.contexts[0] as Element).closest("[data-index]")?.getAttribute("data-index")).toBe("40");
  });
});
