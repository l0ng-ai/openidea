import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useProject } from "@/platform/project";
import { provideEditorService } from "@/workbench/contributions";
import { EndpointsHeaderActions, EndpointsView, useEndpointsView, useEndpointsViewOptions } from "./EndpointsView";
import { endpoint } from "./testEndpoint";
import type { EndpointProvider, ProviderState } from "./model";
import { registerEndpointProvider, useEndpoints } from "./store";

const run = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../http-client/store", () => ({ runRequest: run }));

const ROOT = "/p/app";
const MAIN = `${ROOT}/config/routes.rb`;
const ADMIN = `${ROOT}/config/routes/admin.rb`;

const ENDPOINTS = [
  endpoint("GET", "/photos", "photos#index", { name: "photos", line: 4, targetClass: "PhotosController" }),
  endpoint("GET", "/photos/:id", "photos#show", {
    name: "photo",
    line: 4,
    targetClass: "PhotosController",
    docs: [["Helper", "photo_path / photo_url"]],
  }),
  endpoint("GET", "/admin/stats", "admin/stats#index", {
    targetClass: "Admin::StatsController",
    file: ADMIN,
    line: 2,
  }),
];

/** A provider whose state the test sets. */
function fakeProvider(state: Partial<ProviderState>): {
  provider: EndpointProvider;
  set(s: Partial<ProviderState>): void;
} {
  let current: ProviderState = {
    endpoints: null,
    loading: false,
    loaded: true,
    error: null,
    diagnostics: [],
    ...state,
  };
  const listeners = new Set<() => void>();
  return {
    provider: {
      id: "test",
      framework: "Test",
      getState: () => current,
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      refresh: () => {},
    },
    set(s) {
      current = { ...current, ...s };
      listeners.forEach((l) => l());
    },
  };
}

const DIAGNOSTIC = { file: MAIN, line: 12, message: "`draw :missing`: config/routes/missing.rb not found" };

let dispose = () => {};

function setUp(state: Partial<ProviderState> = { endpoints: ENDPOINTS, diagnostics: [DIAGNOSTIC] }) {
  const fake = fakeProvider(state);
  act(() => {
    useProject.setState({ project: { root: ROOT, name: "app" } as never });
    dispose = registerEndpointProvider(fake.provider);
  });
  return fake;
}

describe("EndpointsView", () => {
  afterEach(() => {
    act(() => {
      dispose();
      useEndpoints.setState({ selectedId: null });
      useEndpointsView.setState({
        query: "",
        hiddenModules: new Set(),
        hiddenTypes: new Set(),
        hiddenFrameworks: new Set(),
        collapsed: new Set(),
        showDiagnostics: false,
        tab: "http",
        currentId: null,
      });
      useEndpointsViewOptions.setState({ groupByFile: false, autoscroll: false, details: true });
    });
    run.mockClear();
  });

  it("lists the endpoints under their module as `/path [METHOD]` with the handler class, and searches them", () => {
    setUp();
    render(<EndpointsView />);
    expect(screen.getByText("app")).toBeInTheDocument();
    expect(screen.getByText("/photos/:id")).toBeInTheDocument();
    expect(screen.getAllByText("[GET]")).toHaveLength(3);
    expect(screen.getByText("Admin::StatsController")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search endpoints"), { target: { value: "admin" } });
    expect(screen.queryByText("/photos/:id")).toBeNull();
    expect(screen.getByText("/admin/stats")).toBeInTheDocument();
  });

  it("offers the providers' frameworks and hides their endpoints when unchecked", () => {
    setUp();
    render(<EndpointsView />);
    fireEvent.click(screen.getByRole("button", { name: "Framework" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Test" }));
    expect(screen.queryByText("/photos/:id")).toBeNull();
    expect(screen.getByText("No endpoints match the filters")).toBeInTheDocument();
  });

  it("shows the selected endpoint's request in the HTTP Client tab and submits it", () => {
    setUp();
    render(<EndpointsView />);
    expect(screen.getByText("Select an endpoint")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByText("/photos/:id"), { button: 0 });
    expect(screen.getByRole("region", { name: "HTTP request" })).toHaveTextContent("GET http://localhost/photos/:id");
    // The gutter ▶ and the button below share the name; the button carries the text.
    fireEvent.click(screen.getByText("Submit Request"));
    expect(run).toHaveBeenCalledWith(null, expect.stringContaining("GET http://localhost/photos/:id"), 0);
    fireEvent.click(screen.getByRole("tab", { name: "Documentation" }));
    expect(screen.getByText("photo_path / photo_url")).toBeInTheDocument();
    expect(screen.getByText("config/routes.rb:4")).toBeInTheDocument();
  });

  it("groups by file and opens the declaration on activation", () => {
    const opened: { path: string; line: number }[] = [];
    provideEditorService({
      openFile: async (path: string, o?: { selection?: { line: number } }) =>
        void opened.push({ path, line: o?.selection?.line ?? -1 }),
    } as never);
    setUp();
    act(() => useEndpointsViewOptions.setState({ groupByFile: true }));
    render(<EndpointsView />);
    expect(screen.getByText("admin.rb")).toBeInTheDocument();
    expect(screen.getByText("1 endpoint")).toBeInTheDocument();
    fireEvent.doubleClick(screen.getByText("/admin/stats"));
    expect(opened).toEqual([{ path: ADMIN, line: 1 }]);
  });

  it("follows the provider's changes and shows the diagnostics when asked", () => {
    const fake = setUp();
    render(
      <>
        <EndpointsHeaderActions />
        <EndpointsView />
      </>,
    );
    expect(screen.queryByText(/missing\.rb not found/)).toBeNull();
    fireEvent.click(screen.getByLabelText("1 endpoint could not be read"));
    expect(
      screen.getByText("config/routes.rb:12: `draw :missing`: config/routes/missing.rb not found"),
    ).toBeInTheDocument();
    act(() => fake.set({ endpoints: ENDPOINTS.slice(0, 1), diagnostics: [] }));
    expect(screen.queryByText("/photos/:id")).toBeNull();
    expect(screen.getByText("/photos")).toBeInTheDocument();
  });

  it("explains an empty table", () => {
    setUp({ endpoints: null });
    render(<EndpointsView />);
    expect(screen.getByText("No endpoints in this project")).toBeInTheDocument();
    const fake = setUp({ endpoints: [] });
    expect(fake).toBeTruthy();
    expect(screen.getByText("No endpoints found")).toBeInTheDocument();
  });
});
