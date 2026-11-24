import { call, commands, nextRequestId, type RunConfig } from "@/platform/ipc";
import type { RunConfigTypeContribution } from "@/workbench/contributions";
import { updatePolicyDefaults, updatePolicyFields } from "./updatePolicies";
import { runUpdateBuild, updateBuildError } from "./buildUpdate";

const validatePort = (value: string) =>
  /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 65535 ? null : "Port must be between 1 and 65535";

const validateOptionalPort = (value: string) => (!value.trim() ? null : validatePort(value.trim()));

export const tomcatType: RunConfigTypeContribution = {
  id: "tomcat",
  group: "Servers",
  label: "Tomcat Server",
  icon: "tomcat",
  description: "Run a WAR application in a local Tomcat server",
  debugAdapter: "java-debug",
  terminal: false,
  defaults: {
    deployment: "artifact",
    httpPort: "8080",
    jmxPort: "1099",
    // Build before launch (IDEA default); skipped automatically when the built WAR is current.
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

export interface TomcatDeployment {
  kind: "artifact" | "war" | "directory";
  artifact?: string;
  artifactName?: string;
  module?: string;
  deploymentPath?: string;
  contextPath?: string;
  contextDescriptor?: string;
}

/**
 * Reads all deployments configured on a Tomcat run config.
 * Uses `params.deployments` (JSON array) when present; otherwise falls back to legacy
 * single-deployment params (`deployment`, `artifact`, `deploymentPath`, etc.).
 */
export function getTomcatDeployments(config: RunConfig): TomcatDeployment[] {
  const p = config.params ?? {};
  if (p.deployments !== undefined) {
    try {
      const parsed = JSON.parse(p.deployments);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (d): d is TomcatDeployment =>
            !!d && typeof d === "object" && (d.kind === "artifact" || d.kind === "war" || d.kind === "directory"),
        );
      }
    } catch {
      // fall back to legacy single-deployment params
    }
  }
  const kind = (p.deployment ?? "artifact") as TomcatDeployment["kind"];
  if (kind === "artifact") {
    if (!p.artifact) return [];
    return [
      {
        kind: "artifact",
        artifact: p.artifact,
        ...(p.artifactName ? { artifactName: p.artifactName } : {}),
        ...(config.cwd ? { module: config.cwd } : {}),
        ...(p.contextPath ? { contextPath: p.contextPath } : {}),
        ...(p.contextDescriptor ? { contextDescriptor: p.contextDescriptor } : {}),
      },
    ];
  }
  if (!p.deploymentPath?.trim()) return [];
  return [
    {
      kind,
      deploymentPath: p.deploymentPath,
      ...(p.contextPath ? { contextPath: p.contextPath } : {}),
      ...(p.contextDescriptor ? { contextDescriptor: p.contextDescriptor } : {}),
    },
  ];
}

/**
 * Returns a params patch that persists `deployments` as JSON while mirroring the first
 * entry into legacy single-deployment keys for backward compatibility.
 */
export function tomcatDeploymentsParams(deployments: TomcatDeployment[]): Record<string, string> {
  const first = deployments[0];
  return {
    deployments: JSON.stringify(deployments),
    deployment: first?.kind ?? "artifact",
    artifact: first?.kind === "artifact" ? (first.artifact ?? "") : "",
    artifactName: first?.kind === "artifact" ? (first.artifactName ?? "") : "",
    deploymentPath: first && first.kind !== "artifact" ? (first.deploymentPath ?? "") : "",
    contextPath: first?.contextPath ?? "",
    contextDescriptor: first?.contextDescriptor ?? "",
  };
}

export async function buildTomcatArtifact(config: RunConfig): Promise<void> {
  const deployments = getTomcatDeployments(config);
  if (deployments.length <= 1) {
    const build = await call(commands.runTomcatBuild(config));
    if (!build) return;
    await runUpdateBuild(build);
    return;
  }
  for (let i = 0; i < deployments.length; i++) {
    if (deployments[i]!.kind !== "artifact") continue;
    const single: RunConfig = {
      ...config,
      params: { ...(config.params ?? {}), buildDeploymentIndex: String(i) },
    };
    const build = await call(commands.runTomcatBuild(single));
    if (build) await runUpdateBuild(build);
  }
}

/**
 * Updates running artifact deployments without rebuilding the WARs: compiles each WAR module
 * incrementally and copies its changed classes, resources and web files into the deployment.
 * `false` when that isn't possible (other deployment kinds, no Java language server, a changed
 * dependency module): the caller rebuilds the WARs.
 */
export async function syncTomcatOutputs(config: RunConfig, resourcesOnly: boolean): Promise<boolean> {
  const p = config.params ?? {};
  const deployments = getTomcatDeployments(config);
  const artifactDeps = deployments.filter((d) => d.kind === "artifact");
  if (artifactDeps.length === 0) {
    // Legacy config with `deployment: "artifact"` and no explicit `artifact` id falls back to artifacts[0].
    if (p.deployments !== undefined || (p.deployment ?? "artifact") !== "artifact") return false;
    const artifacts = await call(commands.runTomcatArtifacts());
    const artifact = p.artifact ? artifacts.find((a) => a.id === p.artifact) : artifacts[0];
    if (!artifact) return false;
    const info = await call(commands.javaResolveLaunch(artifact.module, false, "make", nextRequestId())).catch(
      () => null,
    );
    if (!info) return false;
    if (info.build === "failed" || info.build === "withErrors" || info.build === "cancelled")
      throw updateBuildError(info);
    return call(commands.runTomcatSync(config, artifact.module, info.classPaths, resourcesOnly));
  }
  const artifacts = await call(commands.runTomcatArtifacts());
  for (const dep of artifactDeps) {
    const artifact = dep.artifact ? artifacts.find((a) => a.id === dep.artifact) : artifacts[0];
    if (!artifact) return false;
    const info = await call(commands.javaResolveLaunch(artifact.module, false, "make", nextRequestId())).catch(
      () => null,
    );
    if (!info) return false;
    if (info.build === "failed" || info.build === "withErrors" || info.build === "cancelled")
      throw updateBuildError(info);
    const synced = await call(commands.runTomcatSync(config, artifact.module, info.classPaths, resourcesOnly));
    if (!synced) return false;
  }
  return true;
}

export function tomcatBrowserUrl(config: RunConfig): string {
  const p = config.params ?? {};
  const first = getTomcatDeployments(config)[0];
  const host = "localhost";
  const name =
    first?.artifactName ||
    first?.deploymentPath
      ?.replace(/\\/g, "/")
      .split("/")
      .pop()
      ?.replace(/\.war$/i, "") ||
    p.artifactName ||
    p.deploymentPath
      ?.replace(/\\/g, "/")
      .split("/")
      .pop()
      ?.replace(/\.war$/i, "") ||
    "";
  const context = first?.contextPath || p.contextPath || (name && name !== "ROOT" ? `/${name}` : "/");
  return p.browserUrl || `http://${host}:${p.httpPort || "8080"}${context === "/" ? "/" : `${context}/`}`;
}
