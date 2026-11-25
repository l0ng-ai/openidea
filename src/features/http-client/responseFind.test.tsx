import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpExchange } from "@/platform/ipc";
import { registerAction } from "@/platform/actions";
import { installKeyboardDispatcher, useKeymap } from "@/platform/keymap";

vi.mock("./store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./store")>()),
  refreshHistory: vi.fn(async () => {}),
}));

const { useHttpClient } = await import("./store");
const { HttpClientView } = await import("./HttpClientView");

const exchange: HttpExchange = {
  entry: {
    id: "e1",
    timeMs: 0,
    name: null,
    method: "GET",
    url: "http://x/api",
    status: 200,
    totalMs: 5,
    file: null,
    error: null,
  },
  request: { name: null, method: "GET", url: "http://x/api", headers: [], body: null },
  response: {
    status: 200,
    statusText: "OK",
    version: "HTTP/1.1",
    headers: [["content-type", "text/plain"]],
    contentType: "text/plain",
    redirects: [],
    body: "alpha beta\nbeta gamma\nBeta",
    size: 26,
    truncated: false,
    ttfbMs: 1,
    totalMs: 5,
  },
};

describe("HTTP response find", () => {
  afterEach(() => useHttpClient.setState({ history: [], exchanges: [], selected: null }));

  it("opens a find bar with ⌘F in the response and marks the matches", () => {
    Element.prototype.scrollIntoView ??= () => {};
    useHttpClient.setState({ history: [exchange.entry], exchanges: [exchange], selected: "e1" });
    render(<HttpClientView />);
    const body = screen.getByLabelText("Response body");
    fireEvent.keyDown(body, { key: "f", metaKey: true, ctrlKey: true });
    const input = screen.getByLabelText("Find in response", { selector: "input" });
    act(() => {
      fireEvent.change(input, { target: { value: "beta" } });
    });
    const marks = body.querySelectorAll("mark");
    expect([...marks].map((m) => m.textContent)).toEqual(["beta", "beta", "Beta"]);
    expect(screen.getByText("1/3")).toBeTruthy();
    expect(body.textContent).toBe("alpha beta\nbeta gamma\nBeta");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("2/3")).toBeTruthy();
    expect(
      marks[1]!.hasAttribute("data-find-current") ||
        body.querySelectorAll("mark")[1]!.hasAttribute("data-find-current"),
    ).toBe(true);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByLabelText("Find in response", { selector: "input" })).toBeNull();
    expect(body.querySelectorAll("mark")).toHaveLength(0);
  });

  it("opens the find bar with ⌘F after the Raw / Formatted toggle was clicked", () => {
    Element.prototype.scrollIntoView ??= () => {};
    const json: HttpExchange = {
      ...exchange,
      response: { ...exchange.response!, contentType: "application/json", body: '{"a":[1,2]}' },
    };
    useHttpClient.setState({ history: [json.entry], exchanges: [json], selected: "e1" });
    // The tool window around the view is focusable, as in the app.
    render(
      <section tabIndex={-1} aria-label="Tool window">
        <HttpClientView />
      </section>,
    );
    const find = () => screen.queryByLabelText("Find in response", { selector: "input" });
    // Where the click leaves the focus: on the button (Chromium) …
    const toggle = screen.getByRole("button", { name: "Show Raw" });
    toggle.focus();
    fireEvent.click(toggle);
    fireEvent.keyDown(document.activeElement!, { key: "f", metaKey: true, ctrlKey: true });
    expect(find()).toBeTruthy();
    fireEvent.keyDown(find()!, { key: "Escape" });
    expect(find()).toBeNull();
    // … or on the tool window (WebKit does not focus a clicked button): the body takes it back.
    act(() => screen.getByRole("region", { name: "Tool window" }).focus());
    fireEvent.click(screen.getByRole("button", { name: "Show Formatted" }));
    expect(screen.getByLabelText("Response body").parentElement!.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "f", metaKey: true, ctrlKey: true });
    expect(find()).toBeTruthy();
  });

  it("keeps Escape and F3 in the find bar away from the IDE keymap", () => {
    Element.prototype.scrollIntoView ??= () => {};
    const keymap = useKeymap.getState();
    useKeymap.setState({ preset: "intellij-macos", overrides: {}, extensions: {} });
    const focusEditor = vi.fn();
    const bookmark = vi.fn();
    const disposers = [
      registerAction({ id: "toolwindow.focusEditor", title: "Focus Editor", run: focusEditor }),
      registerAction({ id: "navigate.toggleBookmark", title: "Toggle Bookmark", run: bookmark }),
      installKeyboardDispatcher(window),
    ];
    try {
      useHttpClient.setState({ history: [exchange.entry], exchanges: [exchange], selected: "e1" });
      render(<HttpClientView />);
      fireEvent.click(screen.getByRole("button", { name: /^Find/ }));
      const input = screen.getByLabelText("Find in response", { selector: "input" });
      act(() => {
        fireEvent.change(input, { target: { value: "beta" } });
      });
      expect(screen.getByText("1/3")).toBeTruthy();
      fireEvent.keyDown(input, { key: "F3", code: "F3" });
      expect(screen.getByText("2/3")).toBeTruthy();
      fireEvent.keyDown(input, { key: "Escape", code: "Escape" });
      expect(focusEditor).not.toHaveBeenCalled();
      expect(bookmark).not.toHaveBeenCalled();
      expect(screen.queryByLabelText("Find in response", { selector: "input" })).toBeNull();
      // Closed: the IDE keymap has Escape again.
      fireEvent.keyDown(screen.getByLabelText("Response body"), { key: "Escape", code: "Escape" });
      expect(focusEditor).toHaveBeenCalledTimes(1);
    } finally {
      disposers.reverse().forEach((d) => d());
      useKeymap.setState(keymap, true);
    }
  });
});
