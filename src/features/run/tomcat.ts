import { call, commands, type RunConfig } from "@/platform/ipc";
import type { RunConfigTypeContribution } from "@/workbench/contributions";

export const tomcatType: RunConfigTypeContribution = {
  id: "tomcat",
  group: "Tomcat Server",
  label: "Local",
  icon: "server",
  description: "Run a WAR application in a local Tomcat server",
  debugAdapter: "java-debug",
  terminal: false,
  defaults: { deployment: "artifact", httpPort: "8080", buildArtifact: "true", openBrowser: "true" },
  fields: [
    { key: "tomcatHome", label: "Tomcat installation directory", required: true, mono: true },
    {
      key: "deployment",
      label: "Deployment",
      control: "select",
      options: [
        { value: "artifact", label: "Project WAR artifact (exploded)" },
        { value: "war", label: "WAR file" },
        { value: "directory", label: "Exploded directory" },
      ],
    },
    {
      key: "deploymentPath",
      label: "Deployment path",
      mono: true,
      required: true,
      visible: (p) => p.deployment !== "artifact",
    },
    {
      key: "contextPath",
      label: "Context path",
      mono: true,
      placeholder: "/artifact-name",
      validate: (value) =>
        value === "/" || /^\/[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*$/u.test(value)
          ? null
          : "Enter / or a context path such as /app",
    },
    {
      key: "httpPort",
      label: "HTTP port",
      required: true,
      validate: (value) =>
        /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 65535 ? null : "Port must be between 1 and 65535",
    },
    {
      key: "jre",
      label: "JRE",
      mono: true,
      placeholder: "Project JDK",
      hint: "Java installation directory; empty uses the project JDK",
    },
    { key: "vmOptions", label: "VM options", control: "textarea", rows: 2, mono: true },
    { key: "openBrowser", label: "Open browser after launch", control: "checkbox" },
    {
      key: "browserUrl",
      label: "Browser URL",
      mono: true,
      placeholder: "Server URL from the HTTP port and context path",
      visible: (p) => p.openBrowser === "true",
      validate: (value) => (/^https?:\/\//i.test(value) ? null : "Enter an HTTP or HTTPS URL"),
    },
    {
      key: "buildArtifact",
      label: "Before launch: build the artifact",
      control: "checkbox",
      visible: (p) => p.deployment === "artifact",
    },
  ],
  commandLine: () => ({ command: "catalina", args: ["run"] }),
  async prepareLaunch(config) {
    if (config.target) throw new Error("Tomcat Local requires the local machine");
    await call(commands.runTomcatHome(config.params?.tomcatHome ?? ""));
    if (config.params?.buildArtifact === "true") await buildTomcatArtifact(config);
    return config;
  },
};

export async function buildTomcatArtifact(config: RunConfig): Promise<void> {
  const build = await call(commands.runTomcatBuild(config));
  if (!build) return;
  const { startRun } = await import("./store");
  let finish!: (ok: boolean) => void;
  const exited = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  const session = await startRun(build, undefined, undefined, {
    onExit: (code, stopped) => finish(code === 0 && !stopped),
  });
  if (!session || session.status === "failed" || !(await exited)) throw new Error("WAR artifact build failed");
}

export function tomcatBrowserUrl(config: RunConfig): string {
  const p = config.params ?? {};
  const name =
    p.artifactName ||
    p.deploymentPath
      ?.replace(/\\/g, "/")
      .split("/")
      .pop()
      ?.replace(/\.war$/i, "") ||
    "";
  const context = p.contextPath || (name && name !== "ROOT" ? `/${name}` : "/");
  return p.browserUrl || `http://localhost:${p.httpPort || "8080"}${context === "/" ? "/" : `${context}/`}`;
}
