import { beforeEach, describe, expect, it } from "vitest";
import type { JsNetworkEvent } from "@/platform/ipc";
import {
  applyNetworkEvents,
  clearNetwork,
  filterRows,
  forgetNetwork,
  MAX_ROWS,
  rowCategory,
  rowName,
  useJsNetwork,
} from "../js/network";

const base: JsNetworkEvent = {
  kind: "request",
  requestId: "1",
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
};
const request = (requestId: string, url: string, timestampMs = 1000): JsNetworkEvent => ({
  ...base,
  requestId,
  url,
  method: "GET",
  resourceType: "Fetch",
  timestampMs,
  headers: { Accept: "*/*" },
});
const response = (requestId: string, status = 200): JsNetworkEvent => ({
  ...base,
  kind: "response",
  requestId,
  status,
  mimeType: "application/json",
  resourceType: "Fetch",
  timestampMs: 1040,
  headers: { "Content-Type": "application/json" },
});
const finished = (requestId: string, timestampMs = 1250): JsNetworkEvent => ({
  ...base,
  kind: "finished",
  requestId,
  timestampMs,
  encodedLength: 1234,
});
const rows = (session = 1) => useJsNetwork.getState().rows[session] ?? [];

beforeEach(() => useJsNetwork.setState({ rows: {} }));

describe("network rows of a debugged page", () => {
  it("folds the events of one request into a row", () => {
    applyNetworkEvents(1, [request("1", "http://h/api/items"), response("1"), finished("1")]);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      requestId: "1",
      url: "http://h/api/items",
      name: "items",
      method: "GET",
      type: "Fetch",
      status: 200,
      mimeType: "application/json",
      size: 1234,
      durationMs: 250,
      error: null,
      requestHeaders: { Accept: "*/*" },
      responseHeaders: { "Content-Type": "application/json" },
    });
  });

  it("a failed request keeps its error", () => {
    applyNetworkEvents(1, [
      request("2", "http://h/gone"),
      { ...base, kind: "failed", requestId: "2", timestampMs: 1100, errorText: "net::ERR_FAILED" },
    ]);
    expect(rows()[0]).toMatchObject({ status: null, error: "net::ERR_FAILED", durationMs: 100 });
  });

  it("a reused request id after completion starts a new row", () => {
    applyNetworkEvents(1, [request("1", "http://h/a"), finished("1")]);
    applyNetworkEvents(1, [request("1", "http://h/b", 5000), response("1", 404)]);
    expect(rows().map((r) => [r.url, r.status, r.size])).toEqual([
      ["http://h/a", null, 1234],
      ["http://h/b", 404, null],
    ]);
    expect(new Set(rows().map((r) => r.key)).size).toBe(2);
  });

  it("events without a request are dropped", () => {
    applyNetworkEvents(1, [response("9"), finished("9")]);
    expect(rows()).toEqual([]);
  });

  it("keeps the newest rows of each session apart, up to the limit", () => {
    const many = Array.from({ length: MAX_ROWS + 1 }, (_, i) => request(`r${i}`, `http://h/${i}`));
    applyNetworkEvents(1, many);
    applyNetworkEvents(2, [request("x", "http://h/other")]);
    expect(MAX_ROWS).toBe(2000);
    expect(rows(1)).toHaveLength(MAX_ROWS);
    expect(rows(1)[0]!.url).toBe("http://h/1");
    expect(rows(2)).toHaveLength(1);
  });

  it("filters by a part of the URL, ignoring case", () => {
    applyNetworkEvents(1, [request("1", "http://h/api/Items"), request("2", "http://h/logo.png")]);
    expect(filterRows(rows(), "ITEMS").map((r) => r.requestId)).toEqual(["1"]);
    expect(filterRows(rows(), "  ")).toHaveLength(2);
  });

  it("sorts resource types into the browser's filter groups", () => {
    expect(["Fetch", "XHR"].map(rowCategory)).toEqual(["fetch", "fetch"]);
    expect(["Document", "Script", "Stylesheet", "Image", "Font"].map(rowCategory)).toEqual([
      "doc",
      "js",
      "css",
      "img",
      "font",
    ]);
    expect(["WebSocket", "Media", "Other", ""].map(rowCategory)).toEqual(["other", "other", "other", "other"]);
  });

  it("filters by group, and by who made the request", () => {
    const from = (url: string) => ({ function: "load", url, line: 1, column: 1 });
    applyNetworkEvents(1, [
      { ...request("1", "http://h/api/items"), initiator: from("http://h/src/App.vue") },
      { ...request("2", "http://h/api/track"), initiator: from("http://h/node_modules/.vite/deps/analytics.js") },
      { ...request("3", "http://h/src/main.ts"), resourceType: "Script" },
    ]);
    const ids = (rows: ReturnType<typeof filterRows>) => rows.map((r) => r.requestId);
    expect(ids(filterRows(rows(), "", "fetch"))).toEqual(["1", "2"]);
    expect(ids(filterRows(rows(), "", "js"))).toEqual(["3"]);
    expect(ids(filterRows(rows(), "track", "fetch"))).toEqual(["2"]);
    // Only what the project's own code asked for: not a library's request, not a tag in the page.
    expect(ids(filterRows(rows(), "", "all", true))).toEqual(["1"]);
    expect(ids(filterRows(rows(), "", "js", true))).toEqual([]);
  });

  it("names a row after the end of its path", () => {
    expect(rowName("http://h/a/b.js?v=1")).toBe("b.js?v=1");
    expect(rowName("http://h:5173/")).toBe("h:5173");
    expect(rowName("http://h/dir/")).toBe("dir/");
    expect(rowName("data:text/plain,hi")).toBe("data:text/plain,hi");
  });

  it("clears and forgets a session's rows", () => {
    applyNetworkEvents(1, [request("1", "http://h/a")]);
    clearNetwork(1);
    expect(useJsNetwork.getState().rows[1]).toEqual([]);
    forgetNetwork(1);
    expect(1 in useJsNetwork.getState().rows).toBe(false);
  });
});
