import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Commit } from "@/bindings";
const api = vi.hoisted(() => ({ batch: vi.fn(), cancel: vi.fn() }));
vi.mock("@/platform/ipc", async (original) => {
  const real = await original<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsLogDetailsBatch: (...args: unknown[]) => api.batch(...args),
      cancelRequest: (...args: unknown[]) => api.cancel(...args),
    },
  };
});
import { loadLogDetails } from "../logDetails";
import { useVcs } from "../store";
import { useGitLog } from "../logStore";
const commit = (id: string): Commit => ({
  id,
  shortId: id,
  parents: [],
  refs: [],
  author: "A",
  email: "a@x",
  summary: id,
  message: id,
  timeMs: 0,
});
beforeEach(() => {
  api.batch.mockReset().mockImplementation(async (_repo: string, ids: string[]) => ({
    status: "ok",
    data: ids.map((id) => ({
      message: id,
      containingBranches: [],
      signature: "N",
      signer: "",
      key: "",
      fingerprint: "",
    })),
  }));
  api.cancel.mockReset().mockResolvedValue(undefined);
  useVcs.setState((s) => ({ repo: "/repo", root: "/repo", version: s.version + 1 }));
});
describe("commit detail jobs", () => {
  it("retries immediately after the last consumer cancels without losing the replacement cache entry", async () => {
    let rejectOld!: (error: Error) => void;
    api.batch.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectOld = reject;
        }),
    );
    const controller = new AbortController();
    const old = loadLogDetails(commit("retry-cancelled"), controller.signal).catch((error: unknown) => error);
    await vi.waitFor(() => expect(api.batch).toHaveBeenCalledTimes(1));
    controller.abort();
    const replacement = loadLogDetails(commit("retry-cancelled"));
    await vi.waitFor(() => expect(api.batch).toHaveBeenCalledTimes(2));
    await expect(replacement).resolves.toMatchObject({ message: "retry-cancelled" });
    rejectOld(new Error("Cancelled"));
    await old;
    await loadLogDetails(commit("retry-cancelled"));
    expect(api.batch).toHaveBeenCalledTimes(2);
  });
  it("batches rows and reuses results across log generations", async () => {
    const [a, b] = await Promise.all([loadLogDetails(commit("batch-a")), loadLogDetails(commit("batch-b"))]);
    expect([a.message, b.message]).toEqual(["batch-a", "batch-b"]);
    expect(api.batch).toHaveBeenCalledTimes(1);
    expect(api.batch.mock.calls[0]![1]).toEqual(["batch-a", "batch-b"]);
    useGitLog.setState((s) => ({ generation: s.generation + 1 }));
    await loadLogDetails(commit("batch-a"));
    expect(api.batch).toHaveBeenCalledTimes(1);
  });
  it("cancels running native work only when its last consumer leaves", async () => {
    let finish!: (value: unknown) => void;
    api.batch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const a = new AbortController(),
      b = new AbortController();
    const first = loadLogDetails(commit("shared"), a.signal);
    const second = loadLogDetails(commit("shared"), b.signal);
    await vi.waitFor(() => expect(api.batch).toHaveBeenCalledTimes(1));
    a.abort();
    expect(api.cancel).not.toHaveBeenCalled();
    b.abort();
    expect(api.cancel).toHaveBeenCalledWith(api.batch.mock.calls[0]![2]);
    finish({ status: "ok", data: [{ message: "shared" }] });
    await Promise.all([first, second]);
  });
});
