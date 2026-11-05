import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncEntry } from "@/platform/ipc";
import { DEFAULT_DEPLOYMENT_SERVER } from "@/platform/remoteSettings";

const mocks = vi.hoisted(() => ({ remote: vi.fn(), probe: vi.fn(), text: vi.fn(), range: vi.fn() }));
vi.mock("@/platform/ipc", () => ({
  call: (value: unknown) => value,
  commands: { remoteOpen: mocks.remote, fsProbe: mocks.probe, fsReadText: mocks.text, fsReadRange: mocks.range },
}));
vi.mock("./ssh", () => ({ withSsh: (_: unknown, run: () => unknown) => run() }));
import { createDeploymentComparison } from "./comparison";

const server = { ...DEFAULT_DEPLOYMENT_SERVER, id: "s1", name: "Staging", sshConfig: "ssh" };
const entry = (patch: Partial<SyncEntry> = {}): SyncEntry => ({
  path: "src/a.php",
  remotePath: "/srv/app/src/a.php",
  status: "same",
  local: { size: 4, mtime: 1 },
  remote: { size: 4, mtime: 1 },
  ...patch,
});
const signal = () => new AbortController().signal;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.remote.mockResolvedValue("/cache/a.php");
  mocks.probe.mockResolvedValue({ size: 4, binary: false, tooLarge: false });
  mocks.text.mockResolvedValue("old\n");
  mocks.range.mockResolvedValue({ total: 4, data: "b2xkCg==" });
});

describe("deployment content snapshots", () => {
  it("keeps the local document live and the remote side immutable, sharing one downloaded snapshot", async () => {
    const compare = createDeploymentComparison(server, "/work/app/");
    expect(await compare.preview(entry(), signal())).toMatchObject({
      kind: "text",
      data: {
        path: "/work/app/src/a.php",
        left: { type: "file", path: "/work/app/src/a.php" },
        right: { type: "text", text: "old\n", label: "Staging: /srv/app/src/a.php" },
      },
    });
    expect(mocks.remote).toHaveBeenCalledWith({ kind: "sftp", ssh: "ssh" }, "/srv/app/src/a.php");
    expect(mocks.text).toHaveBeenCalledWith("/cache/a.php");
    await compare.equal(entry(), signal());
    expect(mocks.remote).toHaveBeenCalledTimes(1);
  });
  it("represents missing sides without reading missing files", async () => {
    const compare = createDeploymentComparison(server, "/work/app");
    expect(await compare.preview(entry({ remote: null }), signal())).toMatchObject({
      data: { right: { type: "text", text: "", label: expect.stringContaining("does not exist") } },
    });
    expect(mocks.remote).not.toHaveBeenCalled();
    expect(mocks.text).not.toHaveBeenCalled();
    mocks.probe.mockClear();
    expect(await compare.preview(entry({ local: null }), signal())).toMatchObject({
      data: { left: { type: "text", text: "" }, right: { text: "old\n" } },
    });
    expect(mocks.probe).toHaveBeenCalledExactlyOnceWith("/cache/a.php");
  });
  it("does not decode binaries or download oversized text previews", async () => {
    const compare = createDeploymentComparison(server, "/work/app");
    expect(await compare.preview(entry({ local: { size: 20_000_000, mtime: 1 } }), signal())).toEqual({
      kind: "tooLarge",
    });
    expect(mocks.remote).not.toHaveBeenCalled();
    mocks.probe.mockResolvedValue({ size: 4, binary: true });
    expect(await compare.preview(entry(), signal())).toEqual({ kind: "binary" });
    expect(mocks.text).not.toHaveBeenCalled();
  });
  it("compares bytes even when size and timestamps match", async () => {
    const compare = createDeploymentComparison(server, "/work/app");
    mocks.range.mockImplementation(async (path: string) => ({
      total: 4,
      data: path.startsWith("/work") ? "bmV3Cg==" : "b2xkCg==",
    }));
    expect(await compare.equal(entry(), signal())).toBe(false);
    mocks.range.mockResolvedValue({ total: 4, data: "b2xkCg==" });
    expect(await compare.equal(entry({ remote: { size: 4, mtime: 99 } }), signal())).toBe(true);
  });
  it("uses bounded reads and stops at the first differing block", async () => {
    const compare = createDeploymentComparison(server, "/work/app");
    const large = entry({ local: { size: 150_000, mtime: 1 }, remote: { size: 150_000, mtime: 1 } });
    mocks.range.mockImplementation(async (path: string, offset: number) => ({
      total: 150_000,
      data: offset >= 65_536 ? path : "same",
    }));
    expect(await compare.equal(large, signal())).toBe(false);
    expect(mocks.range).toHaveBeenCalledTimes(4);
    expect(mocks.range.mock.calls.every(([, , len]) => len === 65_536)).toBe(true);
  });
  it("detects changed sizes during comparison and handles empty files", async () => {
    const compare = createDeploymentComparison(server, "/work/app");
    mocks.range.mockResolvedValue({ total: 5, data: "changed" });
    await expect(compare.equal(entry(), signal())).rejects.toThrow("changed during comparison");
    mocks.range.mockResolvedValue({ total: 0, data: "" });
    expect(await compare.equal(entry({ local: { size: 0, mtime: 1 }, remote: { size: 0, mtime: 1 } }), signal())).toBe(
      true,
    );
    mocks.remote.mockClear();
    expect(await compare.equal(entry({ remote: { size: 8, mtime: 1 } }), signal())).toBe(false);
    expect(mocks.remote).not.toHaveBeenCalled();
  });
  it("does not continue after selection is cancelled and retries failed downloads", async () => {
    const compare = createDeploymentComparison(server, "/work/app");
    const abort = new AbortController();
    mocks.remote.mockImplementationOnce(async () => {
      abort.abort();
      return "/cache/a.php";
    });
    await expect(compare.preview(entry(), abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.text).not.toHaveBeenCalled();
    const retry = createDeploymentComparison(server, "/work/app");
    mocks.remote.mockRejectedValueOnce(new Error("Offline"));
    await expect(retry.preview(entry(), signal())).rejects.toThrow("Offline");
    await expect(retry.preview(entry(), signal())).resolves.toMatchObject({ kind: "text" });
  });
});
