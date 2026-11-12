/**
 * Introspection of a Snowflake data source: the schemas, tables and views of every database
 * it shows, read in the background so completion can follow `database.schema.table` without
 * the tree being opened. The backend keeps what was read on disk, so the next run starts with
 * it; it is read again when asked, or on connecting once it is older than a day.
 */
import { call, commands } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { notifications } from "@/workbench/contributions";
import { shownNames, splitTarget } from "./model";
import { loadDatabases, sourceById, useDatabase } from "./store";

const ACCEPTED_KEY = "openidea.database.introspect";
/** Data sources asked (or started) in this run, so a connect asks only once. */
const offered = new Set<string>();
const cancelled = new Set<string>();

function accepted(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(ACCEPTED_KEY) ?? "[]");
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function remember(id: string) {
  try {
    localStorage.setItem(ACCEPTED_KEY, JSON.stringify([...new Set([...accepted(), id])]));
  } catch {
    // Without storage the question comes again next time.
  }
}

const notice = (id: string) => `db-introspect-${id}`;

/** A saved catalog older than this is read again on the next connect. */
const STALE_MS = 24 * 60 * 60 * 1000;
const loading = new Map<string, Promise<void>>();

/**
 * Brings what earlier introspection of data source `id` saved into the store (once per run).
 * Reads a file: the data source is not connected to.
 */
export function loadSavedCatalog(id: string): Promise<void> {
  const sourceId = splitTarget(id).id;
  if (sourceById(sourceId)?.driver !== "snowflake") return Promise.resolve();
  let pending = loading.get(sourceId);
  if (!pending) {
    pending = call(commands.dbSavedCatalog(sourceId))
      .then((saved) => {
        const databases = saved?.databases ?? [];
        // An introspection started meanwhile knows better.
        if (!databases.length || useDatabase.getState().catalogs[sourceId]) return;
        useDatabase.setState((s) => ({
          catalogs: {
            ...s.catalogs,
            [sourceId]: {
              status: "done",
              done: databases.length,
              total: databases.length,
              readAt: Math.min(...databases.map((d) => d.readAt ?? 0)),
              databases: Object.fromEntries(databases.map((d) => [d.name, d.schemas])),
            },
          },
        }));
      })
      .catch(() => {});
    loading.set(sourceId, pending);
  }
  return pending;
}

/** Stops the running introspection of data source `id` after the database it is reading. */
export function cancelIntrospection(id: string) {
  cancelled.add(splitTarget(id).id);
}

/** Reads the schemas and tables of every database data source `id` shows (see the Schemas tab). */
export async function introspectSource(id: string): Promise<void> {
  const sourceId = splitTarget(id).id;
  const source = sourceById(sourceId);
  if (source?.driver !== "snowflake" || useDatabase.getState().catalogs[sourceId]?.status === "running") return;
  offered.add(sourceId);
  remember(sourceId);
  cancelled.delete(sourceId);
  const name = source.name ?? "";
  const update = (patch: Partial<{ status: "running" | "done" | "cancelled"; done: number; total: number }>) =>
    useDatabase.setState((s) => {
      const old = s.catalogs[sourceId] ?? { status: "running" as const, done: 0, total: 0, databases: {} };
      return { catalogs: { ...s.catalogs, [sourceId]: { ...old, ...patch } } };
    });
  await loadSavedCatalog(sourceId);
  update({ status: "running", done: 0, total: 0 });
  if (!useDatabase.getState().databases[sourceId]) await loadDatabases(sourceId);
  const listed = useDatabase.getState().databases[sourceId];
  if (listed?.status !== "ok") {
    update({ status: "cancelled" });
    return;
  }
  const filter = source.introspection;
  const databases = shownNames(listed.value.names, filter?.allDatabases, filter?.databases, listed.value.current);
  update({ total: databases.length });
  let tables = 0;
  let done = 0;
  const failed: string[] = [];
  let reason = "";
  for (const database of databases) {
    if (cancelled.has(sourceId)) break;
    const position = done + 1;
    const count = databases.length;
    notifications().notify({
      level: "info",
      key: notice(sourceId),
      title: tx`Introspecting ${name}`,
      body: tx`${database} (${position} of ${count})`,
      actions: [{ label: "Stop", run: () => cancelIntrospection(sourceId) }],
      sticky: true,
    });
    try {
      const schemas = await call(commands.dbDatabaseCatalog(sourceId, database));
      tables += schemas.reduce((n, schema) => n + schema.tables.length, 0);
      useDatabase.setState((s) => {
        const old = s.catalogs[sourceId];
        if (!old) return s;
        return {
          catalogs: { ...s.catalogs, [sourceId]: { ...old, databases: { ...old.databases, [database]: schemas } } },
        };
      });
    } catch (error) {
      // A database the role may not read: completion goes without it, and the summary says so.
      failed.push(database);
      reason ||= error instanceof Error ? error.message : String(error);
    }
    done += 1;
    update({ done });
  }
  const stopped = cancelled.delete(sourceId);
  const total = tables.toLocaleString("en");
  const read = done - failed.length;
  const unread = failed.length;
  if (!stopped) {
    // Databases dropped on the server, or no longer shown, leave the catalog and its file.
    useDatabase.setState((s) => {
      const old = s.catalogs[sourceId];
      if (!old) return s;
      const kept = Object.fromEntries(Object.entries(old.databases).filter(([d]) => databases.includes(d)));
      // Nothing read at all is not a catalog to rely on for a day: the next connect tries again.
      const readAt = read > 0 || !unread ? Date.now() : old.readAt;
      return { catalogs: { ...s.catalogs, [sourceId]: { ...old, databases: kept, readAt } } };
    });
    await call(commands.dbRetainCatalog(sourceId, databases)).catch(() => {});
  }
  update({ status: stopped ? "cancelled" : "done" });
  const summary = tx`${total} tables and views in ${read} databases are ready for completion.`;
  notifications().notify({
    level: unread ? "warning" : "info",
    key: notice(sourceId),
    title: stopped ? tx`Introspection of ${name} stopped` : tx`Introspected ${name}`,
    body: unread ? `${summary} ${tx`${unread} databases could not be read: ${reason}`}` : summary,
    sticky: unread > 0,
  });
}

/**
 * On connecting to Snowflake data source `id`: nothing while its saved catalog is recent; else
 * introspects it when the user agreed before, or asks once (IDEA asks the same of a data
 * source it has not introspected).
 */
export async function offerIntrospection(id: string): Promise<void> {
  const sourceId = splitTarget(id).id;
  const source = sourceById(sourceId);
  if (source?.driver !== "snowflake" || offered.has(sourceId)) return;
  offered.add(sourceId);
  await loadSavedCatalog(sourceId);
  const known = useDatabase.getState().catalogs[sourceId];
  if (known?.status === "running") return;
  if (known?.readAt !== undefined && Date.now() - known.readAt < STALE_MS) return;
  if (accepted().includes(sourceId)) {
    void introspectSource(sourceId);
    return;
  }
  const name = source.name ?? "";
  notifications().notify({
    level: "info",
    key: notice(sourceId),
    title: tx`Introspect ${name}?`,
    body: tx("Reads the names of schemas, tables and views of every database, so completion works for all of them."),
    actions: [
      { label: "Introspect", run: () => void introspectSource(sourceId) },
      { label: "Not Now", run: () => {} },
    ],
    sticky: true,
  });
}
