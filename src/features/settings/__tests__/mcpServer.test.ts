import { describe, expect, it } from "vitest";
import type { McpServerStatus } from "@/bindings";
import { DEFAULT_SETTINGS, validateSettings } from "../model/schema";
import { httpConfig, stdioConfig, MCP_SERVER_PAGE } from "../pages/mcpServer";

const status: McpServerStatus = {
  running: true,
  error: null,
  port: 1234,
  project: "/p",
  url: "http://127.0.0.1:1234/mcp?project=/p",
  token: "secret",
  stdioCommand: ["/Applications/OpenIDEA.app/Contents/MacOS/openidea", "--mcp-stdio", "--project", "/p"],
};

describe("MCP server settings", () => {
  it("defaults to off and only offers global scope", () => {
    expect(DEFAULT_SETTINGS.mcpServer.enabled).toBe(false);
    expect(validateSettings({}).mcpServer.enabled).toBe(false);
    expect(validateSettings({ mcpServer: { enabled: true } }).mcpServer.enabled).toBe(true);
    expect(MCP_SERVER_PAGE.projectScope).not.toBe(true);
  });
  it("copies a reusable stdio configuration without the token", () => {
    const config = stdioConfig(status)!;
    expect(JSON.parse(config).mcpServers.openidea).toEqual({
      type: "stdio",
      command: status.stdioCommand[0],
      args: status.stdioCommand.slice(1),
    });
    expect(config).not.toContain("secret");
    expect(stdioConfig({ ...status, stdioCommand: [] })).toBeNull();
  });
  it("copies the current HTTP endpoint and bearer header", () => {
    expect(JSON.parse(httpConfig(status)!).mcpServers.openidea).toEqual({
      type: "http",
      url: status.url,
      headers: { Authorization: "Bearer secret" },
    });
    expect(httpConfig({ ...status, url: null, token: null })).toBeNull();
  });
});
