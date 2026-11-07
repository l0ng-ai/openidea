import { tx } from "@/platform/i18n";
import { call, commands, nextRequestId, type RunConfig } from "@/platform/ipc";
import type { RunConfigTypeContribution } from "@/workbench/contributions";
import { updatePolicyDefaults, updatePolicyFields } from "./updatePolicies";
import { runUpdateBuild } from "./buildUpdate";

const validatePort = (value: string) =>
  /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 65535 ? null : "Port must be between 1 and 65535";

const validateOptionalPort = (value: string) => (!value.trim() ? null : validatePort(value.trim()));

export const tomcatType: RunConfigTypeContribution = {
  id: "tomcat",
  group: "Tomcat Server",
  label: "Local",
  icon: "tomcat",
  description: "Run a WAR application in a local Tomcat server",
  debugAdapter: "java-debug",
  terminal: false,
  defaults: {
    deployment: "artifact",
    httpPort: "8080",
    jmxPort: "1099",
    buildArtifact: "true",
    openBrowser: "true",
    ...updatePolicyDefaults,
  },
  fields: [
    { key: "tomcatHome", label: "Tomcat installation directory", required: true, mono: true, browse: "directory" },
    {
      key: "tomcatBase",
      label: "Tomcat base directory",
      mono: true,
      browse: "directory",
      placeholder: "IDE-managed isolated base directory",
      hint: "Read-only configuration source; leave empty to copy from Tomcat Home. Each launch uses an IDE-managed runtime directory.",
    },
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
      browse: (p) => (p.deployment === "war" ? "file" : "directory"),
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
      key: "contextDescriptor",
      label: "Context descriptor",
      mono: true,
      browse: "file",
      placeholder: "META-INF/context.xml from application",
      hint: "Custom context.xml descriptor; leave empty to use the application's META-INF/context.xml",
    },
    {
      key: "deployTomcatApps",
      label: "Deploy applications configured in Tomcat instance",
      control: "checkbox",
    },
    { key: "openBrowser", label: "Open browser after launch", control: "checkbox" },
    {
      key: "browserUrl",
      label: "Browser URL",
      mono: true,
      placeholder: "Server URL from the HTTP port and context path",
      visible: (p) => p.openBrowser === "true",
      validate: (value) => (/^https?:\/\//i.test(value) ? null : "Enter an HTTP or HTTPS URL"),
    },
    ...updatePolicyFields(true),
    {
      key: "jre",
      label: "JRE",
      mono: true,
      browse: "directory",
      placeholder: "Project JDK",
      hint: "Java installation directory; empty uses the project JDK",
    },
    { key: "vmOptions", label: "VM options", control: "textarea", rows: 2, mono: true },
    {
      key: "httpPort",
      label: "HTTP port",
      required: true,
      validate: validatePort,
    },
    {
      key: "httpsPort",
      label: "HTTPS port",
      placeholder: "8443",
      validate: validateOptionalPort,
    },
    {
      key: "jmxPort",
      label: "JMX port",
      placeholder: "1099",
      hint: "JMX remote port; leave empty to allocate a free port automatically",
      validate: validateOptionalPort,
    },
    {
      key: "ajpPort",
      label: "AJP port",
      placeholder: "8009",
      validate: validateOptionalPort,
    },
    {
      key: "shutdownPort",
      label: "Shutdown port",
      placeholder: "8005",
      hint: "Tomcat server shutdown port; leave empty to allocate a free port automatically",
      validate: validateOptionalPort,
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
  await runUpdateBuild(build);
}

/**
 * Updates a running artifact deployment without rebuilding the WAR: compiles the WAR module
 * incrementally and copies its changed classes, resources and web files into the deployment.
 * `false` when that isn't possible (other deployment kinds, no Java language server, a changed
 * dependency module): the caller rebuilds the WAR.
 */
export async function syncTomcatOutputs(config: RunConfig, resourcesOnly: boolean): Promise<boolean> {
  const p = config.params ?? {};
  if ((p.deployment ?? "artifact") !== "artifact") return false;
  const artifacts = await call(commands.runTomcatArtifacts());
  const artifact = p.artifact ? artifacts.find((a) => a.id === p.artifact) : artifacts[0];
  if (!artifact) return false;
  const info = await call(commands.javaResolveLaunch(artifact.module, false, "make", nextRequestId())).catch(() => null);
  if (!info) return false;
  if (info.build === "failed" || info.build === "withErrors" || info.build === "cancelled")
    throw new Error(tx("Application update build failed"));
  return call(commands.runTomcatSync(config, artifact.module, info.classPaths, resourcesOnly));
}

export function tomcatBrowserUrl(config: RunConfig): string {
  const p = config.params ?? {};
  const host = "localhost";
  const name =
    p.artifactName ||
    p.deploymentPath
      ?.replace(/\\/g, "/")
      .split("/")
      .pop()
      ?.replace(/\.war$/i, "") ||
    "";
  const context = p.contextPath || (name && name !== "ROOT" ? `/${name}` : "/");
  return p.browserUrl || `http://${host}:${p.httpPort || "8080"}${context === "/" ? "/" : `${context}/`}`;
}
