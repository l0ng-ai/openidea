import { describe, expect, it } from "vitest";
import { parseSshPort, secretKind, sshTestRemedy } from "../pages/sshConnection";

describe("SSH configuration Test Connection", () => {
  it("offers to trust an unknown host key, never a changed one", () => {
    expect(sshTestRemedy("protocol", "Unknown SSH host key for box:22 (ssh-ed25519 SHA256:abc)", "password")).toBe(
      "trustHostKey",
    );
    expect(
      sshTestRemedy(
        "permissionDenied",
        "SSH host key of box:22 has changed (known_hosts line 3); possible attack",
        "password",
      ),
    ).toBeNull();
  });

  it("asks for a password or passphrase when one is missing or rejected", () => {
    expect(sshTestRemedy("permissionDenied", "SSH password required for me@box:22", "password")).toBe("secret");
    expect(sshTestRemedy("permissionDenied", "SSH key passphrase required for ~/.ssh/id", "keyPair")).toBe("secret");
    expect(sshTestRemedy("permissionDenied", "SSH authentication failed for me@box:22", "password")).toBe("secret");
    expect(sshTestRemedy("permissionDenied", "SSH authentication failed for me@box:22", "openSsh")).toBeNull();
    expect(sshTestRemedy("io", "connection refused", "password")).toBeNull();
  });

  it("names the secret", () => {
    expect(secretKind("password")).toBe("password");
    expect(secretKind("keyPair")).toBe("passphrase");
    expect(secretKind("openSsh", "SSH key passphrase required for /k")).toBe("passphrase");
    expect(secretKind("openSsh", "SSH password required for me@box")).toBe("password");
  });

  it("parses the port field", () => {
    expect(parseSshPort("")).toBeNull();
    expect(parseSshPort(" 2222 ")).toBe(2222);
    expect(parseSshPort("0")).toBeNull();
    expect(parseSshPort("70000")).toBeNull();
    expect(parseSshPort("22x")).toBeNull();
  });
});
