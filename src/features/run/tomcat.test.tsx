import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, within } from "@testing-library/react";
import { newConfigOfType, missingParams } from "./types";
import { tomcatType, tomcatBrowserUrl, syncTomcatOutputs } from "./tomcat";
import { jdwpLaunch } from "./javaDebug";
import { TomcatSettings } from "./TomcatSettings";
import { typeRows } from "./AddConfigPopup";
import { commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";

vi.mock("@/platform/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/ipc")>()),
  commands: {
    runTomcatHome: vi.fn(async () => ({
      status: "ok",
      data: {
        version: "Apache Tomcat/10.1.61",
        libraries: [
          "/opt/homebrew/opt/tomcat/libexec/lib/jsp-api.jar",
          "/opt/homebrew/opt/tomcat/libexec/lib/servlet-api.jar",
        ],
      },
    })),
    runTomcatInstallations: vi.fn(async () => ({
      status: "ok",
      data: [
        {
          path: "/opt/homebrew/opt/tomcat/libexec",
          version: "Apache Tomcat/10.1.61",
          libraries: [
            "/opt/homebrew/opt/tomcat/libexec/lib/jsp-api.jar",
            "/opt/homebrew/opt/tomcat/libexec/lib/servlet-api.jar",
          ],
        },
      ],
    })),
    runTomcatArtifacts: vi.fn(async () => ({
      status: "ok",
      data: [
        { id: "maven:pom.xml", name: "hello", module: "", tool: "maven" },
        { id: "maven:web/pom.xml", name: "web", module: "web", tool: "maven" },
      ],
    })),
    javaResolveLaunch: vi.fn(async () => ({
      status: "ok",
      data: { build: "succeeded", classPaths: ["/p/web/target/classes", "/m2/lib.jar"], pathListSeparator: ":" },
    })),
    runTomcatSync: vi.fn(async () => ({ status: "ok", data: true })),
  },
}));
afterEach(cleanup);

describe("Tomcat Local", () => {
  it("offers a Tomcat Server configuration grouped under Servers with build and browser defaults", () => {
    const config = newConfigOfType(tomcatType, []);
    expect(config.params).toMatchObject({
      httpPort: "8080",
      deployment: "artifact",
      buildArtifact: "true",
      openBrowser: "true",
    });
    expect(config.debugAdapter).toBe("java-debug");
    expect(typeRows([tomcatType], "")).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "Servers" })]),
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
    expect(await screen.findByText(/Apache Tomcat\/10\.1\.61/)).toBeTruthy();
  });
  it.each(["war", "directory"])(
    "does not replace a configured %s deployment during artifact discovery",
    async (deployment) => {
      const config = newConfigOfType(tomcatType, []);
      config.params = { ...config.params, deployment, deploymentPath: "/external/app", tomcatHome: "/tomcat" };
      const change = vi.fn();
      render(<TomcatSettings config={config} onChange={change} />);
      await screen.findByText(/Apache Tomcat\/10\.1\.61/);
      expect(change).not.toHaveBeenCalled();
    },
  );
  it("validates server ports and supports custom CATALINA_BASE, context descriptor, and instance options", () => {
    const config = newConfigOfType(tomcatType, []);
    config.params = {
      ...config.params,
      tomcatHome: "/tomcat",
      tomcatBase: "/custom/base",
      contextDescriptor: "/project/conf/context.xml",
      deployTomcatApps: "true",
      preserveSessions: "true",
      httpPort: "8080",
      httpsPort: "8443",
      jmxPort: "1099",
      ajpPort: "8009",
      shutdownPort: "8005",
    };
    expect(missingParams(config, tomcatType)).toEqual({});
    config.params.httpsPort = "70000";
    config.params.jmxPort = "0";
    config.params.ajpPort = "abc";
    config.params.shutdownPort = "99999";
    const errors = missingParams(config, tomcatType);
    expect(errors).toHaveProperty("httpsPort");
    expect(errors).toHaveProperty("jmxPort");
    expect(errors).toHaveProperty("ajpPort");
    expect(errors).toHaveProperty("shutdownPort");
  });
  it("auto-selects a detected local Tomcat installation when tomcatHome is blank", async () => {
    const config = newConfigOfType(tomcatType, []);
    const change = vi.fn();
    render(<TomcatSettings config={config} onChange={change} />);
    await waitFor(() =>
      expect(change).toHaveBeenCalledWith(
        expect.objectContaining({
          params: expect.objectContaining({ tomcatHome: "/opt/homebrew/opt/tomcat/libexec" }),
        }),
      ),
    );
    await waitFor(() =>
      expect(change.mock.calls.at(-1)?.[0].params).toMatchObject({
        tomcatHome: "/opt/homebrew/opt/tomcat/libexec",
        artifact: "maven:pom.xml",
      }),
    );
    expect(await screen.findByLabelText("Application server")).toBeTruthy();
  });
  it("opens Application Servers via Configure..., displays libraries, and switches between supported tabs", async () => {
    const config = newConfigOfType(tomcatType, []);
    const change = vi.fn();
    render(<TomcatSettings config={config} onChange={change} />);
    expect(screen.getByText("Warning: No artifacts configured")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fix" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Configure..." }));
    expect(await screen.findByText("Application Servers")).toBeTruthy();
    expect(await screen.findByText(/jsp-api\.jar/)).toBeTruthy();
    expect(await screen.findByText(/servlet-api\.jar/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Add Application Server" }));
    expect(await screen.findByText("The selected directory is not a valid Tomcat home")).toBeTruthy();
    expect(screen.getByText("Tomcat base directory path is not specified")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("New server Tomcat Home"), {
      target: { value: "/opt/homebrew/opt/tomcat/libexec" },
    });
    const cancelBtns = screen.getAllByRole("button", { name: "Cancel" });
    fireEvent.click(cancelBtns[cancelBtns.length - 1]!);

    const nameInput = screen.getByLabelText("Server name");
    fireEvent.change(nameInput, { target: { value: "Tomcat10" } });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));

    expect(change).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          serverName: "Tomcat10",
          tomcatHome: "/opt/homebrew/opt/tomcat/libexec",
        }),
      }),
    );

    fireEvent.click(screen.getByRole("tab", { name: "Deployment" }));
    expect(screen.getByText("Deploy at the server startup")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Logs" }));
    expect(screen.getByLabelText("Console output file")).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Code Coverage" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Startup/Connection" }));
    expect(screen.getByRole("option", { name: "Debug" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Run VisualGC" })).toBeNull();
    expect(screen.getByLabelText("Startup script")).toBeTruthy();
    expect(screen.getByText("Environment Variables")).toBeTruthy();
  });
  it("clears the selected server when all application server profiles are removed", async () => {
    localStorage.clear();
    const config = newConfigOfType(tomcatType, []);
    config.params = {
      ...config.params,
      tomcatHome: "/opt/homebrew/opt/tomcat/libexec",
      serverName: "Tomcat",
      tomcatBase: "/custom/base",
      tomcatLibraries: "/custom/lib.jar",
    };
    const change = vi.fn();
    render(<TomcatSettings config={config} onChange={change} />);
    await screen.findByText(/Apache Tomcat\/10\.1\.61/);
    fireEvent.click(screen.getByRole("button", { name: "Configure..." }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Application Server" }));
    expect(screen.getByText("No application server selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    const params = change.mock.calls.at(-1)?.[0].params;
    expect(params).not.toHaveProperty("tomcatHome");
    expect(params).not.toHaveProperty("serverName");
    expect(params).not.toHaveProperty("tomcatBase");
    expect(params).not.toHaveProperty("tomcatLibraries");
    expect(JSON.parse(localStorage.getItem("openidea.tomcat.servers.v1")!)).toEqual([]);
  });
  it("keeps Debug environment overrides separate from the backend JDWP agent", () => {
    const config = newConfigOfType(tomcatType, []);
    const change = vi.fn();
    render(<TomcatSettings config={config} onChange={change} />);
    expect(screen.queryByLabelText("Browser")).toBeNull();
    expect(screen.queryByLabelText("with JavaScript debugger")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Startup/Connection" }));
    fireEvent.click(screen.getByRole("option", { name: "Debug" }));
    expect(screen.queryByDisplayValue(/agentlib:jdwp/)).toBeNull();
    fireEvent.click(
      within(screen.getByRole("toolbar", { name: "Startup environment variables" })).getByRole("button", {
        name: "Add",
      }),
    );
    expect(change).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ startupEnvDebug: "VAR_1=" }),
      }),
    );
  });
  it.each([undefined, false, true])("inherits the tool window setting unless overridden (%s)", (override) => {
    const previous = useProject.getState().settings;
    useProject.setState({ settings: { run: { showOnStart: false } } as never });
    try {
      const config = { ...newConfigOfType(tomcatType, []), openToolWindow: override };
      render(<TomcatSettings config={config} onChange={() => {}} />);
      expect((screen.getByRole("checkbox", { name: "Activate tool window" }) as HTMLInputElement).checked).toBe(
        override ?? false,
      );
    } finally {
      cleanup();
      useProject.setState({ settings: previous });
    }
  });
  it("reports an invalid installation in the form", async () => {
    vi.mocked(commands.runTomcatHome).mockRejectedValueOnce(new Error("missing catalina.jar"));
    const config = newConfigOfType(tomcatType, []);
    config.params = { ...config.params, tomcatHome: "/missing" };
    render(<TomcatSettings config={config} onChange={() => {}} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid Tomcat installation");
  });
});

describe("updating a running Tomcat deployment", () => {
  const config = (params: Record<string, string>) => ({ ...newConfigOfType(tomcatType, []), id: "t", params });

  it("compiles the selected WAR module and copies its outputs instead of rebuilding the WAR", async () => {
    const c = config({ deployment: "artifact", artifact: "maven:web/pom.xml" });
    expect(await syncTomcatOutputs(c, false)).toBe(true);
    expect(commands.javaResolveLaunch).toHaveBeenCalledWith("web", false, true, expect.anything());
    expect(commands.runTomcatSync).toHaveBeenCalledWith(c, "web", ["/p/web/target/classes", "/m2/lib.jar"], false);
  });

  it("leaves WAR files, exploded directories and failed compilations to the WAR path", async () => {
    vi.mocked(commands.runTomcatSync).mockClear();
    expect(await syncTomcatOutputs(config({ deployment: "war" }), true)).toBe(false);
    vi.mocked(commands.javaResolveLaunch).mockResolvedValueOnce({
      status: "error",
      error: { kind: "unavailable" },
    } as never);
    expect(await syncTomcatOutputs(config({ deployment: "artifact" }), true)).toBe(false);
    expect(commands.runTomcatSync).not.toHaveBeenCalled();
    vi.mocked(commands.javaResolveLaunch).mockResolvedValueOnce({
      status: "ok",
      data: { build: "withErrors", classPaths: [] },
    } as never);
    await expect(syncTomcatOutputs(config({ deployment: "artifact" }), false)).rejects.toThrow();
  });
});
