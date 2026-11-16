import { describe, expect, it, vi } from "vitest";

const cancelRequest = vi.fn(async (_id: number) => ({ status: "ok", data: null }));
vi.mock("@/platform/ipc", async (original) => {
  const ipc = await original<typeof import("@/platform/ipc")>();
  return { ...ipc, commands: { ...ipc.commands, cancelRequest } };
});

const { cancellable } = await import("./signature");
const { isCancelled } = await import("@/platform/ipc");

describe("cancellable refactoring requests", () => {
  it("cancels the request in flight when the dialog closes", async () => {
    const run = new AbortController();
    let sent = -1;
    let answer!: (v: string) => void;
    const reply = cancellable(run.signal, (id) => {
      sent = id;
      return new Promise<string>((r) => (answer = r));
    });
    run.abort();
    expect(cancelRequest).toHaveBeenCalledWith(sent);
    answer("late");
    await expect(reply).resolves.toBe("late");
  });

  it("leaves a request alone once it answered", async () => {
    cancelRequest.mockClear();
    const run = new AbortController();
    await cancellable(run.signal, async () => "done");
    run.abort();
    expect(cancelRequest).not.toHaveBeenCalled();
  });

  it("never sends a request the dialog closed before", async () => {
    const run = new AbortController();
    run.abort();
    const send = vi.fn(async () => "sent");
    const err = await cancellable(run.signal, send).catch((e: unknown) => e);
    expect(isCancelled(err)).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("tells the sender once the dialog closed after the request was handed over", async () => {
    const run = new AbortController();
    let wanted!: () => boolean;
    const reply = cancellable(run.signal, async (_id, w) => {
      wanted = w;
      return "sent";
    });
    expect(wanted()).toBe(true);
    run.abort();
    expect(wanted()).toBe(false);
    await reply;
  });
});
