import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DataSource, DbJdbcDriver, ProjectInfo } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { SourceDialog } from "./SourceDialog";
import { JdbcDriverProfiles } from "./JdbcDriverProfiles";
import { sourceIcon, sourceLabel } from "./model";
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

function select(label: string, option: string, root: Pick<typeof screen, "getByRole"> = screen) {
  fireEvent.click(root.getByRole("button", { name: label }));
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
  useProject.setState({ project: null });
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

describe("JDBC drivers for named database types", () => {
  it("keeps an incompatible profile available to repair while blocking the saved source", async () => {
    render(
      <SourceDialog initial={{ driver: "jdbc", vendor: "neon", jdbcDriver: driver.id, url: "jdbc:example:local" }} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Select a matching profile or update its type.");
    expect(screen.getByRole("button", { name: "Test Connection" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Go to Driver" }));
    const profiles = within(screen.getByRole("dialog", { name: "JDBC Driver Profiles" }));
    expect(profiles.getByRole("button", { name: "JDBC driver profiles" })).toHaveTextContent(driver.name);
    expect(profiles.getByText("Custom JDBC only")).toBeVisible();
    expect(profiles.queryByRole("button", { name: "Use Driver" })).toBeNull();
  });

  it("associates an existing profile with a wire-compatible preset and reopens it with that type", async () => {
    const pg = { ...driver, id: "pg", name: "PostgreSQL JDBC", vendor: "postgres" };
    backend.call.mockImplementation(async ([op]) => (op === "list" ? [pg, driver] : "OK"));
    const { unmount } = render(
      <SourceDialog
        initial={{
          id: "neon-example",
          name: "Neon example",
          driver: "postgres",
          vendor: "neon",
          host: "example.invalid",
          ssl: "verifyFull",
          sslCaFile: "/local/ca.pem",
          urlOnly: true,
          url: "postgresql://reader:url-fixture@example.invalid:5432/catalog?sslmode=verify-full",
          savePassword: true,
        }}
      />,
    );
    const driverButton = screen.getByRole("button", { name: "Connection driver" });
    expect(driverButton).toHaveTextContent("Built-in");
    const manage = screen.getByRole("button", { name: "Manage Drivers…" });
    await waitFor(() => expect(manage).toBeEnabled());
    fireEvent.click(driverButton);
    const choices = within(screen.getByRole("listbox"));
    expect(choices.getAllByRole("option")).toHaveLength(1);
    fireEvent.click(choices.getByRole("option", { name: "Built-in" }));
    fireEvent.click(manage);
    select("JDBC driver profiles", driver.name);
    expect(screen.queryByRole("button", { name: "Use Driver" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit…" }));
    const editor = within(screen.getByRole("dialog", { name: "Edit JDBC Driver" }));
    select("Data source type", "Neon", editor);
    fireEvent.click(editor.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Trust and Save" }));
    const useDriver = await screen.findByRole("button", { name: "Use Driver" });
    expect(backend.call).toHaveBeenCalledWith(["save", { ...driver, vendor: "neon" }]);
    fireEvent.click(useDriver);
    expect(screen.getByRole("button", { name: "Data source type" })).toHaveTextContent("Neon");
    expect(driverButton).toHaveTextContent(driver.name);
    expect(screen.queryByRole("tab", { name: "SSH/SSL" })).toBeNull();
    expect(screen.getByLabelText("User:")).toHaveValue("reader");
    expect(
      screen.getByText("If the connection used a password in the previous URL, enter it in the Password field."),
    ).toBeVisible();
    const jdbcUrl = "jdbc:example://example.invalid/catalog?ssl=true";
    fireEvent.change(screen.getByLabelText("URL:"), { target: { value: jdbcUrl } });
    const save = screen.getByRole("button", { name: "OK" });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "I have configured JDBC connection security." }));
    fireEvent.click(save);
    await waitFor(() =>
      expect(backend.saveSource).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "neon-example",
          driver: "jdbc",
          vendor: "neon",
          jdbcDriver: driver.id,
          url: jdbcUrl,
          user: "reader",
          savePassword: true,
        }),
        undefined,
        undefined,
      ),
    );
    const saved: DataSource = backend.saveSource.mock.calls[0]![0];
    expect(sourceIcon(saved)).toBe("db-neon");
    expect(sourceLabel(saved)).toBe("Neon example (Neon)");
    unmount();
    backend.call.mockImplementation(async ([op]) =>
      op === "list"
        ? [
            { ...pg, vendor: "neon", urlTemplate: "jdbc:example://localhost/readonly" },
            { ...driver, vendor: "neon", urlTemplate: "jdbc:example://{host}/{database}?ssl=true" },
          ]
        : "OK",
    );
    render(<SourceDialog initial={saved} />);
    expect(screen.getByRole("button", { name: "Data source type" })).toHaveTextContent("Neon");
    fireEvent.click(await screen.findByRole("button", { name: "Go to Driver" }));
    const profiles = within(screen.getByRole("dialog", { name: "JDBC Driver Profiles" }));
    expect(profiles.getByRole("button", { name: "JDBC driver profiles" })).toHaveTextContent(driver.name);
    expect(profiles.getByText("dependency.jar")).toBeVisible();
    fireEvent.click(profiles.getByText("Close", { exact: true }));
    select("Connection driver", pg.name);
    expect(screen.getByLabelText("URL:")).toHaveValue(jdbcUrl);
    expect(screen.getByRole("button", { name: "Use URL template" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Test Connection" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "I have configured JDBC connection security." }));
    expect(screen.getByRole("button", { name: "Test Connection" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Use URL template" }));
    expect(screen.getByLabelText("URL:")).toHaveValue("jdbc:example://localhost/readonly");
    expect(screen.getByRole("button", { name: "Test Connection" })).toBeDisabled();
  });

  const sqlite = { ...driver, name: "Xerial SQLite", vendor: "sqlite", urlTemplate: "jdbc:sqlite:{file}" };

  it.each([
    ["/fixture/project", "fixtures/local.db", "/fixture/project/fixtures/local.db"],
    ["D:/fixture/project", "fixtures\\local.db", "D:/fixture/project/fixtures/local.db"],
    ["//fixture/project", "fixtures\\local.db", "//fixture/project/fixtures/local.db"],
  ])("uses a SQLite file relative to %s and restores its native path", async (root, file, absolute) => {
    useProject.setState({ project: { root } as ProjectInfo });
    backend.call.mockImplementation(async ([op]) => (op === "list" ? [sqlite] : "SQLite"));
    render(<SourceDialog initial={null} preset={{ driver: "sqlite", file }} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Manage Drivers…" })).toBeEnabled());
    select("Connection driver", sqlite.name);
    const url = `jdbc:sqlite:${absolute}`;
    expect(screen.getByLabelText("File:")).toHaveValue(absolute);
    expect(screen.getByLabelText("URL:")).toHaveValue(url);
    fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
    await waitFor(() =>
      expect(backend.call).toHaveBeenCalledWith([
        "test",
        expect.objectContaining({ driver: "jdbc", vendor: "sqlite", url }),
        null,
        null,
      ]),
    );
    select("Connection driver", "Built-in");
    expect(screen.getByLabelText("File:")).toHaveValue(file);
    expect(screen.getByRole("button", { name: "Test Connection" })).toBeEnabled();
  });

  it("requires a fresh file choice for a Windows drive-relative path", async () => {
    useProject.setState({ project: { root: "D:/fixture/project" } as ProjectInfo });
    backend.call.mockImplementation(async ([op]) => (op === "list" ? [sqlite] : "SQLite"));
    render(<SourceDialog initial={null} preset={{ driver: "sqlite", file: "D:local.db" }} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Manage Drivers…" })).toBeEnabled());
    select("Connection driver", sqlite.name);
    expect(screen.getByLabelText("File:")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Test Connection" })).toBeDisabled();
  });

  it("keeps shared source options and restores the native draft's password", async () => {
    const pg = { ...driver, name: "PostgreSQL JDBC", vendor: "postgres", urlTemplate: "jdbc:example:local" };
    backend.call.mockImplementation(async ([op]) => (op === "list" ? [pg] : "OK"));
    render(<SourceDialog initial={{ driver: "postgres", user: "native", options: { autoDisconnectSecs: 90 } }} />);
    fireEvent.change(screen.getByLabelText("Password:"), { target: { value: "native-fixture" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Manage Drivers…" })).toBeEnabled());
    select("Connection driver", pg.name);
    expect(screen.getByRole("button", { name: "Test Connection" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("User:"), { target: { value: "jdbc" } });
    fireEvent.change(screen.getByLabelText("Password:"), { target: { value: "jdbc-fixture" } });
    fireEvent.click(screen.getByRole("tab", { name: "Options" }));
    expect(screen.getByLabelText("Auto-disconnect after (seconds)")).toHaveValue("90");
    fireEvent.change(screen.getByLabelText("Auto-disconnect after (seconds)"), { target: { value: "60" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Read-only" }));
    fireEvent.click(screen.getByRole("tab", { name: "General" }));
    select("Connection driver", "Built-in");
    expect(screen.getByLabelText("User:")).toHaveValue("native");
    expect(screen.getByLabelText("Password:")).toHaveValue("native-fixture");
    fireEvent.click(screen.getByRole("tab", { name: "Options" }));
    expect(screen.getByRole("checkbox", { name: "Read-only" })).toBeChecked();
    expect(screen.getByLabelText("Auto-disconnect after (seconds)")).toHaveValue("60");
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
