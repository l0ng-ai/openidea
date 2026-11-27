import { beforeEach, describe, expect, it } from "vitest";
import type { JsNetworkEvent } from "@/platform/ipc";
import { useDebug } from "../state";
import { applyNetworkEvents, useJsNetwork } from "../js/network";
import { watchNetworkSessions } from "../js/networkSessions";

type Sessions = ReturnType<typeof useDebug.getState>["sessions"];
function sessions(ids: number[]) {
  const out: Record<number, unknown> = {};
  for (const id of ids) out[id] = { id, name: `s${id}`, status: "running", caps: { jsPage: true } };
  useDebug.setState({ sessions: out as Sessions });
}

const request: JsNetworkEvent = {
  kind: "request",
  requestId: "1",
  timestampMs: 1,
  url: "http://h/a",
  method: "GET",
  resourceType: "Fetch",
  status: null,
  mimeType: null,
  headers: {},
  encodedLength: null,
  errorText: null,
  initiator: null,
};

beforeEach(() => {
  sessions([]);
  useJsNetwork.setState({ rows: {} });
});

describe("the requests of page sessions", () => {
  it("stay while the session is listed, finished or not", () => {
    const stop = watchNetworkSessions();
    sessions([1, 2]);
    applyNetworkEvents(1, [request]);
    sessions([1]);
    expect(useJsNetwork.getState().rows[1]).toHaveLength(1);
    stop();
  });

  it("are dropped when the session is removed", () => {
    const stop = watchNetworkSessions();
    sessions([1]);
    applyNetworkEvents(1, [request]);
    sessions([]);
    expect(1 in useJsNetwork.getState().rows).toBe(false);
    stop();
  });
});
