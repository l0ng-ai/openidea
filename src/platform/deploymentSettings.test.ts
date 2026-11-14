import { describe, expect, it } from "vitest";
import { connectionSecretKey, deploymentConnection, validateDeployment } from "./remoteSettings";

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
  it.each(["ftp", "ftps"])("connects %s servers with their host and the password saved under the server", (kind) => {
    const ftp = { host: "ftp.example.com", port: 2121, user: "web", passive: false };
    const settings = validateDeployment({ servers: [{ kind, id: "s1", ftp }] });
    expect(validateDeployment(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
    const connection = deploymentConnection(settings.servers[0]!);
    expect(connection).toEqual({ kind: "ftp", server: "s1", secure: kind === "ftps", ftp });
    expect(connectionSecretKey(connection)).toBe("ftp:s1");
  });
  it("defaults FTP to anonymous passive mode on port 21", () => {
    expect(validateDeployment({ servers: [{ kind: "ftp", ftp: { port: 0 } }] }).servers[0]!.ftp).toEqual({
      host: "",
      port: null,
      user: "",
      passive: true,
    });
  });
  it("normalizes unsupported types to SFTP", () => {
    for (const kind of [undefined, "webdav", "inPlace", null]) {
      expect(validateDeployment({ servers: [{ kind }] }).servers[0]!.kind).toBe("sftp");
    }
  });
});
