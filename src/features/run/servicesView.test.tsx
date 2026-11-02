import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const started = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("./store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./store")>()),
  startRun: vi.fn(async (config: { id: string }) => {
    started.calls.push(config.id);
    return null;
  }),
}));

import type { RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { registerServiceProvider } from "@/workbench/contributions";
import { ServicesTreeView } from "@/features/services/ServicesTree";
import { runServiceProvider } from "./services";
import { resetRuns, useRun } from "./store";
import { registerBuiltinTypes } from "./types";

const app = (module: string): RunConfig => ({
  id: `application:${module}:com.acme.Application`,
  name: "Application",
  kind: "spring-boot",
  command: "java",
  args: ["-cp", "${classpath}", "com.acme.Application"],
  cwd: module,
  env: {},
  detected: true,
  isTest: false,
  debugAdapter: "java-debug",
});

/** The rows of the Services tree, in order. */
const rows = () => [...document.querySelectorAll<HTMLElement>("[data-row]")];
const row = (label: string) => rows().find((r) => r.textContent?.includes(label))!;

let disposeTypes: () => void;
let disposeProvider: () => void;
beforeEach(() => {
  started.calls = [];
  resetRuns();
  localStorage.clear();
  disposeTypes = registerBuiltinTypes();
  disposeProvider = registerServiceProvider(runServiceProvider);
  useProject.setState({ project: { root: "/svc" } as never });
  useRun.setState({ configs: [app("svc-a"), app("svc-b")], loaded: true });
});
afterEach(() => {
  cleanup();
  disposeProvider();
  disposeTypes();
  useProject.setState({ project: null });
});

it("starts every selected configuration with one toolbar Run", () => {
  render(<ServicesTreeView />);
  // Same-named applications of two modules are told apart by their module.
  expect(row("Application (svc-a)")).toBeTruthy();
  expect(row("Application (svc-b)")).toBeTruthy();

  fireEvent.mouseDown(row("Application (svc-a)"), { button: 0 });
  fireEvent.mouseDown(row("Application (svc-b)"), { button: 0, ctrlKey: true });
  // Both rows stay selected; the toolbar's Run is for both.
  fireEvent.click(screen.getByLabelText("Run"));
  expect(started.calls).toEqual(["application:svc-a:com.acme.Application", "application:svc-b:com.acme.Application"]);
});

it("runs only the selected configuration", () => {
  render(<ServicesTreeView />);
  fireEvent.mouseDown(row("Application (svc-b)"), { button: 0 });
  fireEvent.click(screen.getByLabelText("Run"));
  expect(started.calls).toEqual(["application:svc-b:com.acme.Application"]);
});
