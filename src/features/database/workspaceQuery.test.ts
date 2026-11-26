import { describe, expect, it } from "vitest";
import { workspaceJoinQuery, workspaceSourceNames } from "./workspaceQuery";

describe("workspace table references", () => {
  it("keeps quoted dots, embedded quotes and reversed join keys", () => {
    const result = workspaceJoinQuery(
      'SELECT * FROM #left."odd.schema"."a""b" AS a JOIN #right.events.lookup b ON b."Key" = a.id;',
    );
    expect(result).toEqual([
      { source: "left", schema: "odd.schema", table: 'a"b', alias: "a", key: "id" },
      { source: "right", schema: "events", table: "lookup", alias: "b", key: "Key" },
    ]);
  });
  it("allows comments and the source name as the default alias", () => {
    expect(
      workspaceJoinQuery("select * from #left.public.t /* first */ inner join #right.db.t on left.id=right.id").map(
        (x) => x.key,
      ),
    ).toEqual(["id", "id"]);
  });
  it("joins explicitly selected sources by their quoted display names", () => {
    const names = workspaceSourceNames('Sales "EU"', "events");
    const refs = workspaceJoinQuery(
      'SELECT * FROM #events.logs.orders e JOIN #"Sales ""EU""".public.users u ON u.id=e.id',
      names,
    );
    expect(refs.map((ref) => ref.source)).toEqual(["right", "left"]);
    expect(() =>
      workspaceJoinQuery("SELECT * FROM #other.logs.orders e JOIN #left.public.users u ON u.id=e.id", names),
    ).toThrow();
    expect(() =>
      workspaceJoinQuery("SELECT * FROM #events.logs.t a JOIN #right.logs.t b ON a.id=b.id", names),
    ).toThrow();
  });
  it("keeps stable references for blank, conflicting, or reserved display names", () => {
    expect(workspaceSourceNames("Sales", "sales")).toEqual({ left: "left", right: "right" });
    expect(workspaceSourceNames("right", "warehouse")).toEqual({ left: "left", right: "warehouse" });
    expect(workspaceSourceNames("  ", "LEFT")).toEqual({ left: "left", right: "right" });
  });
  it.each([
    "left.id = left.id",
    "missing.id = right.id",
    "left.id = right.id; select 1",
    "left.id = right.id OR true",
    'left.id = right."oops',
  ])("rejects the incomplete or unsupported predicate %s", (predicate) => {
    expect(() => workspaceJoinQuery("select * from #left.public.t join #right.db.t on " + predicate)).toThrow();
  });
});
