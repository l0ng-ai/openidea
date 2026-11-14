import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setInvokeRoute } from "@/platform/tauriCore";
import { SourceDialog } from "./SourceDialog";

const ipc = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@/platform/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/ipc")>()),
  call: ipc.call,
}));

afterEach(() => setInvokeRoute(null));

const savePassword = () => screen.getByRole("checkbox", { name: "Save password" }) as HTMLInputElement;

describe("new data source", () => {
  it("does not save the database password unless asked to", () => {
    render(<SourceDialog initial={null} />);
    expect(savePassword().checked).toBe(false);
  });

  it("does not save the SSH tunnel password unless asked to", () => {
    render(<SourceDialog initial={null} />);
    fireEvent.click(screen.getByRole("tab", { name: "SSH/SSL" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Use SSH tunnel" }));
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
    ipc.call.mockResolvedValue("dev@bastion:22 reaches 127.0.0.1:5432");
    // `commands.dbTestTunnel(…)` starts its real invoke before the mocked `call` is
    // entered; keep that stray promise settled so nothing rejects unhandled.
    setInvokeRoute(() => Promise.resolve(null));
    render(<SourceDialog initial={null} preset={{ driver: "postgres", host: "127.0.0.1" }} />);
    fireEvent.click(screen.getByRole("tab", { name: "SSH/SSL" }));
    const button = () => screen.getByRole("button", { name: "Test SSH Tunnel" }) as HTMLButtonElement;
    expect(button().disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Use SSH tunnel" }));
    expect(button().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Host:", { selector: "#db-ssh-host" }), { target: { value: "bastion" } });
    fireEvent.click(button());
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("SSH tunnel works: dev@bastion:22 reaches 127.0.0.1:5432"),
    );
    ipc.call.mockClear();
  });
});
