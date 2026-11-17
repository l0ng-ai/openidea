import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { IdeEvent } from "@/bindings";
import { emitLocalIdeEvent, ideEventsReady, onIdeEvent } from "./ipc";

type Listener = (e: { payload: IdeEvent }) => void;
const backend = vi.hoisted(() => ({ listener: null as Listener | null }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    listen: (_event: string, listener: Listener) => {
      backend.listener = listener;
      return Promise.resolve(() => {});
    },
  }),
}));

const event = { type: "fsChanged", paths: ["/p/a.ts"] } as unknown as IdeEvent;

describe("IDE event dispatch", () => {
  const offs: (() => void)[] = [];
  beforeAll(async () => {
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    await ideEventsReady();
  });
  afterEach(() => {
    offs.splice(0).forEach((off) => off());
    vi.restoreAllMocks();
  });

  const fromBackend = (e: IdeEvent) => backend.listener!({ payload: e });

  it.each([
    ["from the backend", fromBackend],
    ["emitted locally", emitLocalIdeEvent],
  ])("keeps notifying handlers after one throws (%s)", (_name, emit) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls: string[] = [];
    offs.push(
      onIdeEvent("fsChanged", () => {
        calls.push("first");
        throw new Error("boom");
      }),
      onIdeEvent("fsChanged", () => calls.push("second")),
      onIdeEvent("*", () => {
        calls.push("any");
        throw new Error("boom");
      }),
      onIdeEvent("*", () => calls.push("any second")),
    );
    emit(event);
    expect(calls).toEqual(["first", "second", "any", "any second"]);
    expect(error).toHaveBeenCalledTimes(2);
  });

  it("unsubscribes one subscription of a handler registered twice", () => {
    const handler = vi.fn();
    const off = onIdeEvent("fsChanged", handler);
    offs.push(onIdeEvent("fsChanged", handler));
    off();
    emitLocalIdeEvent(event);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
