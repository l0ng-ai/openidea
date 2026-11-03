import { describe, expect, it } from "vitest";
import { ProviderAcquisitions } from "./providerAcquisition";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const owned = new Set<string>();
  const closed: string[] = [];
  const pool = new ProviderAcquisitions<{ id: string }>(
    (value) => owned.has(value.id),
    async (value) => {
      closed.push(value.id);
    },
  );
  return { owned, closed, pool };
}

describe("provider incarnation ownership", () => {
  it("does not close an admitted alias when another resolution is abandoned", async () => {
    const { pool, owned, closed } = fixture();
    const first = await pool.acquire(async () => ({ id: "shared" }));
    const response = deferred<{ id: string }>();
    const started = deferred<void>();
    const opening = pool.acquire(() => {
      started.resolve();
      return response.promise;
    });
    await started.promise;
    const rollback = first.rollback();
    response.resolve({ id: "shared" });
    const second = await opening;
    // The unresolved acquisition now owns a lease, even before tab admission.
    await rollback;
    expect(closed).toEqual([]);
    owned.add("shared");
    second.admit();
    expect(closed).toEqual([]);
  });

  it("releases a shared backend once when every alias is abandoned", async () => {
    const { pool, closed } = fixture();
    const a = await pool.acquire(async () => ({ id: "shared" }));
    const b = await pool.acquire(async () => ({ id: "shared" }));
    await Promise.all([a.rollback(), b.rollback()]);
    await a.rollback();
    expect(closed).toEqual(["shared"]);
  });

  it("never releases an existing session or a replacement incarnation", async () => {
    const { pool, owned, closed } = fixture();
    owned.add("existing");
    const existing = await pool.acquire(async () => ({ id: "existing" }));
    await existing.rollback();
    const old = await pool.acquire(async () => ({ id: "old-project" }));
    owned.add("new-project");
    const replacement = await pool.acquire(async () => ({ id: "new-project" }));
    replacement.admit();
    await old.rollback();
    expect(closed).toEqual(["old-project"]);
    expect(owned).toEqual(new Set(["existing", "new-project"]));
  });

  it("waits for abandoned cleanup before reopening the backend path", async () => {
    const closed = deferred<void>();
    const closing = deferred<void>();
    let incarnation = "old";
    const pool = new ProviderAcquisitions<{ id: string }>(
      () => false,
      async () => {
        closing.resolve();
        await closed.promise;
        incarnation = "new";
      },
    );
    const old = await pool.acquire(async () => ({ id: incarnation }));
    const rollback = old.rollback();
    await closing.promise;
    const reopening = pool.acquire(async () => ({ id: incarnation }));
    closed.resolve();
    await rollback;
    const fresh = await reopening;
    expect(fresh.value.id).toBe("new");
    fresh.admit();
  });
});
