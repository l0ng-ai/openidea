import { describe, expect, it } from "vitest";
import { where } from "./index";

describe("where", () => {
  it("shows installed fixtures below site-packages and the project's relative to it", () => {
    expect(where("/p/.venv/lib/python3.12/site-packages/_pytest/tmpdir.py", "/p")).toBe("_pytest/tmpdir.py");
    expect(where("/p/tests/conftest.py", "/p")).toBe("tests/conftest.py");
    expect(where("/elsewhere/conftest.py", "/p")).toBe("/elsewhere/conftest.py");
  });
});
