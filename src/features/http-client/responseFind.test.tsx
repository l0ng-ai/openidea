import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpExchange } from "@/platform/ipc";

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
    body: "alpha beta\nbeta gamma\nBeta",
    size: 26,
    truncated: false,
    ttfbMs: 1,
    totalMs: 5,
  },
};

describe("HTTP response find", () => {
  afterEach(() => useHttpClient.setState({ history: [], exchanges: {}, selected: null }));

  it("opens a find bar with ⌘F in the response and marks the matches", () => {
    Element.prototype.scrollIntoView ??= () => {};
    useHttpClient.setState({ history: [exchange.entry], exchanges: { e1: exchange }, selected: "e1" });
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
});
