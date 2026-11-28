import { describe, expect, it } from "vitest";
import { celeryType } from "./celeryTypes";
import { formParams, missingParams, newConfigOfType, withParams } from "./types";

const make = (params: Record<string, string>) => {
  const c = newConfigOfType(celeryType, []);
  return withParams(c, { ...c.params, command: "python3", ...params }, celeryType);
};

describe("Celery configurations", () => {
  it("runs a worker on the app, with Beat when asked", () => {
    const c = make({ mode: "worker", app: "proj", beat: "true", options: "--loglevel INFO -P solo" });
    expect(c.command).toBe("python3");
    expect(c.args).toEqual(["-m", "celery", "-A", "proj", "worker", "-B", "--loglevel", "INFO", "-P", "solo"]);
    expect(c.isTest).toBeFalsy();
  });

  it("sends a task by module and name, the module standing in for the app", () => {
    const c = make({ mode: "call", module: "proj.tasks", task: "add", taskArgs: "[2, 3]", taskKwargs: '{"x": 1}' });
    expect(c.args).toEqual([
      "-m",
      "celery",
      "-A",
      "proj.tasks",
      "call",
      "proj.tasks.add",
      "--args",
      "[2, 3]",
      "--kwargs",
      '{"x": 1}',
    ]);
    const named = make({ mode: "call", app: "proj", task: "billing.charge", runnerArgs: "run python" });
    expect(named.args).toEqual(["run", "python", "-m", "celery", "-A", "proj", "call", "billing.charge"]);
  });

  it("rejects task args that are not a JSON list or object", () => {
    const c = make({ mode: "call", task: "add", taskArgs: "2, 3", taskKwargs: "[1]" });
    expect(Object.keys(missingParams(c, celeryType)).sort()).toEqual(["taskArgs", "taskKwargs"]);
    expect(missingParams(make({ mode: "call", task: "add", taskArgs: "[]" }), celeryType)).toEqual({});
  });

  it("reads a saved command line back into the form", () => {
    for (const params of <Record<string, string>[]>[
      { mode: "worker", app: "proj", beat: "true", options: "-l INFO" },
      { mode: "call", module: "proj.tasks", task: "add", taskArgs: "[1]" },
      { mode: "call", app: "proj", task: "custom.name" },
    ]) {
      const c = make(params);
      expect(formParams({ ...c, params: {} }, celeryType)).toMatchObject(params);
    }
  });
});
