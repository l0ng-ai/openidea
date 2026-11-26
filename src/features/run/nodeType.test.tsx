import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { RunConfig } from "@/platform/ipc";
import { runConfigTypes } from "@/workbench/contributions";
import { typeRows } from "./AddConfigPopup";
import { ConfigForm } from "./ConfigForm";
import {
  formParams,
  missingParams,
  newConfigOfType,
  registerBuiltinTypes,
  splitNodeArgs,
  typeFor,
  withParams,
} from "./types";

const nodeConfig = (extra: Partial<RunConfig> = {}): RunConfig => ({
  id: "n",
  name: "n",
  kind: "node",
  command: "node",
  args: [],
  cwd: null,
  env: {},
  detected: false,
  isTest: false,
  debugAdapter: "js-debug",
  ...extra,
});

let dispose: () => void;
beforeEach(() => (dispose = registerBuiltinTypes()));
afterEach(() => dispose());

describe("Node.js configuration type (#6085)", () => {
  it("is listed in Add Configuration and builds node <options> <file> <arguments>", () => {
    expect(typeRows(runConfigTypes(), "").some((r) => r.kind === "type" && r.type.id === "node")).toBe(true);
    const type = typeFor("node")!;
    const blank = newConfigOfType(type, []);
    expect(blank).toMatchObject({ kind: "node", debugAdapter: "js-debug" });
    expect(missingParams(blank)).toEqual({ file: "JavaScript file is required" });
    const c = withParams(
      { ...blank, cwd: "server" },
      { nodeOptions: "--env-file=.env", file: "main.js", arguments: "--port 3000" },
    );
    expect(c).toMatchObject({
      command: "node",
      args: ["--env-file=.env", "main.js", "--port", "3000"],
      cwd: "server",
    });
    expect(withParams(c, { ...c.params, interpreter: "/opt/node22/bin/node" }).command).toBe("/opt/node22/bin/node");
  });

  it("opens an imported or older node configuration in the form", () => {
    // What the VS Code / JetBrains importers write: no params, just the command line.
    const imported = nodeConfig({ args: ["-r", "./setup.js", "--inspect", "/p/app.js", "x"], cwd: "srv" });
    expect(formParams(imported)).toEqual({ nodeOptions: "-r ./setup.js --inspect", file: "/p/app.js", arguments: "x" });
    const change = vi.fn();
    render(
      <ConfigForm
        config={{ ...imported, env: { NODE_ENV: "dev" } }}
        all={[]}
        type={typeFor("node")}
        errors={{}}
        onChange={change}
        modifyRequest={0}
      />,
    );
    expect(screen.getByLabelText("Node options")).toHaveValue("-r ./setup.js --inspect");
    expect(screen.getByLabelText("JavaScript file")).toHaveValue("/p/app.js");
    expect(screen.getByLabelText("Application arguments")).toHaveValue("x");
    expect(screen.getByLabelText("Working directory")).toHaveValue("srv");
    expect(screen.getByLabelText("Environment variables")).toHaveValue("NODE_ENV=dev");
    fireEvent.change(screen.getByLabelText("Node options"), { target: { value: "--max-old-space-size=4096" } });
    expect(change.mock.calls.at(-1)?.[0]).toMatchObject({
      command: "node",
      args: ["--max-old-space-size=4096", "/p/app.js", "x"],
      cwd: "srv",
    });
  });

  it("leaves command lines it can't reproduce as plain commands", () => {
    expect(formParams(nodeConfig({ command: "npx", args: ["tsx", "a.ts"] }))).toBeNull();
    expect(formParams(nodeConfig({ args: ["--test"] }))).toBeNull();
    expect(formParams(nodeConfig({ args: ["-e", "console.log(1)"] }))).toBeNull();
    expect(formParams(nodeConfig({ command: "npx", args: ["jest"], isTest: true }))).toBeNull();
    expect(formParams(nodeConfig({ args: ["--test", "a.test.js"], isTest: true }))).toBeNull();
  });

  it("splits Node options from the file and its arguments", () => {
    expect(splitNodeArgs(["--env-file", ".env", "a.js", "-v"])).toEqual([["--env-file", ".env"], "a.js", ["-v"]]);
    expect(splitNodeArgs(["--inspect-brk=9230", "a.js"])).toEqual([["--inspect-brk=9230"], "a.js", []]);
    expect(splitNodeArgs(["--test"])).toEqual([["--test"], null, []]);
  });
});
