import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DataSource, DbJdbcDriver } from "@/platform/ipc";
import { SourceDialog } from "./SourceDialog";
import { JdbcDriverProfiles } from "./JdbcDriverProfiles";
import { newMenu, nodeMenu } from "./treeMenu";
import { useDatabase } from "./store";

const backend = vi.hoisted(() => ({ call: vi.fn(), saveSource: vi.fn(), pick: vi.fn() }));
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  const request =
    (name: string) =>
    (...args: unknown[]) => [name, ...args];
  return {
    ...real,
    call: backend.call,
    commands: {
      ...real.commands,
      dbJdbcDrivers: request("list"),
      dbJdbcDriverClasses: request("classes"),
      dbApproveJdbcSource: request("approve"),
      dbSaveJdbcDriver: request("save"),
      dbRemoveJdbcDriver: request("remove"),
      dbTest: request("test"),
    },
  };
});
vi.mock("./store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./store")>()),
  saveSource: backend.saveSource,
}));
vi.mock("@/platform/dialog", () => ({ open: backend.pick }));

const driver: DbJdbcDriver = {
  id: "example-driver",
  name: "Example JDBC",
  jars: ["/local/example-driver.jar", "/local/dependency.jar"],
  className: "org.example.jdbc.Driver",
  urlTemplate: "jdbc:example://<host>:<port>/<database>",
};

function select(label: string, option: string) {
  fireEvent.click(screen.getByRole("button", { name: label }));
  fireEvent.click(within(screen.getByRole("listbox")).getByText(option, { exact: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  backend.call.mockImplementation(async ([command]: [string]) =>
    command === "list" ? [driver] : command === "classes" ? [] : "Example database",
  );
  backend.saveSource.mockResolvedValue(undefined);
  backend.pick.mockResolvedValue(driver.jars);
  useDatabase.setState({ sources: [], dialog: null, loaded: true });
});

describe("custom JDBC data sources", () => {
  it("expands the selected profile's URL template for testing and saving, and keeps a manual URL editable", async () => {
    const first = { ...driver, urlTemplate: "jdbc:example://{host}:{port}/{database}" };
    const second = { ...driver, id: "duck", name: "DuckDB", urlTemplate: "jdbc:duckdb:{file}" };
    backend.call.mockImplementation(async ([op]) => (op === "list" ? [first, second] : "OK"));
    render(<SourceDialog initial={null} preset={{ driver: "jdbc" }} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "JDBC driver profile" })).toBeEnabled());
    select("JDBC driver profile", first.name);
    const test = screen.getByRole("button", { name: "Test Connection" });
    expect(test).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Host:"), { target: { value: "localhost" } });
    fireEvent.change(screen.getByLabelText("Port:"), { target: { value: "5433" } });
    fireEvent.change(screen.getByLabelText("Database:"), { target: { value: "sample" } });
    expect(screen.getByLabelText("URL:")).toHaveValue("jdbc:example://localhost:5433/sample");
    fireEvent.click(test);
    await screen.findByText("Succeeded: OK");
    expect(backend.call).toHaveBeenCalledWith([
      "test",
      expect.objectContaining({ url: "jdbc:example://localhost:5433/sample" }),
      null,
      null,
    ]);
    select("JDBC driver profile", second.name);
    fireEvent.change(screen.getByLabelText("File:"), { target: { value: "/tmp/example.db" } });
    expect(screen.getByLabelText("URL:")).toHaveValue("jdbc:duckdb:/tmp/example.db");
    fireEvent.change(screen.getByLabelText("URL:"), { target: { value: "jdbc:duckdb:" } });
    expect(screen.queryByLabelText("File:")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use URL template" }));
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    await waitFor(() =>
      expect(backend.saveSource).toHaveBeenCalledWith(
        expect.objectContaining({ url: "jdbc:duckdb:/tmp/example.db" }),
        undefined,
        undefined,
      ),
    );
  });

  it("tests a read-only JDBC source and preserves the option on save", async () => {
    render(
      <SourceDialog initial={{ driver: "jdbc", jdbcDriver: driver.id, url: "jdbc:example:local", readOnly: true }} />,
    );
    const test = screen.getByRole("button", { name: "Test Connection" });
    await waitFor(() => expect(test).toBeEnabled());
    fireEvent.click(test);
    await waitFor(() =>
      expect(backend.call).toHaveBeenCalledWith(["test", expect.objectContaining({ readOnly: true }), null, null]),
    );
    fireEvent.click(screen.getByRole("tab", { name: "Options" }));
    expect(screen.getByRole("checkbox", { name: "Read-only" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    await waitFor(() =>
      expect(backend.saveSource).toHaveBeenCalledWith(
        expect.objectContaining({ readOnly: true }),
        undefined,
        undefined,
      ),
    );
  });

  it("offers Custom JDBC in the new data source menu", () => {
    const dataSource = newMenu().find((item) => "label" in item && item.label === "Data Source");
    expect(dataSource && "submenu" in dataSource && dataSource.submenu).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "Custom JDBC" })]),
    );
  });

  it("requires a profile and explicit URL, and keeps driver code out of source configuration", async () => {
    render(<SourceDialog initial={null} preset={{ driver: "jdbc" }} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "JDBC driver profile" })).toBeEnabled());
    const test = screen.getByRole("button", { name: "Test Connection" });
    expect(test).toBeDisabled();
    select("JDBC driver profile", driver.name);
    expect(screen.getByLabelText("URL:")).toHaveValue(driver.urlTemplate);
    expect(screen.getByLabelText("URL:")).toHaveAttribute("placeholder", driver.urlTemplate);
    expect(test).toBeDisabled();
    expect(screen.queryByRole("tab", { name: "SSH/SSL" })).toBeNull();
    expect(screen.queryByLabelText("Host:")).toBeNull();
    fireEvent.change(screen.getByLabelText("URL:"), { target: { value: "https://example.invalid" } });
    expect(test).toBeDisabled();
    const url = "jdbc:example://example.invalid/catalog?ssl=true&setting=a%20b";
    fireEvent.change(screen.getByLabelText("URL:"), { target: { value: url } });
    fireEvent.change(screen.getByLabelText("User:"), { target: { value: "reader" } });
    fireEvent.change(screen.getByLabelText("Password:"), { target: { value: "typed secret" } });
    fireEvent.click(screen.getByRole("tab", { name: "Options" }));
    expect(screen.queryByRole("button", { name: "Transaction control" })).toBeNull();
    expect(screen.queryByLabelText("Time zone:")).toBeNull();
    expect(screen.queryByLabelText("Startup script:")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Advanced" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Property" }));
    fireEvent.change(screen.getByLabelText("Property name"), { target: { value: "ssl" } });
    fireEvent.change(screen.getByLabelText("Property value"), { target: { value: "true" } });
    fireEvent.click(test);
    await screen.findByText("Succeeded: Example database");
    const request = backend.call.mock.calls.find(([request]) => request[0] === "test")![0];
    expect(request).toEqual([
      "test",
      expect.objectContaining({
        driver: "jdbc",
        jdbcDriver: driver.id,
        url,
        user: "reader",
        properties: [{ name: "ssl", value: "true" }],
      }),
      "typed secret",
      null,
    ]);
    for (const key of ["jars", "className", "classpath", "exec", "password"])
      expect(request[1]).not.toHaveProperty(key);
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    await waitFor(() =>
      expect(backend.saveSource).toHaveBeenCalledWith(
        expect.objectContaining({ driver: "jdbc", jdbcDriver: driver.id, url }),
        "typed secret",
        undefined,
      ),
    );
  });

  it("keeps an existing password unchanged and blocks a missing driver profile", async () => {
    render(<SourceDialog initial={{ driver: "jdbc", jdbcDriver: "missing", url: "jdbc:example:local" }} />);
    await screen.findByText("The JDBC driver profile is missing. Select or add a profile before connecting.");
    expect(screen.getByRole("button", { name: "OK" })).toBeDisabled();
    expect(screen.getByLabelText("Password:")).toHaveAttribute("placeholder", "<unchanged>");
    select("JDBC driver profile", driver.name);
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    await waitFor(() => expect(backend.saveSource).toHaveBeenCalledWith(expect.anything(), undefined, undefined));
  });

  it("requires explicit security configuration after switching from native ClickHouse and restores native settings", async () => {
    const source: DataSource = {
      driver: "clickhouse",
      name: "Secure native",
      host: "example.invalid",
      ssl: "verifyFull",
      sslCaFile: "/local/ca.pem",
      sslCertFile: "/local/client.pem",
      sslKeyFile: "/local/client.key",
      urlOnly: true,
      url: "https://example.invalid:8443/default",
      properties: [{ name: "max_threads", value: "2" }],
    };
    render(<SourceDialog initial={source} />);
    select("Data source type", "Custom JDBC");
    await waitFor(() => expect(screen.getByRole("button", { name: "JDBC driver profile" })).toBeEnabled());
    select("JDBC driver profile", driver.name);
    expect(screen.getByLabelText("URL:")).toHaveValue(driver.urlTemplate);
    fireEvent.change(screen.getByLabelText("URL:"), { target: { value: "jdbc:example://example.invalid?ssl=true" } });
    expect(screen.getByRole("button", { name: "Test Connection" })).toBeDisabled();
    fireEvent.click(screen.getByRole("tab", { name: "Advanced" }));
    expect(screen.queryByLabelText("Property name")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "General" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "I have configured JDBC connection security." }));
    expect(screen.getByRole("button", { name: "Test Connection" })).toBeEnabled();
    select("Data source type", "ClickHouse");
    expect(screen.getByLabelText("URL:")).toHaveValue(source.url!);
    fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
    await waitFor(() =>
      expect(backend.call).toHaveBeenCalledWith(["test", expect.objectContaining(source), null, null]),
    );
  });

  it("shows driver-list failures and retries without allowing a connection", async () => {
    backend.call.mockRejectedValueOnce(new Error("Cannot read local profiles"));
    render(<SourceDialog initial={null} preset={{ driver: "jdbc" }} />);
    await screen.findByText("Cannot read local profiles");
    expect(screen.getByRole("button", { name: "Test Connection" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Manage Drivers…" })).toBeEnabled());
  });

  it("hides vendor-specific editing from JDBC tree nodes", () => {
    useDatabase.setState({ sources: [{ id: "jdbc-source", driver: "jdbc" }] });
    const menu = nodeMenu({ kind: "schema", id: "jdbc-source", key: "schema", schema: "PUBLIC" });
    expect(menu).not.toEqual(expect.arrayContaining([expect.objectContaining({ action: "db.drop" })]));
    expect(menu).not.toEqual(expect.arrayContaining([expect.objectContaining({ action: "db.compareSchemas" })]));
  });
});

describe("local JDBC driver profiles", () => {
  it("validates profiles, selects dependency JARs and requires trust before saving", async () => {
    const saved = vi.fn();
    render(<JdbcDriverProfiles drivers={[]} selected="" onSave={saved} onRemove={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Add…" }));
    expect(
      screen.getByText("Use {host}, {port}, {database} or {file} for fields on the connection form."),
    ).toBeVisible();
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Name:"), { target: { value: "Example JDBC" } });
    fireEvent.change(screen.getByLabelText("Driver class:"), { target: { value: "Driver" } });
    fireEvent.click(screen.getByRole("button", { name: "Add JARs…" }));
    await screen.findByTitle(driver.jars[1]!);
    expect(backend.pick).toHaveBeenCalledWith(
      expect.objectContaining({ multiple: true, filters: [{ name: "Java archives", extensions: ["jar"] }] }),
    );
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Driver class:"), { target: { value: driver.className } });
    fireEvent.change(screen.getByLabelText("URL template:"), { target: { value: driver.urlTemplate } });
    fireEvent.click(save);
    const trust = screen.getByRole("dialog", { name: "Trust JDBC Driver?" });
    expect(trust).toHaveTextContent("execute local code with your user permissions");
    for (const jar of driver.jars) expect(within(trust).getByText(jar)).toBeVisible();
    expect(backend.call.mock.calls.some(([[command]]) => command === "save")).toBe(false);
    fireEvent.click(within(trust).getByRole("button", { name: "Cancel" }));
    expect(saved).not.toHaveBeenCalled();
    fireEvent.click(save);
    fireEvent.click(screen.getByRole("button", { name: "Trust and Save" }));
    await waitFor(() => expect(saved).toHaveBeenCalledWith({ ...driver, id: expect.any(String) }));
  });

  it("edits and deletes profiles through IPC and invalidates a deleted source reference", async () => {
    render(<SourceDialog initial={{ driver: "jdbc", jdbcDriver: driver.id, url: "jdbc:example:local" }} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Manage Drivers…" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Manage Drivers…" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit…" }));
    fireEvent.change(within(screen.getByRole("dialog", { name: "Edit JDBC Driver" })).getByLabelText("Name:"), {
      target: { value: "Renamed driver" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Trust and Save" }));
    await waitFor(() => expect(backend.call).toHaveBeenCalledWith(["save", { ...driver, name: "Renamed driver" }]));
    await screen.findByRole("dialog", { name: "JDBC Driver Profiles" });
    fireEvent.click(screen.getByRole("button", { name: "Delete…" }));
    expect(screen.getByRole("dialog", { name: "Delete JDBC Driver?" })).toHaveTextContent(
      "Data sources using it will need another driver profile.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(backend.call).toHaveBeenCalledWith(["remove", driver.id]));
    fireEvent.click(within(screen.getByRole("dialog", { name: "JDBC Driver Profiles" })).getByText("Close"));
    await screen.findByText("The JDBC driver profile is missing. Select or add a profile before connecting.");
    expect(screen.getByRole("button", { name: "OK" })).toBeDisabled();
  });

  it("keeps a failed profile edit available for correction and retry", async () => {
    const saved = vi.fn();
    backend.call.mockRejectedValueOnce(new Error("Driver JAR cannot be read"));
    render(
      <JdbcDriverProfiles
        drivers={[driver]}
        selected={driver.id}
        onSave={saved}
        onRemove={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit…" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Trust and Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Driver JAR cannot be read");
    expect(screen.getByLabelText("Driver class:")).toHaveValue(driver.className);
    expect(saved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Trust and Save" }));
    await waitFor(() => expect(saved).toHaveBeenCalledWith(driver));
  });

  it("deduplicates picked JARs and lets users remove a dependency", async () => {
    backend.pick.mockResolvedValue([driver.jars[0], driver.jars[1], driver.jars[0]]);
    render(
      <JdbcDriverProfiles
        drivers={[driver]}
        selected={driver.id}
        onSave={vi.fn()}
        onRemove={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit…" }));
    fireEvent.click(screen.getByRole("button", { name: "Add JARs…" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Add JARs…" })).toBeEnabled());
    expect(screen.getAllByTitle(driver.jars[0]!)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: `Remove JAR ${driver.jars[1]}` }));
    expect(screen.queryByTitle(driver.jars[1]!)).toBeNull();
  });
});
