import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRemote } from "@/platform/remote";
import { SourceDialog } from "./SourceDialog";

const ipc = vi.hoisted(() => ({ call: vi.fn(), cancel: vi.fn(), saveSource: vi.fn(), desktop: true }));
vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  // The commands `call` receives must not reach Tauri's invoke, which jsdom lacks.
  const request =
    (name: string) =>
    (...args: unknown[]) => [name, ...args];
  return {
    ...real,
    isTauri: () => ipc.desktop,
    call: ipc.call,
    commands: {
      ...real.commands,
      dbJdbcDrivers: request("dbJdbcDrivers"),
      dbTest: request("dbTest"),
      dbTestTunnel: request("dbTestTunnel"),
      dbTestExternalTunnel: request("dbTestExternalTunnel"),
      dbApproveExternalTunnel: request("dbApproveExternalTunnel"),
      cancelRequest: ipc.cancel,
    },
  };
});
vi.mock("./store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./store")>()),
  saveSource: ipc.saveSource,
}));

const savePassword = () => screen.getByRole("checkbox", { name: "Save password" }) as HTMLInputElement;
const sshTab = () => fireEvent.click(screen.getByRole("tab", { name: "SSH/SSL" }));
const button = (name: string) => screen.getByRole("button", { name });
const select = (label: string, option: string) => {
  fireEvent.click(button(label));
  fireEvent.click(within(screen.getByRole("listbox")).getByText(option, { exact: true }));
};

beforeEach(() => {
  vi.resetAllMocks();
  ipc.desktop = true;
  ipc.call.mockResolvedValue([]);
  ipc.saveSource.mockResolvedValue(undefined);
  useRemote.setState({ session: null });
});

describe("new data source", () => {
  it("does not save the database password unless asked to", () => {
    render(<SourceDialog initial={null} />);
    expect(savePassword().checked).toBe(false);
  });

  it("does not save the SSH tunnel password unless asked to", () => {
    render(<SourceDialog initial={null} />);
    sshTab();
    select("Connection method", "SSH tunnel");
    fireEvent.click(screen.getByRole("button", { name: "SSH authentication type" }));
    fireEvent.click(within(screen.getByRole("listbox")).getByText("Password"));
    expect(savePassword().checked).toBe(false);
  });

  it("names the secret of a Snowflake source after its authentication method", () => {
    render(
      <SourceDialog
        initial={null}
        preset={{
          driver: "snowflake",
          host: "",
          snowflake: { warehouse: "", role: "", auth: "keyPair", privateKeyFile: "" },
        }}
      />,
    );
    expect(screen.getByText("Account:")).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "SSH/SSL" })).toBeNull();
    expect(screen.getByLabelText("Private key:")).toBeTruthy();
    expect((screen.getByLabelText("Passphrase:") as HTMLInputElement).type).toBe("password");
    expect(savePassword().checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Snowflake authentication" }));
    fireEvent.click(within(screen.getByRole("listbox")).getByText("Password"));
    expect(screen.queryByLabelText("Private key:")).toBeNull();
    expect((screen.getByLabelText("Password:") as HTMLInputElement).type).toBe("password");
    for (const field of ["Schema:", "Warehouse:", "Role:"]) expect(screen.getByLabelText(field)).toBeTruthy();
  });
});

describe("Test SSH Tunnel", () => {
  it("tests the tunnel typed in the SSH/SSL tab, without the database login", async () => {
    ipc.call.mockImplementation(async ([op]) => (op === "dbTestTunnel" ? "dev@bastion:22 reaches 127.0.0.1:5432" : []));
    render(<SourceDialog initial={null} preset={{ driver: "postgres", host: "127.0.0.1" }} />);
    sshTab();
    expect(button("Connection method")).toHaveTextContent("Direct");
    expect(screen.queryByRole("button", { name: "Test SSH Tunnel" })).toBeNull();
    select("Connection method", "SSH tunnel");
    expect(button("Test SSH Tunnel")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Host:", { selector: "#db-ssh-host" }), { target: { value: "bastion" } });
    fireEvent.click(button("Test SSH Tunnel"));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("SSH tunnel works: dev@bastion:22 reaches 127.0.0.1:5432"),
    );
    expect(ipc.call).toHaveBeenCalledWith(["dbTestTunnel", expect.anything(), null]);
  });
});

describe("External TCP tunnel", () => {
  const externalTunnel = {
    executable: "/opt/Example Tools/forward",
    arguments: ["--port={localPort}", "{host}:{port}", '  file with "quotes"  ', "hidden\u202e", ""],
  };
  const preset = { host: "db.example.test", database: "example", externalTunnel };
  const review = () => within(screen.getByRole("group", { name: "Review External Tunnel" }));
  const approval = () => review().getByRole("checkbox", { name: "Allow this command for the destination shown" });
  const generalTab = () => fireEvent.click(screen.getByRole("tab", { name: "General" }));

  it("reviews the literal command and destination before a one-shot test or persistent approval", async () => {
    ipc.call.mockImplementation(async ([op]) => (op === "dbTestExternalTunnel" ? "PostgreSQL 17" : []));
    render(<SourceDialog initial={null} preset={{ host: preset.host, database: preset.database }} />);
    sshTab();
    select("Connection method", "External TCP tunnel");
    expect(button("Test Connection")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Executable:"), { target: { value: externalTunnel.executable } });
    expect(button("Test Connection")).toBeDisabled();
    for (const [index, argument] of externalTunnel.arguments.entries()) {
      fireEvent.click(button("Add Argument"));
      fireEvent.change(screen.getByLabelText(`Argument ${index + 1}`), { target: { value: argument } });
    }

    generalTab();
    fireEvent.click(button("OK"));
    expect(approval()).toHaveFocus();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(review().getByText(JSON.stringify(externalTunnel.executable))).toBeVisible();
    expect(review().getByText('"db.example.test:5432"')).toBeVisible();
    expect(review().getByText('"example"')).toBeVisible();
    expect(
      review()
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual(['"--port={localPort}"', '"{host}:{port}"', '"  file with \\"quotes\\"  "', '"hidden\\u{202e}"', '""']);
    expect(ipc.call).not.toHaveBeenCalledWith(["dbApproveExternalTunnel", expect.anything()]);
    expect(ipc.saveSource).not.toHaveBeenCalled();

    generalTab();
    fireEvent.click(button("Test Connection"));
    expect(approval()).toHaveFocus();
    expect(ipc.call).not.toHaveBeenCalledWith(["dbTestExternalTunnel", expect.anything(), expect.anything(), null]);
    fireEvent.click(approval());
    expect(ipc.call).not.toHaveBeenCalledWith(["dbTestExternalTunnel", expect.anything(), expect.anything(), null]);
    fireEvent.click(button("Test Connection"));
    const source = expect.objectContaining({ ...preset, ssh: null });
    await screen.findByText("Succeeded: PostgreSQL 17");
    expect(ipc.call).toHaveBeenCalledWith(["dbTestExternalTunnel", expect.any(Number), source, null]);
    expect(ipc.call).not.toHaveBeenCalledWith(["dbApproveExternalTunnel", expect.anything()]);
    expect(ipc.saveSource).not.toHaveBeenCalled();

    generalTab();
    fireEvent.click(button("OK"));
    await waitFor(() => expect(ipc.saveSource).toHaveBeenCalledWith(source, undefined, undefined));
    expect(ipc.call).toHaveBeenCalledWith(["dbApproveExternalTunnel", source]);
  });

  it("revokes acknowledgement after command, destination or TLS edits", () => {
    render(<SourceDialog initial={null} preset={preset} />);
    sshTab();
    fireEvent.click(approval());
    const argument = screen.getByLabelText("Argument 1");
    fireEvent.change(argument, { target: { value: "--listen={localPort}" } });
    fireEvent.change(argument, { target: { value: externalTunnel.arguments[0] } });
    expect(approval()).not.toBeChecked();

    fireEvent.click(approval());
    generalTab();
    fireEvent.change(screen.getByLabelText("Host:", { selector: "#db-host" }), {
      target: { value: "other.example.test" },
    });
    fireEvent.click(button("Test Connection"));
    expect(review().getByText('"other.example.test:5432"')).toBeVisible();
    expect(approval()).not.toBeChecked();
    expect(ipc.call).not.toHaveBeenCalledWith(["dbTestExternalTunnel", expect.anything(), expect.anything(), null]);

    fireEvent.click(approval());
    select("SSL mode", "Require");
    expect(approval()).not.toBeChecked();
    fireEvent.click(button("OK"));
    expect(ipc.call).not.toHaveBeenCalledWith(["dbApproveExternalTunnel", expect.anything()]);
    expect(ipc.saveSource).not.toHaveBeenCalled();
  });

  it.each(["close", "unmount"])("cancels the running external test on %s", async (dismiss) => {
    let complete: (version: string) => void = () => {};
    const pending = new Promise<string>((resolve) => {
      complete = resolve;
    });
    ipc.call.mockImplementation(async ([op]) => (op === "dbTestExternalTunnel" ? pending : []));
    const dialog = render(<SourceDialog initial={null} preset={preset} />);
    fireEvent.click(button("Test Connection"));
    fireEvent.click(approval());
    fireEvent.click(button("Test Connection"));
    expect(button("Test Connection")).toBeDisabled();
    const request = ipc.call.mock.calls.find(([[op]]) => op === "dbTestExternalTunnel")?.[0][1];
    expect(request).toEqual(expect.any(Number));
    if (dismiss === "unmount") dialog.unmount();
    else fireEvent.click(button("Cancel"));
    expect(ipc.cancel).toHaveBeenCalledExactlyOnceWith(request);
    await act(async () => complete("Late result"));
    expect(screen.queryByText("Succeeded: Late result")).toBeNull();
  });

  it("keeps the external and SSH routes mutually exclusive", async () => {
    render(<SourceDialog initial={null} preset={preset} />);
    sshTab();
    expect(button("Connection method")).toHaveTextContent("External TCP tunnel");
    select("Connection method", "SSH tunnel");
    fireEvent.change(screen.getByLabelText("Host:", { selector: "#db-ssh-host" }), { target: { value: "bastion" } });
    fireEvent.click(button("Test Connection"));
    await waitFor(() =>
      expect(ipc.call).toHaveBeenCalledWith([
        "dbTest",
        expect.objectContaining({
          externalTunnel: null,
          ssh: expect.objectContaining({ enabled: true, host: "bastion" }),
        }),
        null,
        null,
      ]),
    );
    select("Connection method", "Direct");
    fireEvent.click(button("OK"));
    await waitFor(() =>
      expect(ipc.saveSource).toHaveBeenCalledWith(
        expect.objectContaining({ externalTunnel: null, ssh: expect.objectContaining({ enabled: false }) }),
        undefined,
        undefined,
      ),
    );
  });

  it("keeps Verify Full selected and blocks the test and save", () => {
    render(<SourceDialog initial={null} preset={{ ...preset, ssl: "verifyFull" }} />);
    sshTab();
    expect(button("SSL mode")).toHaveTextContent("Verify Full");
    expect(screen.getByRole("status")).toHaveTextContent("Verify Full is unavailable with an external TCP tunnel.");
    expect(button("Test Connection")).toBeDisabled();
    expect(button("OK")).toBeDisabled();
  });

  it("requires the default connection fields when switching from URL-only mode", () => {
    render(
      <SourceDialog
        initial={null}
        preset={{ ...preset, urlOnly: true, url: "postgresql://different.example.test:5433/other" }}
      />,
    );
    expect(button("Test Connection")).toBeDisabled();
    expect(button("URL only")).toBeDisabled();
    fireEvent.click(button("default"));
    expect(button("Test Connection")).toBeEnabled();
    fireEvent.click(button("Test Connection"));
    expect(review().getByText('"db.example.test:5432"')).toBeVisible();
    expect(review().queryByText(/different\.example\.test/)).toBeNull();
  });

  it("keeps the legacy SSH editor in remote windows", () => {
    useRemote.setState({
      session: {
        target: { kind: "ssh", config: "example" },
        root: "/project",
        host: "example",
        os: "linux",
        commands: [],
      },
    });
    render(<SourceDialog initial={null} />);
    sshTab();
    expect(screen.queryByRole("button", { name: "Connection method" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Use SSH tunnel" })).toBeVisible();
  });
});
