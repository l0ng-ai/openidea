import { beforeEach, expect, it, vi } from "vitest";
import type { HttpExchange, HttpRequestBlock } from "@/platform/ipc";
import { runAll, runRequest, selectEntry, setEnvironment, useHttpClient } from "./store";

const backend = vi.hoisted(() => ({
  httpEnvironments: vi.fn(),
  httpExecute: vi.fn(),
  httpHistoryGet: vi.fn(),
  httpRequests: vi.fn(),
}));
vi.mock("@/platform/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/ipc")>();
  return { ...actual, commands: { ...actual.commands, ...backend } };
});
vi.mock("@/workbench/contributions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/workbench/contributions")>()),
  showServiceView: vi.fn(),
}));

const path = "/project/batch.http";
const text = "### First\nGET {{baseUrl}}/first\n\n### Second\nGET {{baseUrl}}/second\n";
const blocks: HttpRequestBlock[] = [
  { index: 0, name: "First", method: "GET", url: "{{baseUrl}}/first", line: 1, startLine: 1, endLine: 2 },
  { index: 1, name: "Second", method: "GET", url: "{{baseUrl}}/second", line: 4, startLine: 4, endLine: 4 },
];
const exchange: HttpExchange = {
  entry: {
    id: "test",
    timeMs: null,
    name: null,
    method: "GET",
    url: "http://127.0.0.1/first",
    status: 200,
    totalMs: null,
    file: path,
    error: null,
  },
  request: { name: null, method: "GET", url: "http://127.0.0.1/first", headers: [], body: null },
  response: null,
};
const ok = <T>(data: T) => ({ status: "ok" as const, data });
const initial = useHttpClient.getState();

beforeEach(() => {
  localStorage.clear();
  useHttpClient.setState(initial);
  vi.resetAllMocks();
  backend.httpEnvironments.mockResolvedValue(ok(["A", "B"]));
  backend.httpExecute.mockResolvedValue(ok(exchange));
  backend.httpRequests.mockResolvedValue(blocks);
});

it.each(["A", null])("keeps the starting environment %s throughout a batch", async (startingEnvironment) => {
  useHttpClient.setState({ environments: { [path]: ["A", "B"] } });
  setEnvironment(path, startingEnvironment);
  let releaseFirst!: () => void;
  const holdFirst = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  backend.httpExecute.mockImplementationOnce(async () => {
    await holdFirst;
    return ok(exchange);
  });

  const batch = runAll(path, text);
  await vi.waitFor(() =>
    expect(backend.httpExecute).toHaveBeenCalledExactlyOnceWith(expect.any(Number), path, text, 0, startingEnvironment),
  );
  setEnvironment(path, "B");
  releaseFirst();
  await batch;
  expect(backend.httpExecute).toHaveBeenNthCalledWith(2, expect.any(Number), path, text, 1, startingEnvironment);

  await runAll(path, text);
  expect(backend.httpExecute).toHaveBeenNthCalledWith(3, expect.any(Number), path, text, 0, "B");
  expect(backend.httpExecute).toHaveBeenNthCalledWith(4, expect.any(Number), path, text, 1, "B");
  await runRequest(path, text, 1);
  expect(backend.httpExecute).toHaveBeenNthCalledWith(5, expect.any(Number), path, text, 1, "B");
});

it.each(["A", "missing"])("validates the starting choice %s once when environments load", async (choice) => {
  setEnvironment(path, choice);
  let finishLoading!: (value: ReturnType<typeof ok<string[]>>) => void;
  backend.httpEnvironments.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishLoading = resolve;
      }),
  );
  const batch = runAll(path, text);
  await vi.waitFor(() => expect(backend.httpEnvironments).toHaveBeenCalledExactlyOnceWith(path));
  setEnvironment(path, "B");
  finishLoading(ok(["A", "B"]));
  await batch;
  const environment = choice === "A" ? "A" : null;
  expect(backend.httpExecute).toHaveBeenNthCalledWith(1, expect.any(Number), path, text, 0, environment);
  expect(backend.httpExecute).toHaveBeenNthCalledWith(2, expect.any(Number), path, text, 1, environment);
});

function response(id: string): HttpExchange {
  return { ...exchange, entry: { ...exchange.entry, id } };
}

it("keeps 100 history rows and the four most recently used exchanges", async () => {
  for (let n = 0; n < 101; n++) {
    backend.httpExecute.mockResolvedValueOnce(ok(response(String(n))));
    await runRequest(null, text, 0);
  }
  const state = useHttpClient.getState();
  expect(state.history).toHaveLength(100);
  expect(state.history.at(-1)?.id).toBe("1");
  expect(state.exchanges).toHaveLength(4);

  await selectEntry("97"); // Touch the oldest resident before opening a cold row.
  backend.httpHistoryGet.mockResolvedValueOnce(ok(response("1")));
  await selectEntry("1");
  await selectEntry("97");
  expect(backend.httpHistoryGet.mock.calls).toEqual([["1"]]);
  expect(useHttpClient.getState().exchanges.map((e) => e.entry.id)).toEqual(["97", "1", "100", "99"]);
});

it("keeps the latest selection when two cold reads finish out of order", async () => {
  let finishFirst!: (result: ReturnType<typeof ok<HttpExchange>>) => void;
  const first = new Promise<ReturnType<typeof ok<HttpExchange>>>((resolve) => {
    finishFirst = resolve;
  });
  backend.httpHistoryGet.mockReturnValueOnce(first).mockResolvedValueOnce(ok(response("b")));
  const pending = selectEntry("a");
  await selectEntry("b");
  finishFirst(ok(response("a")));
  await pending;
  const { selected, exchanges } = useHttpClient.getState();
  expect(selected).toBe("b");
  expect(exchanges).toEqual([response("b")]);
});
