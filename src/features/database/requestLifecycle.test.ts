import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DataSource, ProjectInfo } from "@/platform/ipc";
import { useProject } from "@/platform/project";

const backend = vi.hoisted(() => ({
  databases: vi.fn(),
  schemas: vi.fn(),
  tables: vi.fn(),
  objects: vi.fn(),
  details: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  completion: vi.fn(),
  sources: vi.fn(),
  connected: vi.fn(),
  save: vi.fn(),
  password: vi.fn(),
  sshSecret: vi.fn(),
  execute: vi.fn(),
  statements: vi.fn(),
}));
const ui = vi.hoisted(() => ({ show: vi.fn(), notify: vi.fn() }));
vi.mock("@/workbench/contributions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/workbench/contributions")>();
  return { ...actual, toolWindowService: () => ({ show: ui.show }), notifications: () => ({ notify: ui.notify }) };
});
vi.mock("@/platform/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    commands: {
      ...actual.commands,
      dbDatabases: backend.databases,
      dbSchemas: backend.schemas,
      dbTables: backend.tables,
      dbSchemaObjects: backend.objects,
      dbTableDetails: backend.details,
      dbConnect: backend.connect,
      dbDisconnect: backend.disconnect,
      dbCompletion: backend.completion,
      dbSources: backend.sources,
      dbConnected: backend.connected,
      dbSaveSources: backend.save,
      dbSetPassword: backend.password,
      dbSetSshSecret: backend.sshSecret,
      dbExecute: backend.execute,
      dbStatements: backend.statements,
    },
  };
});
import {
  connect,
  deleteSource,
  disconnect,
  loadCompletion,
  loadDatabases,
  loadDetails,
  loadSchemas,
  loadSources,
  loadTables,
  refresh,
  renameSource,
  revealInTree,
  saveSource,
  runSql,
  executeConsole,
  useDatabase,
  withConnection,
} from "./store";

const initial = useDatabase.getState();
const initialProject = useProject.getState();
const pg: DataSource = { id: "pg", name: "Database", driver: "postgres" };
const other: DataSource = { id: "pg2", name: "Other", driver: "postgres" };
const projectA = { root: "/project-a" } as ProjectInfo;
const projectB = { root: "/project-b" } as ProjectInfo;
const ok = <T>(data: T) => ({ status: "ok" as const, data });
function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const details = { columns: [], indexes: [], foreignKeys: [], triggers: [] };
const completion = { defaultSchema: "public", tables: [], foreignKeys: [] };
const cases = [
  {
    name: "databases",
    mock: backend.databases,
    load: (id: string) => loadDatabases(id),
    value: { current: "app", names: ["app"] },
    stale: { current: "old", names: ["old"] },
    read: (id: string) => useDatabase.getState().databases[id],
  },
  {
    name: "schemas",
    mock: backend.schemas,
    load: (id: string) => loadSchemas(id),
    value: ["public"],
    stale: ["old"],
    read: (id: string) => useDatabase.getState().schemas[id],
  },
  {
    name: "tables",
    mock: backend.tables,
    load: (id: string) => loadTables(id, "public"),
    value: [{ name: "users", kind: "table" }],
    stale: [{ name: "old", kind: "table" }],
    read: (id: string) => useDatabase.getState().tables[`${id}\u0000public`],
  },
  {
    name: "details",
    mock: backend.details,
    load: (id: string) => loadDetails(id, "public", "users"),
    value: details,
    stale: { ...details, columns: [{ name: "old" }] },
    read: (id: string) => useDatabase.getState().details[`${id}\u0000public\u0000users`],
  },
];
let savedSources: DataSource[];

function switchProject(project: ProjectInfo) {
  useProject.setState({ project });
  // The database feature's project subscription clears its visible state.
  useDatabase.setState({ ...initial, sources: [pg, other], loaded: true }, true);
}

beforeEach(() => {
  vi.resetAllMocks();
  useProject.setState({ project: projectA });
  savedSources = [pg, other];
  useDatabase.setState({ ...initial, sources: savedSources, loaded: true, connected: new Set(["pg"]) }, true);
  for (const spec of cases) spec.mock.mockResolvedValue(ok(spec.value));
  backend.connect.mockResolvedValue(ok(null));
  backend.disconnect.mockResolvedValue(ok(null));
  backend.objects.mockResolvedValue(ok({ routines: [], packages: [], sequences: [] }));
  backend.completion.mockResolvedValue(ok(completion));
  backend.sources.mockImplementation(async () => ok(savedSources));
  backend.connected.mockImplementation(async () => ok([...useDatabase.getState().connected]));
  backend.save.mockImplementation(async (sources: DataSource[]) => {
    savedSources = sources;
    return ok(null);
  });
  backend.password.mockResolvedValue(ok(null));
  backend.sshSecret.mockResolvedValue(ok(null));
  backend.statements.mockImplementation(async (_id: string, text: string) => ok([{ text, from: 0, to: text.length }]));
});
afterEach(() => {
  useProject.setState(initialProject, true);
  useDatabase.setState(initial, true);
});

describe("database metadata request lifetimes", () => {
  it.each(cases)("loads $name normally", async (spec) => {
    await spec.load("pg");
    expect(spec.read("pg")).toEqual({ status: "ok", value: spec.value });
  });

  const boundaries = [
    { name: "disconnect", run: () => disconnect("pg") },
    { name: "delete", run: () => deleteSource("pg") },
    { name: "edit", run: () => saveSource({ ...pg, host: "new-host" }, undefined) },
    { name: "project switch with the same source ID", run: async () => switchProject(projectB) },
    {
      name: "project A to B to A",
      run: async () => {
        switchProject(projectB);
        switchProject(projectA);
      },
    },
  ];
  for (const boundary of boundaries) {
    for (const outcome of ["success", "failure"] as const) {
      it.each(cases)(`ignores late ${outcome} for $name after ${boundary.name}`, async (spec) => {
        const response = deferred();
        spec.mock.mockReturnValueOnce(response.promise);
        const pending = spec.load("pg");
        await boundary.run();
        const cache = spec.read("pg");
        const connected = [...useDatabase.getState().connected];
        if (outcome === "success") response.resolve(ok(spec.stale));
        else response.reject(new Error("old connection failed"));
        await pending;
        expect.soft(spec.read("pg")).toEqual(cache);
        expect([...useDatabase.getState().connected]).toEqual(connected);
      });
    }
  }

  it.each(cases)("keeps the latest $name when responses arrive out of order", async (spec) => {
    const old = deferred();
    spec.mock.mockReturnValueOnce(old.promise);
    const pending = spec.load("pg");
    await spec.load("pg");
    old.resolve(ok(spec.stale));
    await pending;
    expect(spec.read("pg")).toEqual({ status: "ok", value: spec.value });
  });

  it.each(cases)("does not replace fresh $name with an older failure", async (spec) => {
    const old = deferred();
    spec.mock.mockReturnValueOnce(old.promise);
    const pending = spec.load("pg");
    await spec.load("pg");
    old.reject(new Error("old failure"));
    await pending;
    expect(spec.read("pg")).toEqual({ status: "ok", value: spec.value });
  });

  it.each(cases)("keeps fresh $name after disconnect and reconnect", async (spec) => {
    const old = deferred();
    spec.mock.mockReturnValueOnce(old.promise);
    const pending = spec.load("pg");
    await disconnect("pg");
    expect(await connect("pg")).toBe(true);
    await spec.load("pg");
    old.resolve(ok(spec.stale));
    await pending;
    expect(spec.read("pg")).toEqual({ status: "ok", value: spec.value });
    expect(useDatabase.getState().connected.has("pg")).toBe(true);
  });

  it.each(cases)("keeps a pending fresh $name when the old reply arrives first", async (spec) => {
    const old = deferred();
    const fresh = deferred();
    spec.mock.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const previous = spec.load("pg");
    await disconnect("pg");
    await connect("pg");
    const next = spec.load("pg");
    old.resolve(ok(spec.stale));
    await previous;
    expect(spec.read("pg")).toEqual({ status: "loading" });
    fresh.resolve(ok(spec.value));
    await next;
    expect(spec.read("pg")).toEqual({ status: "ok", value: spec.value });
  });

  it.each(cases)("does not restore deleted $name after the source ID is reused", async (spec) => {
    const old = deferred();
    spec.mock.mockReturnValueOnce(old.promise);
    const previous = spec.load("pg");
    await deleteSource("pg");
    savedSources = [pg, other];
    await loadSources();
    await spec.load("pg");
    old.resolve(ok(spec.stale));
    await previous;
    expect(spec.read("pg")).toEqual({ status: "ok", value: spec.value });
  });

  it.each(cases)("does not invalidate another source's pending $name", async (spec) => {
    const response = deferred();
    spec.mock.mockReturnValueOnce(response.promise);
    const pending = spec.load("pg2");
    await disconnect("pg");
    response.resolve(ok(spec.value));
    await pending;
    expect(spec.read("pg2")).toEqual({ status: "ok", value: spec.value });
    expect(useDatabase.getState().connected.has("pg")).toBe(false);
  });

  it("invalidates every database of a source", async () => {
    const response = deferred();
    backend.schemas.mockReturnValueOnce(response.promise);
    const pending = loadSchemas("pg:app");
    await disconnect("pg");
    response.resolve(ok(["old"]));
    await pending;
    expect(useDatabase.getState().schemas["pg:app"]).toBeUndefined();
    expect(useDatabase.getState().connected.has("pg:app")).toBe(false);
  });

  it("disconnects one database without invalidating its sibling", async () => {
    const response = deferred();
    backend.schemas.mockReturnValueOnce(response.promise);
    const pending = loadSchemas("pg:other");
    await disconnect("pg:app");
    response.resolve(ok(["public"]));
    await pending;
    expect(useDatabase.getState().schemas["pg:other"]).toEqual({ status: "ok", value: ["public"] });
  });

  it("does not request extra schema objects after the table request becomes stale", async () => {
    const response = deferred();
    backend.tables.mockReturnValueOnce(response.promise);
    const pending = loadTables("pg", "public");
    await disconnect("pg");
    response.resolve(ok([]));
    await pending;
    expect(backend.objects).not.toHaveBeenCalled();
  });

  it("ignores schema objects that were already in flight at disconnect", async () => {
    const response = deferred();
    backend.objects.mockReturnValueOnce(response.promise);
    const pending = loadTables("pg", "public");
    await vi.waitFor(() => expect(backend.objects).toHaveBeenCalledOnce());
    await disconnect("pg");
    response.resolve(ok({ routines: [], packages: [], sequences: [{ name: "old" }] }));
    await pending;
    expect(useDatabase.getState().tables["pg\u0000public"]).toBeUndefined();
    expect(useDatabase.getState().objects["pg\u0000public"]).toBeUndefined();
  });

  it("still lists tables when optional objects cannot be read", async () => {
    backend.objects.mockRejectedValueOnce(new Error("permission denied"));
    await loadTables("pg", "public");
    expect(useDatabase.getState().tables["pg\u0000public"]?.status).toBe("ok");
  });

  it("keeps metadata in flight when an unchanged source list is reloaded", async () => {
    const response = deferred();
    backend.schemas.mockReturnValueOnce(response.promise);
    const pending = loadSchemas("pg");
    await loadSources();
    response.resolve(ok(["public"]));
    await pending;
    expect(useDatabase.getState().schemas.pg).toEqual({ status: "ok", value: ["public"] });
  });

  it("keeps metadata in flight when the current project is renamed", async () => {
    const response = deferred();
    backend.schemas.mockReturnValueOnce(response.promise);
    const pending = loadSchemas("pg");
    useProject.setState({ project: { ...projectA, name: "Renamed" } });
    response.resolve(ok(["public"]));
    await pending;
    expect(useDatabase.getState().schemas.pg).toEqual({ status: "ok", value: ["public"] });
  });
});

describe("connection and metadata continuations", () => {
  it("reloads every level the tree had expanded after a data source is edited", async () => {
    await loadSchemas("pg");
    await loadTables("pg", "public");
    await loadDetails("pg", "public", "users");
    await saveSource({ ...pg, host: "new-host" }, undefined);
    const st = useDatabase.getState();
    expect(st.schemas.pg).toEqual({ status: "ok", value: ["public"] });
    expect(st.tables["pg\u0000public"]?.status).toBe("ok");
    expect(st.details["pg\u0000public\u0000users"]?.status).toBe("ok");
  });

  it("stores credentials when the save emits a source-change event before returning", async () => {
    backend.save.mockImplementationOnce(async (sources: DataSource[]) => {
      savedSources = sources;
      await loadSources();
      return ok(null);
    });
    await saveSource({ ...pg, host: "new-host" }, "password", "ssh-secret");
    expect(backend.password).toHaveBeenCalledWith("pg", "password", false);
    expect(backend.sshSecret).toHaveBeenCalledWith("pg", "ssh-secret", false);
    expect(useDatabase.getState().sources.find((s) => s.id === "pg")?.host).toBe("new-host");
  });

  it("does not let a pending disconnect clear a newer explicit connection", async () => {
    const response = deferred();
    backend.disconnect.mockReturnValueOnce(response.promise);
    const pending = disconnect("pg");
    expect(await connect("pg")).toBe(true);
    await loadSchemas("pg");
    response.resolve(ok(null));
    await pending;
    expect(useDatabase.getState().connected.has("pg")).toBe(true);
    expect(useDatabase.getState().schemas.pg?.status).toBe("ok");
  });

  it("does not restore connected state from a listing started before disconnect", async () => {
    const response = deferred();
    backend.connected.mockReturnValueOnce(response.promise);
    const pending = loadSources();
    await disconnect("pg");
    response.resolve(ok(["pg"]));
    await pending;
    expect(useDatabase.getState().connected.has("pg")).toBe(false);
  });

  it("does not clear a new connection with an old empty listing", async () => {
    useDatabase.setState({ connected: new Set() });
    const response = deferred();
    backend.connected.mockReturnValueOnce(response.promise);
    const pending = loadSources();
    await connect("pg");
    response.resolve(ok([]));
    await pending;
    expect(useDatabase.getState().connected.has("pg")).toBe(true);
  });

  it("keeps listing source definitions when its connected snapshot is stale", async () => {
    const response = deferred();
    backend.connected.mockReturnValueOnce(response.promise);
    backend.sources.mockResolvedValueOnce(ok([...savedSources, { id: "new", name: "New", driver: "sqlite" }]));
    const pending = loadSources();
    await disconnect("pg");
    response.resolve(ok(["pg"]));
    await pending;
    expect(useDatabase.getState().sources.map((s) => s.id)).toEqual(["pg", "pg2", "new"]);
    expect(useDatabase.getState().connected.has("pg")).toBe(false);
  });

  for (const outcome of ["success", "failure"] as const) {
    it(`ignores a source-list ${outcome} from project A after A to B to A`, async () => {
      const response = deferred();
      backend.sources.mockReturnValueOnce(response.promise);
      const pending = loadSources();
      switchProject(projectB);
      switchProject(projectA);
      if (outcome === "success") response.resolve(ok([{ ...pg, name: "Old" }]));
      else response.reject(new Error("old sources failure"));
      await pending;
      expect(useDatabase.getState().sources).toEqual([pg, other]);
      expect(ui.notify).not.toHaveBeenCalled();
    });
  }

  it("can load metadata again after a disconnect fails", async () => {
    backend.disconnect.mockRejectedValueOnce(new Error("disconnect failed"));
    await expect(disconnect("pg")).rejects.toThrow("disconnect failed");
    expect(useDatabase.getState().connected.has("pg")).toBe(true);
    await loadSchemas("pg");
    expect(useDatabase.getState().schemas.pg).toEqual({ status: "ok", value: ["public"] });
  });

  it("stops refresh between metadata stages", async () => {
    const response = deferred();
    backend.databases.mockReturnValueOnce(response.promise);
    useDatabase.setState({ schemas: { pg: { status: "ok", value: ["public"] } } });
    const pending = refresh("pg");
    await disconnect("pg");
    response.resolve(ok({ current: "app", names: ["app"] }));
    await pending;
    expect(backend.schemas).not.toHaveBeenCalled();
  });

  it.each(["table", undefined] as const)(
    "stops tree reveal after its connection becomes stale (kind %s)",
    async (kind) => {
      const response = deferred();
      backend.connect.mockReturnValueOnce(response.promise);
      const pending = revealInTree("pg", "public", "users", kind);
      await disconnect("pg");
      response.resolve(ok(null));
      await pending;
      expect(backend.databases).not.toHaveBeenCalled();
      expect(backend.schemas).not.toHaveBeenCalled();
      expect(useDatabase.getState().treeReveal).toBeNull();
    },
  );

  it.each(["table", undefined] as const)(
    "does not select a tree node after its pending details become stale (kind %s)",
    async (kind) => {
      useDatabase.setState({
        databases: { pg: { status: "ok", value: { current: "app", names: ["app"] } } },
        schemas: { pg: { status: "ok", value: ["public"] } },
        tables: { "pg\u0000public": { status: "ok", value: [{ name: "users", kind: "view" }] } },
      });
      const response = deferred();
      backend.details.mockReturnValueOnce(response.promise);
      const pending = revealInTree("pg", "public", "users", kind, "id");
      await vi.waitFor(() => expect(backend.details).toHaveBeenCalledOnce());
      await disconnect("pg");
      response.resolve(ok(details));
      await pending;
      expect(useDatabase.getState().treeReveal).toBeNull();
      expect(useDatabase.getState().treeExpanded.size).toBe(0);
      expect(ui.show).not.toHaveBeenCalled();
    },
  );

  it("infers a view's folder while revealing a current table editor", async () => {
    useDatabase.setState({
      databases: { pg: { status: "ok", value: { current: "app", names: ["app"] } } },
      schemas: { pg: { status: "ok", value: ["public"] } },
      tables: { "pg\u0000public": { status: "ok", value: [{ name: "users", kind: "view" }] } },
    });
    await revealInTree("pg", "public", "users", undefined);
    expect(useDatabase.getState().treeReveal?.path.at(-1)).toBe("pg/public/views/users");
    expect(ui.show).toHaveBeenCalledWith("database");
    expect(backend.connect).not.toHaveBeenCalled();
  });

  it("preserves successful write results without restoring a stale connection", async () => {
    const response = deferred<number>();
    const pending = withConnection("pg", () => response.promise);
    await disconnect("pg");
    response.resolve(7);
    expect(await pending).toBe(7);
    expect(useDatabase.getState().connected.has("pg")).toBe(false);
  });

  it("does not prompt for credentials after the request becomes stale", async () => {
    const response = deferred();
    backend.schemas.mockReturnValueOnce(response.promise);
    const pending = loadSchemas("pg");
    await disconnect("pg");
    response.resolve({ status: "error", error: { kind: "permissionDenied", message: "authentication failed" } });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(settled || useDatabase.getState().dialog?.kind === "password").toBe(true));
    const dialog = useDatabase.getState().dialog;
    expect.soft(dialog).toBeNull();
    if (dialog?.kind === "password") dialog.resolve(false);
    await pending;
    expect(backend.schemas).toHaveBeenCalledOnce();
  });

  it("does not retry if disconnected while waiting for a password", async () => {
    backend.schemas.mockResolvedValueOnce({
      status: "error",
      error: { kind: "permissionDenied", message: "authentication failed" },
    });
    const pending = loadSchemas("pg");
    await vi.waitFor(() => expect(useDatabase.getState().dialog?.kind).toBe("password"));
    const dialog = useDatabase.getState().dialog;
    if (dialog?.kind !== "password") throw new Error("Expected password prompt");
    await disconnect("pg");
    useDatabase.setState({ dialog: null });
    dialog.resolve(true);
    await pending;
    expect(backend.schemas).toHaveBeenCalledOnce();
    expect(useDatabase.getState().schemas.pg).toBeUndefined();
  });

  it("still retries a current request after a password is supplied", async () => {
    backend.schemas.mockResolvedValueOnce({
      status: "error",
      error: { kind: "permissionDenied", message: "authentication failed" },
    });
    const pending = loadSchemas("pg");
    await vi.waitFor(() => expect(useDatabase.getState().dialog?.kind).toBe("password"));
    const dialog = useDatabase.getState().dialog;
    if (dialog?.kind !== "password") throw new Error("Expected password prompt");
    useDatabase.setState({ dialog: null });
    dialog.resolve(true);
    await pending;
    expect(backend.schemas).toHaveBeenCalledTimes(2);
    expect(useDatabase.getState().schemas.pg?.status).toBe("ok");
  });

  for (const [name, mutate] of [
    ["save", () => saveSource({ ...pg, host: "new" }, "secret", "ssh")],
    ["delete", () => deleteSource("pg")],
    ["rename", () => renameSource("pg", "Renamed")],
  ] as const) {
    it(`does not continue ${name} in a different project`, async () => {
      const response = deferred();
      backend.save.mockReturnValueOnce(response.promise);
      const pending = mutate();
      switchProject(projectB);
      response.resolve(ok(null));
      await pending;
      expect(backend.sources).not.toHaveBeenCalled();
      expect(backend.password).not.toHaveBeenCalled();
      expect(backend.sshSecret).not.toHaveBeenCalled();
    });
  }
});

describe("completion requests", () => {
  it("deduplicates requests in the same lifetime", async () => {
    const response = deferred();
    backend.completion.mockReturnValueOnce(response.promise);
    const first = loadCompletion("pg");
    const second = loadCompletion("pg");
    expect(first).toBe(second);
    response.resolve(ok(completion));
    expect(await first).toEqual(completion);
    expect(backend.completion).toHaveBeenCalledOnce();
  });

  it("ignores completion resolved after disconnect", async () => {
    const response = deferred();
    backend.completion.mockReturnValueOnce(response.promise);
    const pending = loadCompletion("pg");
    await disconnect("pg");
    response.resolve(ok(completion));
    expect(await pending).toBeNull();
    expect(useDatabase.getState().completion.pg).toBeUndefined();
  });

  it("does not reuse old completion or let its cleanup remove a newer request", async () => {
    const old = deferred();
    const fresh = deferred();
    backend.completion.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const previous = loadCompletion("pg");
    await disconnect("pg");
    const next = loadCompletion("pg");
    expect(next).not.toBe(previous);
    old.resolve(ok({ ...completion, defaultSchema: "old" }));
    expect(await previous).toBeNull();
    expect(loadCompletion("pg")).toBe(next);
    fresh.resolve(ok(completion));
    expect(await next).toEqual(completion);
    expect(backend.completion).toHaveBeenCalledTimes(2);
  });

  it("lets completion recover after failure", async () => {
    backend.completion.mockRejectedValueOnce(new Error("not available"));
    expect(await loadCompletion("pg")).toBeNull();
    expect(await loadCompletion("pg")).toEqual(completion);
    expect(backend.completion).toHaveBeenCalledTimes(2);
  });
});

describe("overlapping database operations", () => {
  it("failed reconnect does not preserve the old disconnected flag", async () => {
    const response = deferred();
    backend.disconnect.mockReturnValueOnce(response.promise);
    const pending = disconnect("pg");
    backend.connect.mockRejectedValueOnce(new Error("new connection failed"));
    expect(await connect("pg")).toBe(false);
    response.resolve(ok(null));
    await pending;
    expect(useDatabase.getState().connected.has("pg")).toBe(false);
  });

  it("successful implicit reconnect survives the old disconnect acknowledgement", async () => {
    const response = deferred();
    backend.disconnect.mockReturnValueOnce(response.promise);
    const pending = disconnect("pg");
    await loadSchemas("pg");
    response.resolve(ok(null));
    await pending;
    expect(useDatabase.getState().schemas.pg?.status).toBe("ok");
    expect(useDatabase.getState().connected.has("pg")).toBe(true);
  });

  it("unrelated local connect does not keep an edited source marked connected", async () => {
    const response = deferred();
    backend.connected.mockReturnValueOnce(response.promise);
    backend.sources.mockResolvedValueOnce(ok([{ ...pg, host: "changed" }, other]));
    const pending = loadSources();
    await connect("pg2");
    response.resolve(ok([]));
    await pending;
    expect.soft(useDatabase.getState().connected.has("pg2")).toBe(true);
    expect(useDatabase.getState().connected.has("pg")).toBe(false);
  });
});

it("saving a source must not reconnect after a later disconnect", async () => {
  const response = deferred();
  backend.save.mockReturnValueOnce(response.promise);
  useDatabase.setState({ databases: { pg: { status: "ok", value: { current: "app", names: ["app"] } } } });
  const pending = saveSource({ ...pg, host: "changed" }, undefined);
  await disconnect("pg");
  savedSources = [{ ...pg, host: "changed" }, other];
  response.resolve(ok(null));
  await pending;
  expect(backend.databases).not.toHaveBeenCalled();
  expect(useDatabase.getState().connected.has("pg")).toBe(false);
});

it("whole-source refresh does not restart a disconnected child database", async () => {
  useDatabase.setState({
    connected: new Set(["pg", "pg:app", "pg:other"]),
    schemas: {
      "pg:app": { status: "ok", value: ["public"] },
      "pg:other": { status: "ok", value: ["public"] },
    },
    tables: {
      "pg:app\u0000public": { status: "ok", value: [{ name: "users", kind: "table" }] },
      "pg:other\u0000public": { status: "ok", value: [{ name: "users", kind: "table" }] },
    },
  });
  const response = deferred();
  backend.schemas.mockImplementation((id: string) =>
    id === "pg:app" ? response.promise : Promise.resolve(ok(["public"])),
  );
  const pending = refresh("pg");
  await vi.waitFor(() => expect(backend.schemas).toHaveBeenCalledTimes(2));
  await disconnect("pg:app");
  response.resolve(ok(["public"]));
  await pending;
  expect(backend.tables.mock.calls.map((c) => c[0])).toEqual(["pg:other"]);
  expect(useDatabase.getState().schemas["pg:app"]).toBeUndefined();
});

it("late successful DDL does not refresh metadata after disconnect", async () => {
  const response = deferred();
  backend.execute.mockReturnValueOnce(response.promise);
  const text = "CREATE TABLE test (id int)";
  const pending = runSql("pg", [text]);
  await disconnect("pg");
  response.resolve(ok([{ statement: { text, from: 0, to: text.length }, result: null, error: null }]));
  expect(await pending).toBe(true);
  expect.soft(backend.databases).not.toHaveBeenCalled();
  expect(useDatabase.getState().output).toEqual([]);
});

it("old SQL is not executed in a new project after completion finishes", async () => {
  useDatabase.setState({ consoles: { "console.sql": "pg" } });
  const response = deferred();
  backend.completion.mockReturnValueOnce(response.promise);
  const text = "DELETE FROM users";
  const pending = executeConsole("console.sql", text, 0, text.length);
  await vi.waitFor(() => expect(backend.completion).toHaveBeenCalledOnce());
  switchProject(projectB);
  response.resolve(ok(completion));
  await pending;
  expect(backend.execute).not.toHaveBeenCalled();
});

it("querying a source's default database does not freeze a sibling connection snapshot", async () => {
  useDatabase.setState({ connected: new Set(["pg", "pg:app"]) });
  const response = deferred();
  backend.connected.mockReturnValueOnce(response.promise);
  const pending = loadSources();
  await loadSchemas("pg");
  response.resolve(ok(["pg"]));
  await pending;
  expect(useDatabase.getState().connected.has("pg")).toBe(true);
  expect(useDatabase.getState().connected.has("pg:app")).toBe(false);
});
