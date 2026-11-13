import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SourceDialog } from "./SourceDialog";

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
