import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/workbench/messages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/workbench/messages")>()),
  confirm: vi.fn(async () => true),
}));

import { executeAction } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { confirm } from "@/workbench/messages";
import * as databaseStore from "./store";
import { useDatabase } from "./store";
import { registerDatabaseTreeActions } from "./treeActions";

const sources = [
  { id: "a", name: "Alpha", driver: "postgres" as const },
  { id: "b", name: "Beta", driver: "mysql" as const },
];
const nodes = sources.map((source) => ({ kind: "source" as const, key: source.id, source }));

let dispose: () => void;

beforeEach(() => {
  setContext("projectOpen", true);
  useProject.setState({ project: { name: "p", root: "/p", trusted: true } as never });
  useDatabase.setState({
    loaded: true,
    sources,
    connected: new Set(),
    selectedNode: nodes[1]!,
    selectedNodes: nodes,
  });
  vi.mocked(confirm).mockResolvedValue(true);
  vi.spyOn(commands, "dbConnected").mockResolvedValue({ status: "ok", data: [] });
  dispose = registerDatabaseTreeActions();
});

afterEach(() => {
  dispose();
  vi.restoreAllMocks();
});

describe("batch data source actions", () => {
  it("removes every selected data source with one confirmation and one save", async () => {
    const save = vi.spyOn(commands, "dbSaveSources").mockResolvedValue({ status: "ok", data: null });
    vi.spyOn(commands, "dbSources").mockResolvedValue({ status: "ok", data: [] });

    act(() => void executeAction("db.drop"));
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());

    expect(confirm).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]![0]).toEqual([]);
    expect(useDatabase.getState().selectedNodes).toEqual([]);
    expect(useDatabase.getState().selectedNode).toBeNull();
  });

  it.each([1, 2])("disconnects %i connected source(s) before removal", async (count) => {
    const selection = nodes.slice(0, count);
    const ids = selection.map((node) => node.source.id!);
    useDatabase.setState({
      connected: new Set(ids),
      selectedNode: selection[0]!,
      selectedNodes: selection,
    });
    const disconnect = vi.spyOn(commands, "dbDisconnect").mockResolvedValue({ status: "ok", data: null });
    const save = vi.spyOn(commands, "dbSaveSources").mockResolvedValue({ status: "ok", data: null });
    vi.spyOn(commands, "dbSources").mockResolvedValue({ status: "ok", data: [] });

    act(() => void executeAction("db.drop"));
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());

    expect(disconnect.mock.calls).toEqual(ids.map((id) => [id, null]));
    expect(Math.max(...disconnect.mock.invocationCallOrder)).toBeLessThan(save.mock.invocationCallOrder[0]!);
  });

  it("deactivates only the selected sources that are connected", async () => {
    useDatabase.setState({ connected: new Set(["a", "a:other"]) });
    const disconnect = vi.spyOn(commands, "dbDisconnect").mockResolvedValue({ status: "ok", data: null });

    act(() => void executeAction("db.disconnect"));
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledTimes(2));

    expect(disconnect.mock.calls).toEqual([
      ["a", null],
      ["a:other", null],
    ]);
  });

  it("refreshes each selected data source independently", async () => {
    const refresh = vi.spyOn(databaseStore, "refresh").mockResolvedValue();
    act(() => void executeAction("db.refresh"));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(refresh.mock.calls.map(([id]) => id).sort()).toEqual(["a", "b"]);
  });

  it("refreshes more than four selected data sources", async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      id: `source-${i}`,
      name: `Source ${i}`,
      driver: "postgres" as const,
    }));
    const manyNodes = many.map((source) => ({ kind: "source" as const, key: source.id, source }));
    useDatabase.setState({ sources: many, selectedNode: manyNodes[0]!, selectedNodes: manyNodes });
    const refresh = vi.spyOn(databaseStore, "refresh").mockResolvedValue();

    act(() => void executeAction("db.refresh"));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(6));
    expect(refresh.mock.calls.map(([id]) => id).sort()).toEqual(many.map((source) => source.id));
  });
});
