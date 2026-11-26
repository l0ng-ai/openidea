import { describe, expect, it } from "vitest";
import { workspaceJoinQuery } from "./workspaceQuery";

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
