import { describe, expect, it } from "vitest";
import type { FileMatches } from "@/platform/ipc";
import { findRubyTest, type RubySearch } from "./rubyTests";

const file = (path: string, ...lines: number[]): FileMatches => ({
  path,
  relPath: path.slice(1),
  matches: lines.map((line) => ({ line, text: "", ranges: [], textOffset: 0 })),
});

/** A search over fixed hits: the first matching pattern fragment wins. */
function fake(hits: Record<string, FileMatches[]>): RubySearch & { calls: [string, string[] | undefined][] } {
  const calls: [string, string[] | undefined][] = [];
  const fn = (async (pattern: string, files?: string[]) => {
    calls.push([pattern, files]);
    const key = Object.keys(hits).find((k) => pattern.includes(k));
    const found = key ? hits[key]! : [];
    return files ? found.filter((f) => files.includes(f.path)) : found;
  }) as RubySearch & { calls: [string, string[] | undefined][] };
  fn.calls = calls;
  return fn;
}

describe("finding a Minitest test's source", () => {
  it("the def inside the file that declares the class", async () => {
    const search = fake({
      "(class|module)": [file("/p/test/a_test.rb", 0), file("/p/test/b_test.rb", 0)],
      "def\\s+test_init": [file("/p/test/a_test.rb", 11), file("/p/test/b_test.rb", 4)],
    });
    // Only b declares TestB: its def wins even though a's file sorts first.
    const owners = fake({
      "(class|module)": [file("/p/test/b_test.rb", 0)],
      "def\\s+test_init": [file("/p/test/a_test.rb", 11), file("/p/test/b_test.rb", 4)],
    });
    expect(await findRubyTest(owners, "TestB", "test_initialize")).toEqual({ path: "/p/test/b_test.rb", line: 5 });
    expect(await findRubyTest(search, "TestA", "test_initialize")).toEqual({ path: "/p/test/a_test.rb", line: 12 });
  });

  it("looks for the last segment of a namespaced class", async () => {
    const search = fake({
      InnerTest: [file("/p/test/n_test.rb", 3)],
      "def\\s+test_nested": [file("/p/test/n_test.rb", 4)],
    });
    expect(await findRubyTest(search, "Outer::InnerTest", "test_nested")).toEqual({
      path: "/p/test/n_test.rb",
      line: 5,
    });
    expect(search.calls[0]![0]).not.toContain("Outer");
  });

  it("spec-style tests: the it block of the describe, underscores for spaces", async () => {
    const search = fake({
      describe: [file("/p/spec/x_test.rb", 0)],
      "does[ _]a[ _]thing": [file("/p/spec/x_test.rb", 6)],
    });
    expect(await findRubyTest(search, "Spec style", "test_0001_does_a_thing")).toEqual({
      path: "/p/spec/x_test.rb",
      line: 7,
    });
  });

  it("falls back to the class when the method is not found, and to nothing when nothing is", async () => {
    const onlyClass = fake({ "(class|module)": [file("/p/test/a_test.rb", 2)] });
    expect(await findRubyTest(onlyClass, "TestA", "test_dynamic")).toEqual({ path: "/p/test/a_test.rb", line: 3 });
    expect(await findRubyTest(fake({}), "TestA", "test_x")).toBeNull();
  });
});
