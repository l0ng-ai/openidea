import { afterEach, describe, expect, it, vi } from "vitest";
import { TestResults } from "./results";
import { clearTestStates, onTestStatesChanged, recordTestStates, testState } from "./states";

function run(events: Parameters<TestResults["apply"]>[0]) {
  const r = new TestResults();
  r.apply(events);
  r.finish(0);
  recordTestStates(r);
}

describe("test states for the run gutter", () => {
  afterEach(() => clearTestStates());

  it("matches Rust tests by module path under any crate suite", () => {
    run([
      { type: "result", path: ["src/lib.rs", "tests", "adds"], status: "passed" },
      { type: "result", path: ["src/lib.rs", "tests", "subs"], status: "failed" },
    ]);
    expect(testState({ path: ["tests", "adds"] })).toBe("passed");
    expect(testState({ path: ["tests", "subs"] })).toBe("failed");
    // The suite (`mod tests`) failed because one of its tests did.
    expect(testState({ path: ["tests"] })).toBe("failed");
    expect(testState({ path: ["tests", "other"] })).toBeNull();
  });

  it("matches JVM results named by qualified class and `method()`", () => {
    run([
      { type: "result", path: ["com.acme.OrderTest", "lists()"], status: "passed" },
      { type: "result", path: ["com.acme.OrderTest", "creates()"], status: "failed" },
    ]);
    expect(testState({ path: ["OrderTest", "lists"] })).toBe("passed");
    expect(testState({ path: ["OrderTest", "creates"] })).toBe("failed");
    expect(testState({ path: ["OrderTest"] })).toBe("failed");
  });

  it("checks the file for results rooted at it, and any parameter failing fails the test", () => {
    run([
      { type: "result", path: ["tests/test_math.py", "test_add[1]"], status: "passed" },
      { type: "result", path: ["tests/test_math.py", "test_add[2]"], status: "failed" },
      { type: "result", path: ["src/math.test.ts", "math", "adds"], status: "passed" },
    ]);
    expect(testState({ path: ["test_add"], file: "/work/app/tests/test_math.py" })).toBe("failed");
    expect(testState({ path: ["test_add"], file: "/work/app/other/test_math2.py" })).toBeNull();
    expect(testState({ path: ["math", "adds"], file: "/work/app/src/math.test.ts" })).toBe("passed");
  });

  it("matches unittest results rooted at the dotted module of the file", () => {
    run([
      { type: "result", path: ["polls.tests", "QuestionTests", "test_recent"], status: "failed" },
      { type: "result", path: ["polls.tests.test_views", "ViewTests", "test_ok"], status: "passed" },
      { type: "result", path: ["città.tests", "QTests", "test_a"], status: "passed" },
    ]);
    expect(testState({ path: ["QuestionTests", "test_recent"], file: "/work/app/polls/tests.py" })).toBe("failed");
    expect(testState({ path: ["QuestionTests"], file: "/work/app/polls/tests/__init__.py" })).toBe("failed");
    expect(testState({ path: ["QuestionTests", "test_recent"], file: "/work/app/blog/tests.py" })).toBeNull();
    expect(testState({ path: ["ViewTests", "test_ok"], file: "/work/app/polls/tests/test_views.py" })).toBe("passed");
    expect(testState({ path: ["QTests", "test_a"], file: "/work/app/città/tests.py" })).toBe("passed");
  });

  it("newer runs win and listeners hear about changes", () => {
    const listener = vi.fn();
    const off = onTestStatesChanged(listener);
    run([{ type: "result", path: ["pkg", "TestA"], status: "failed" }]);
    run([{ type: "result", path: ["pkg", "TestA"], status: "passed" }]);
    expect(testState({ path: ["TestA"] })).toBe("passed");
    expect(listener).toHaveBeenCalledTimes(2);
    // Unchanged results don't redraw the gutters.
    run([{ type: "result", path: ["pkg", "TestA"], status: "passed" }]);
    expect(listener).toHaveBeenCalledTimes(2);
    off();
  });
});
