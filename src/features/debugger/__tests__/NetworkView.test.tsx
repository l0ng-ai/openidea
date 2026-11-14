import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { JsNetworkEvent, JsResponseBody } from "@/platform/ipc";

const asked: Array<[number, string]> = [];
const evaluated: unknown[][] = [];
let answer: { status: "ok"; data: JsResponseBody } | { status: "error"; error: { kind: string; message: string } };
vi.mock("@/platform/ipc", async (orig) => {
  const real = await orig<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      debugJsResponseBody: (session: number, requestId: string) => {
        asked.push([session, requestId]);
        return Promise.resolve(answer);
      },
      debugEvaluateIn: (...args: unknown[]) => {
        evaluated.push(args);
        return Promise.resolve({ status: "ok", data: { value: "", variablesReference: 0 } });
      },
    },
  };
});

const { applyNetworkEvents, useJsNetwork } = await import("../js/network");
const { NetworkView } = await import("../js/NetworkView");
const { useJsBreakpoints } = await import("../js/eventBreakpoints");
const { setRefused } = await import("../js/refusals");
const { handleDebugEvent, useDebug } = await import("../state");

const event = (kind: JsNetworkEvent["kind"], requestId: string, p: Partial<JsNetworkEvent> = {}): JsNetworkEvent => ({
  kind,
  requestId,
  timestampMs: 1000,
  url: null,
  method: null,
  resourceType: null,
  status: null,
  mimeType: null,
  headers: {},
  encodedLength: null,
  errorText: null,
  initiator: null,
  ...p,
});

function load() {
  applyNetworkEvents(7, [
    event("request", "1", {
      url: "http://h/api/items",
      method: "GET",
      resourceType: "Fetch",
      headers: { Accept: "*/*" },
    }),
    event("response", "1", {
      status: 200,
      mimeType: "application/json",
      headers: { "Content-Type": "application/json" },
    }),
    event("finished", "1", { timestampMs: 1250, encodedLength: 2048 }),
    event("request", "2", { url: "http://h/logo.png", method: "GET", resourceType: "Image" }),
    event("request", "3", { url: "http://h/gone", method: "POST", resourceType: "XHR" }),
    event("failed", "3", { timestampMs: 1100, errorText: "net::ERR_FAILED" }),
  ]);
}

beforeEach(() => {
  useJsNetwork.setState({ rows: {} });
  asked.length = 0;
  evaluated.length = 0;
  answer = { status: "ok", data: { body: '{"items":[]}', base64Encoded: false, truncated: false } };
});

describe("Network view", () => {
  it("lists a session's requests with status, type, size and time", () => {
    load();
    render(<NetworkView session={7} />);
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("items");
    expect(rows[0]).toHaveTextContent("200");
    expect(rows[0]).toHaveTextContent("Fetch");
    expect(rows[0]).toHaveTextContent("2.0 kB");
    expect(rows[0]).toHaveTextContent("250 ms");
    expect(rows[2]).toHaveTextContent("net::ERR_FAILED");
  });

  it("filters by a part of the URL", () => {
    load();
    render(<NetworkView session={7} />);
    fireEvent.change(screen.getByLabelText("Filter requests"), { target: { value: "logo" } });
    expect(screen.getAllByRole("row").slice(1)).toHaveLength(1);
  });

  it("shows a selected request's headers and loads its body", async () => {
    load();
    render(<NetworkView session={7} />);
    fireEvent.click(screen.getAllByRole("row")[1]!);
    expect(screen.getByText("http://h/api/items")).toBeInTheDocument();
    expect(screen.getByText("Accept")).toBeInTheDocument();
    expect(screen.getByText("Content-Type")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('{"items":[]}')).toBeInTheDocument());
    expect(asked).toEqual([[7, "1"]]);
  });

  it("says so when a body is binary, cut or gone", async () => {
    load();
    answer = { status: "ok", data: { body: "AAEC", base64Encoded: true, truncated: false } };
    const { unmount } = render(<NetworkView session={7} />);
    fireEvent.click(screen.getAllByRole("row")[1]!);
    await waitFor(() => expect(screen.getByText("Binary content")).toBeInTheDocument());
    expect(screen.queryByText("AAEC")).toBeNull();
    unmount();

    answer = { status: "ok", data: { body: "abc", base64Encoded: false, truncated: true } };
    const second = render(<NetworkView session={7} />);
    fireEvent.click(screen.getAllByRole("row")[1]!);
    await waitFor(() => expect(screen.getByText("Showing the first 1 MB")).toBeInTheDocument());
    second.unmount();

    // The session ended, or the browser dropped the response.
    answer = { status: "error", error: { kind: "unavailable", message: "gone" } };
    render(<NetworkView session={7} />);
    fireEvent.click(screen.getAllByRole("row")[1]!);
    await waitFor(() => expect(screen.getByText("Response body is no longer available")).toBeInTheDocument());
  });

  it("clears the list", () => {
    load();
    render(<NetworkView session={7} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryAllByRole("row").slice(1)).toHaveLength(0);
    expect(screen.getByText(/^No requests yet/)).toBeInTheDocument();
  });

  it("filters by the kind of resource, like a browser's network panel", () => {
    load();
    render(<NetworkView session={7} />);
    fireEvent.click(screen.getByRole("button", { name: "Fetch/XHR" }));
    expect(screen.getByRole("button", { name: "Fetch/XHR" })).toHaveAttribute("aria-pressed", "true");
    const shown = screen.getAllByRole("row").slice(1);
    expect(shown).toHaveLength(2);
    expect(shown[0]).toHaveTextContent("items");
    expect(shown[1]).toHaveTextContent("gone");
    fireEvent.click(screen.getByRole("button", { name: "Img" }));
    expect(screen.getAllByRole("row").slice(1)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getAllByRole("row").slice(1)).toHaveLength(3);
  });

  it("can show only what the project's own code requested", () => {
    applyNetworkEvents(7, [
      event("request", "1", {
        url: "http://h/api/items",
        resourceType: "Fetch",
        initiator: { function: "load", url: "http://h/src/App.vue", line: 9, column: 2 },
      }),
      event("request", "2", {
        url: "http://h/api/track",
        resourceType: "Fetch",
        initiator: { function: "send", url: "http://h/node_modules/.vite/deps/analytics.js", line: 1, column: 1 },
      }),
    ]);
    render(<NetworkView session={7} />);
    fireEvent.click(screen.getByLabelText("My code only"));
    const shown = screen.getAllByRole("row").slice(1);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toHaveTextContent("items");
  });

  it("turns a request into a breakpoint on the next one to that address", () => {
    useJsBreakpoints.setState({ root: null, events: {}, requests: [] });
    load();
    render(<NetworkView session={7} />);
    fireEvent.click(screen.getAllByRole("row")[1]!);
    fireEvent.click(screen.getByRole("button", { name: "Break on Next Request" }));
    expect(useJsBreakpoints.getState().requests).toEqual([{ pattern: "/api/items", enabled: true }]);
  });

  it("reloads the page, to list the requests of its load", () => {
    render(<NetworkView session={7} />);
    // Recording starts while the page is already loading.
    expect(screen.getByText("No requests yet. Reload the page to see the requests of its load.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reload Page" }));
    expect(evaluated).toEqual([[7, null, "location.reload()", "repl"]]);
  });

  it("says that requests are not reported instead of waiting for them", () => {
    render(<NetworkView session={7} />);
    expect(screen.getByText(/^No requests yet/)).toBeInTheDocument();
    const page = { id: 7, name: "page", status: "running", caps: { jsPage: true } };
    useDebug.setState({ sessions: { 7: page } as unknown as ReturnType<typeof useDebug.getState>["sessions"] });
    act(() => handleDebugEvent(7, { kind: "jsNetworkUnavailable" }));
    expect(
      screen.getByText("This version of the JavaScript debugger does not report a page's requests."),
    ).toBeInTheDocument();
    setRefused(7, "network", null);
  });
});
