import { beforeEach, expect, it, vi } from "vitest";
import type { HttpExchange, HttpRequestBlock } from "@/platform/ipc";
import { runAll, runRequest, setEnvironment, useHttpClient } from "./store";

const backend = vi.hoisted(() => ({
  httpEnvironments: vi.fn(),
  httpExecute: vi.fn(),
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
