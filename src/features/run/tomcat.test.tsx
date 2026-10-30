import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { newConfigOfType, missingParams } from "./types";
import { tomcatType, tomcatBrowserUrl } from "./tomcat";
import { jdwpLaunch } from "./javaDebug";
import { TomcatSettings } from "./TomcatSettings";
import { typeRows } from "./AddConfigPopup";
import { commands } from "@/platform/ipc";

vi.mock("@/platform/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/ipc")>()),
  commands: {
    runTomcatHome: vi.fn(async () => ({ status: "ok", data: { version: "Apache Tomcat/10.1.61" } })),
    runTomcatArtifacts: vi.fn(async () => ({
      status: "ok",
      data: [{ id: "maven:pom.xml", name: "hello", module: "", tool: "maven" }],
    })),
  },
}));
afterEach(cleanup);

describe("Tomcat Local", () => {
  it("offers a Local configuration grouped under Tomcat Server with build and browser defaults", () => {
    const config = newConfigOfType(tomcatType, []);
    expect(config.params).toMatchObject({
      httpPort: "8080",
      deployment: "artifact",
      buildArtifact: "true",
      openBrowser: "true",
    });
    expect(config.debugAdapter).toBe("java-debug");
    expect(typeRows([tomcatType], "")).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "Tomcat Server" })]),
    );
    expect(missingParams(config, tomcatType)).toHaveProperty("tomcatHome");
  });
  it("validates ports and context paths and supports manually chosen web roots", () => {
    const config = newConfigOfType(tomcatType, []);
    config.params = {
      ...config.params,
      tomcatHome: "/tomcat",
      deployment: "directory",
      deploymentPath: "/legacy/WebContent",
      contextPath: "/app",
      httpPort: "18080",
    };
    expect(missingParams(config, tomcatType)).toEqual({});
    expect(tomcatBrowserUrl(config)).toBe("http://localhost:18080/app/");
    config.params.contextPath = "/";
    expect(tomcatBrowserUrl(config)).toBe("http://localhost:18080/");
    config.params.httpPort = "65536";
    config.params.contextPath = "/../app";
    expect(missingParams(config, tomcatType)).toHaveProperty("httpPort");
    expect(missingParams(config, tomcatType)).toHaveProperty("contextPath");
  });
  it("debugs through a Tomcat JDWP launch without treating an archive as a main program", () => {
    const config = newConfigOfType(tomcatType, []);
    const debug = jdwpLaunch(config)!;
    expect(debug.command).toBe("catalina");
    expect(debug.args).toEqual(["run"]);
    expect(debug.params?.tomcatDebug).toBe("true");
    expect(debug.env.JAVA_TOOL_OPTIONS).toBeUndefined();
  });
  it("shows the installation version and defaults to the project's WAR module", async () => {
    const config = newConfigOfType(tomcatType, []);
    config.params = { ...config.params, tomcatHome: "/tomcat" };
    const change = vi.fn();
    render(<TomcatSettings config={config} onChange={change} />);
    await waitFor(() =>
      expect(change).toHaveBeenCalledWith(
        expect.objectContaining({
          params: expect.objectContaining({ artifact: "maven:pom.xml", contextPath: "/hello" }),
        }),
      ),
    );
    expect(await screen.findByText("Apache Tomcat/10.1.61")).toBeTruthy();
  });
  it("reports an invalid installation in the form", async () => {
    vi.mocked(commands.runTomcatHome).mockRejectedValueOnce(new Error("missing catalina.jar"));
    const config = newConfigOfType(tomcatType, []);
    config.params = { ...config.params, tomcatHome: "/missing" };
    render(<TomcatSettings config={config} onChange={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid Tomcat installation");
  });
});
