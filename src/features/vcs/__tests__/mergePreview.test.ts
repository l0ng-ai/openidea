import { expect, it, vi } from "vitest";

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  const ok = (data: unknown) => Promise.resolve({ status: "ok" as const, data });
  const file = (path: string) => ({ path, kind: "modified", oldPath: null });
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsLog: (_repo: string | null, query: { range?: string | null }) =>
        ok(
          query.range === "main..feature"
            ? [{ id: "a2", shortId: "a2" }, { id: "a1", shortId: "a1" }]
            : [{ id: "b1", shortId: "b1" }],
        ),
      vcsMergeBase: () => ok("base"),
      vcsDiffRevisions: (_repo: string | null, _from: string, to: string) =>
        ok(to === "feature" ? [file("src/a.ts"), file("src/b.ts")] : [file("src/b.ts"), file("src/c.ts")]),
    },
  };
});

import { loadMergePreview } from "../mergePreview";

it("counts what each side has and names the files both changed", async () => {
  const preview = await loadMergePreview(null, "feature", "main");
  expect(preview.ahead.map((c) => c.id)).toEqual(["a2", "a1"]);
  expect(preview.behind).toBe(1);
  expect(preview.conflicts).toEqual(["src/b.ts"]);
});
