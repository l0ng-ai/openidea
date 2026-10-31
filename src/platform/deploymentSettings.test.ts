import { describe, expect, it } from "vitest";
import { deploymentConnection, validateDeployment } from "./remoteSettings";

describe("deployment types", () => {
  it("reads existing servers as SFTP without changing their connection", () => {
    const legacy = { id: "existing", name: "Staging", sshConfig: "ssh", rootPath: "/srv", webUrl: "http://localhost" };
    const server = validateDeployment({ servers: [legacy] }).servers[0]!;
    expect(server).toMatchObject({ ...legacy, kind: "sftp" });
    expect(deploymentConnection(server)).toEqual({ kind: "sftp", ssh: "ssh" });
  });
  it.each(["sftp", "local"])("round trips %s settings", (kind) => {
    const settings = validateDeployment({ servers: [{ kind, rootPath: "/mounted/www", sshConfig: "retained" }] });
    expect(validateDeployment(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
    expect(deploymentConnection(settings.servers[0]!)).toEqual(
      kind === "local" ? { kind: "local" } : { kind: "sftp", ssh: "retained" },
    );
  });
  it("normalizes unsupported types to SFTP", () => {
    for (const kind of [undefined, "ftp", "ftps", "webdav", "inPlace", null]) {
      expect(validateDeployment({ servers: [{ kind }] }).servers[0]!.kind).toBe("sftp");
    }
  });
});
