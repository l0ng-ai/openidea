import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DataSource, DbSourceCatalog } from "@/platform/ipc";

const backend = vi.hoisted(() => ({
  saved: vi.fn(),
  database: vi.fn(),
  retain: vi.fn(),
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    commands: {
      ...actual.commands,
      dbSavedCatalog: backend.saved,
      dbDatabaseCatalog: backend.database,
      dbRetainCatalog: backend.retain,
    },
  };
});

const ok = <T>(data: T) => ({ status: "ok" as const, data });
const schemas = (table: string) => [{ name: "PUBLIC", tables: [{ name: table, kind: "table" as const }] }];
const HOUR = 60 * 60 * 1000;

/** A fresh copy of the module (its "asked this run" memory starts empty) over a seeded store. */
async function setup(id: string, saved: DbSourceCatalog | null, introspection?: Partial<DataSource["introspection"]>) {
  vi.resetModules();
  const { useDatabase } = await import("./store");
  const source = {
    id,
    name: "warehouse",
    driver: "snowflake",
    introspection: { allDatabases: true, databases: [], ...introspection },
  } as unknown as DataSource;
  useDatabase.setState({
    sources: [source],
    loaded: true,
    catalogs: {},
    databases: { [id]: { status: "ok", value: { current: "", names: ["ANALYTICS", "RAW"] } } },
  });
  backend.saved.mockResolvedValue(ok(saved));
  backend.database.mockImplementation((_id: string, database: string) => Promise.resolve(ok(schemas(`${database}_T`))));
  backend.retain.mockResolvedValue(ok(null));
  return { useDatabase, ...(await import("./introspection")) };
}

// Each test loads a fresh copy of the store module, which takes a while in a busy run.
vi.setConfig({ testTimeout: 30_000 });

describe("Snowflake introspection", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("starts from the catalog saved on disk without reading the server", async () => {
    const saved = { databases: [{ name: "RAW", readAt: Date.now() - HOUR, schemas: schemas("EVENTS") }] };
    const { useDatabase, loadSavedCatalog, offerIntrospection } = await setup("sf", saved);
    await loadSavedCatalog("sf:RAW");
    const catalog = useDatabase.getState().catalogs.sf!;
    expect(catalog.status).toBe("done");
    expect(catalog.databases.RAW).toEqual(schemas("EVENTS"));
    // Recent enough: connecting neither asks nor reads again.
    await offerIntrospection("sf");
    expect(backend.database).not.toHaveBeenCalled();
    expect(backend.saved).toHaveBeenCalledTimes(1);
  });

  it("reads every shown database, saves as it goes and forgets dropped ones", async () => {
    const saved = { databases: [{ name: "GONE", readAt: Date.now() - HOUR, schemas: schemas("OLD") }] };
    const { useDatabase, introspectSource } = await setup("sf", saved);
    await introspectSource("sf");
    expect(backend.database.mock.calls.map((c) => c[1])).toEqual(["ANALYTICS", "RAW"]);
    expect(backend.retain).toHaveBeenCalledWith("sf", ["ANALYTICS", "RAW"]);
    const catalog = useDatabase.getState().catalogs.sf!;
    expect(catalog.status).toBe("done");
    expect(Object.keys(catalog.databases).sort()).toEqual(["ANALYTICS", "RAW"]);
    expect(catalog.databases.ANALYTICS).toEqual(schemas("ANALYTICS_T"));
    expect(Date.now() - catalog.readAt!).toBeLessThan(HOUR);
  });

  it("reads again on connect only when the saved catalog is over a day old and the user agreed before", async () => {
    const old = { databases: [{ name: "RAW", readAt: Date.now() - 25 * HOUR, schemas: schemas("EVENTS") }] };
    // Not agreed yet: asks (a notification), reads nothing.
    let run = await setup("sf", old);
    await run.offerIntrospection("sf");
    expect(backend.database).not.toHaveBeenCalled();
    expect(run.useDatabase.getState().catalogs.sf!.databases.RAW).toEqual(schemas("EVENTS"));

    // Agreed once (by running it): the next run refreshes a stale catalog by itself.
    await run.introspectSource("sf");
    vi.clearAllMocks();
    run = await setup("sf", old);
    await run.offerIntrospection("sf");
    await vi.waitFor(() => expect(run.useDatabase.getState().catalogs.sf?.status).toBe("done"));
    expect(backend.database.mock.calls.map((c) => c[1])).toEqual(["ANALYTICS", "RAW"]);
  });

  it("keeps to the databases the Schemas tab shows, and goes on past one it may not read", async () => {
    const { useDatabase, introspectSource } = await setup("sf", null, { allDatabases: false, databases: ["RA*"] });
    backend.database.mockRejectedValueOnce(new Error("not authorized"));
    await introspectSource("sf");
    expect(backend.database.mock.calls.map((c) => c[1])).toEqual(["RAW"]);
    expect(useDatabase.getState().catalogs.sf).toMatchObject({ status: "done", done: 1, total: 1, databases: {} });
    // Nothing was read: not a catalog to rely on, so the next connect reads again.
    expect(useDatabase.getState().catalogs.sf?.readAt).toBeUndefined();
  });

  it("does nothing for other databases", async () => {
    const { useDatabase, introspectSource, loadSavedCatalog } = await setup("pg", null);
    useDatabase.setState({ sources: [{ id: "pg", name: "pg", driver: "postgres" } as unknown as DataSource] });
    await loadSavedCatalog("pg");
    await introspectSource("pg");
    expect(backend.saved).not.toHaveBeenCalled();
    expect(backend.database).not.toHaveBeenCalled();
  });
});
