import { describe, expect, it } from "vitest";
import type { DbSsh } from "@/platform/ipc";
import { DEFAULT_SSH_CONFIG, type SshConfigValid } from "@/platform/remoteSettings";
import { connectRemedy, effectiveSsh, sshConfigOf, sshLabel, sshTunnelReady } from "./model";

const configs: SshConfigValid[] = [
  { ...DEFAULT_SSH_CONFIG, id: "dev", name: "Dev", host: "box", port: 2222, user: "me", auth: "password" },
  { ...DEFAULT_SSH_CONFIG, id: "blank", name: "Blank" },
];
const inline: DbSsh = { enabled: true, config: "", host: "bastion", port: null, user: "ops", auth: "openSsh" };

describe("data source SSH configuration", () => {
  it("uses the chosen SSH configuration instead of the inline fields", () => {
    const ssh = { ...inline, config: "dev" };
    expect(sshConfigOf(ssh, configs)?.id).toBe("dev");
    const used = effectiveSsh(ssh, configs)!;
    expect(sshLabel({ ssh: used })).toBe("me@box:2222");
    expect(used.auth).toBe("password");
    expect(used.config).toBe("dev");
  });

  it("keeps the inline fields when no configuration (or a missing one) is chosen", () => {
    expect(effectiveSsh(inline, configs)).toBe(inline);
    expect(sshConfigOf({ ...inline, config: "gone" }, configs)).toBeUndefined();
    expect(effectiveSsh({ ...inline, config: "gone" }, configs)?.host).toBe("bastion");
    expect(effectiveSsh(null, configs)).toBeNull();
  });

  it("needs a host to tunnel through only when the tunnel is on", () => {
    expect(sshTunnelReady({ ...inline, enabled: false, host: "" }, configs)).toBe(true);
    expect(sshTunnelReady(inline, configs)).toBe(true);
    expect(sshTunnelReady({ ...inline, host: " " }, configs)).toBe(false);
    expect(sshTunnelReady({ ...inline, host: "", config: "dev" }, configs)).toBe(true);
    expect(sshTunnelReady({ ...inline, config: "blank" }, configs)).toBe(false);
    expect(sshTunnelReady({ ...inline, config: "gone" }, configs)).toBe(false);
  });

  it("classifies auth failures by the configuration's authentication", () => {
    const msg = "SSH authentication failed for me@box:2222";
    expect(connectRemedy("permissionDenied", msg, { ssh: inline })).toBeNull();
    expect(connectRemedy("permissionDenied", msg, { ssh: effectiveSsh({ ...inline, config: "dev" }, configs) })).toBe(
      "sshSecret",
    );
  });
});
