import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { useRemote } from "@/platform/remote";
import { validateSettings } from "@/features/settings/model/schema";
import { runServiceProvider } from "@/features/run/services";
import { useRun } from "@/features/run/store";
import { registerServiceProvider } from "@/workbench/contributions";
import { ServicesTreeView } from "./ServicesTree";
import { useServicesTree } from "./tree";

const config = (id: string, kind: string): RunConfig => ({
  id,
  name: id,
  kind,
  command: "java",
  args: [],
  cwd: null,
  env: {},
  detected: true,
  isTest: false,
  debugAdapter: null,
});
function project(root: string) {
  useProject.setState({ project: { root, name: "app", isGit: false, settings: validateSettings({}) } });
}
let dispose: Array<() => void>;
const dockerRoots = [{ key: "docker:one", label: "Docker", icon: "file-docker" }];
beforeEach(() => {
  localStorage.clear();
  project("/services");
  useRemote.setState({ session: null });
  useRun.setState({
    configs: [
      config("Gateway", "spring-boot"),
      config("Portal", "spring-boot"),
      config("Web", "npm"),
      config("Worker", "npm"),
    ],
    sessions: [],
  });
  localStorage.setItem("openidea.services.runTypes:/services", '["spring-boot","npm"]');
  useServicesTree.setState({
    roots: {},
    selectedKey: null,
    expanded: new Set(["run:type:spring-boot", "run:type:npm"]),
  });
  dispose = [
    registerServiceProvider(runServiceProvider),
    registerServiceProvider({
      id: "docker",
      order: 10,
      useRoots: () => dockerRoots,
    }),
  ];
});
afterEach(() => {
  dispose.forEach((f) => f());
  useProject.setState({ project: null });
  useRemote.setState({ session: null });
});
const tree = () => screen.getByRole("tree", { name: "Services" });
const names = () =>
  within(tree())
    .getAllByRole("treeitem")
    .map((el) => el.textContent);
const select = (text: string) => fireEvent.mouseDown(within(tree()).getByText(text).closest('[role="treeitem"]')!);

describe("service reordering integration", () => {
  it("moves detected configurations with accessible controls and retains order after reopening", () => {
    const original = useRun.getState().configs;
    const { unmount } = render(<ServicesTreeView />);
    select("Portal");
    fireEvent.click(screen.getByRole("button", { name: "Move Up" }));
    expect(names()).toEqual(["Spring Boot", "Portal", "Gateway", "npm", "Web", "Worker", "Docker"]);
    expect(useServicesTree.getState().selectedKey).toBe("run:config:Portal");
    expect(useRun.getState().configs).toBe(original);
    expect(screen.getByRole("button", { name: "Move Up" })).toBeDisabled();
    unmount();
    render(<ServicesTreeView />);
    expect(names()).toEqual(["Spring Boot", "Portal", "Gateway", "npm", "Web", "Worker", "Docker"]);
  });

  it("uses the same ordering for npm without enabling groups or Docker", () => {
    render(<ServicesTreeView />);
    select("Worker");
    fireEvent.click(screen.getByRole("button", { name: "Move Up" }));
    expect(names()).toEqual(["Spring Boot", "Gateway", "Portal", "npm", "Worker", "Web", "Docker"]);
    select("Docker");
    expect(screen.queryByRole("button", { name: "Move Up" })).toBeNull();
    select("Spring Boot");
    expect(screen.queryByRole("button", { name: "Move Up" })).toBeNull();
  });

  it("cancels an active drag when the project changes", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return new DOMRect(0, Number(this.dataset.row ?? 0) * 24, 400, this.dataset.row === undefined ? 600 : 24);
    });
    render(<ServicesTreeView />);
    const source = within(tree()).getByText("Portal").closest('[role="treeitem"]')!;
    const target = within(tree()).getByText("Gateway").closest('[role="treeitem"]')!;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target });
    const pointer = (el: Element | Window, type: string, y: number) =>
      fireEvent(el, new MouseEvent(type, { bubbles: true, button: 0, clientX: 70, clientY: y }));
    pointer(source, "pointerdown", 60);
    pointer(window, "pointermove", 26);
    expect(document.querySelector('[aria-hidden="true"][role="treeitem"]')).not.toBeNull();
    act(() => project("/other"));
    pointer(window, "pointerup", 26);
    expect(document.querySelector('[aria-hidden="true"][role="treeitem"]')).toBeNull();
    expect(localStorage.getItem("openidea.services.runOrder:/other")).toBeNull();
    expect(localStorage.getItem("openidea.services.runOrder:/services")).toBeNull();
    vi.restoreAllMocks();
  });

  it("isolates local and remote projects that share the same root", () => {
    render(<ServicesTreeView />);
    select("Portal");
    fireEvent.click(screen.getByRole("button", { name: "Move Up" }));
    act(() => useRemote.setState({ session: { root: "/services", sshConfig: "host", host: "host", commands: [] } }));
    expect(names()).toEqual(["Spring Boot", "Gateway", "Portal", "npm", "Web", "Worker", "Docker"]);
    act(() => useRemote.setState({ session: null }));
    expect(names()).toEqual(["Spring Boot", "Portal", "Gateway", "npm", "Web", "Worker", "Docker"]);
  });
});
