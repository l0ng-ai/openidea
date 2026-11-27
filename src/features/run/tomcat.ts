import { call, commands, nextRequestId, type RunConfig } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { resolveJavaLaunch } from "@/platform/javaLaunch";
import { followLaunchBuild } from "@/features/build/store";
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

/** One entry of a Tomcat config's Deployment list (IDEA's "Deploy at the server startup"). */
export interface TomcatDeployment {
  deployment: "artifact" | "war" | "directory";
  artifact?: string;
  artifactName?: string;
  deploymentPath?: string;
  contextPath?: string;
  contextDescriptor?: string;
  /** The artifact's module (the config's `cwd` for the first deployment). */
  module?: string;
}

const DEPLOYMENT_KEYS = [
  "deployment",
  "artifact",
  "artifactName",
  "deploymentPath",
  "contextPath",
  "contextDescriptor",
] as const;

function deploymentKind(value: string | undefined): TomcatDeployment["deployment"] {
  return value === "war" || value === "directory" ? value : "artifact";
}

function isConfigured(d: TomcatDeployment): boolean {
  return d.deployment === "artifact" ? !!d.artifact : !!d.deploymentPath?.trim();
}

/**
 * The deployments of a Tomcat config, in order. The first lives in the config's own params (so
 * configs from before the list need no migration), the rest as JSON in `extraDeployments`.
 */
export function tomcatDeployments(config: RunConfig): TomcatDeployment[] {
  const p = config.params ?? {};
  const first: TomcatDeployment = {
    deployment: deploymentKind(p.deployment),
    ...Object.fromEntries(DEPLOYMENT_KEYS.slice(1).flatMap((k) => (p[k] ? [[k, p[k]]] : []))),
    ...(config.cwd ? { module: config.cwd } : {}),
  };
  return [first, ...extraDeployments(config)].filter(isConfigured);
}

/** The deployments after the first, as stored in `extraDeployments`. */
function extraDeployments(config: RunConfig): TomcatDeployment[] {
  try {
    const raw = config.params?.extraDeployments;
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((d): d is Record<string, string> => !!d && typeof d === "object")
      .map((d) => ({ ...d, deployment: deploymentKind(d.deployment) }));
  } catch {
    return [];
  }
}

/** `config` deploying `list`: the first entry in its own params and `cwd`, the rest in `extraDeployments`. */
export function withTomcatDeployments(config: RunConfig, list: readonly TomcatDeployment[]): RunConfig {
  const params = { ...(config.params ?? {}) };
  for (const key of DEPLOYMENT_KEYS) delete params[key];
  delete params.extraDeployments;
  const [first, ...rest] = list;
  params.deployment = first?.deployment ?? "artifact";
  if (first) for (const key of DEPLOYMENT_KEYS.slice(1)) if (first[key]) params[key] = first[key];
  if (rest.length) params.extraDeployments = JSON.stringify(rest);
  return { ...config, cwd: first ? (first.module ?? null) : config.cwd, params };
}

/**
 * Each deployment as a config of its own, the way the backend splits them
 * (`ide_run::tomcat::deployment_configs`): builds and syncs run per deployment.
 */
export function tomcatDeploymentConfigs(config: RunConfig): RunConfig[] {
  // The first is the config itself, even without an artifact chosen (the backend then takes the first WAR artifact).
  const extras = extraDeployments(config).map((d, i) => {
    const params = { ...(config.params ?? {}) };
    for (const key of DEPLOYMENT_KEYS) delete params[key];
    delete params.extraDeployments;
    for (const key of DEPLOYMENT_KEYS) if (d[key]) params[key] = d[key];
    params.deploymentIndex = String(i + 1);
    return { ...config, cwd: d.module ?? null, params };
  });
  return [config, ...extras];
}

/** Builds the WAR of every artifact deployment that is out of date. */
export async function buildTomcatArtifact(config: RunConfig): Promise<void> {
  for (const deployment of tomcatDeploymentConfigs(config)) {
    if ((deployment.params?.deployment ?? "artifact") !== "artifact") continue;
    // oxlint-disable-next-line no-await-in-loop -- one build at a time, like IDEA's Before launch
    const build = await call(commands.runTomcatBuild(deployment));
    // oxlint-disable-next-line no-await-in-loop
    if (build) await runUpdateBuild(build);
  }
}

/**
 * Updates running artifact deployments without rebuilding their WARs: compiles each WAR module
 * incrementally and copies its changed classes, resources and web files into its deployment.
 * `false` when that isn't possible for one of them (other deployment kinds, no Java language
 * server, a changed dependency module): the caller rebuilds the WARs.
 */
export async function syncTomcatOutputs(
  config: RunConfig,
  resourcesOnly: boolean,
  buildPolicy: "make" | "noBuild" = "make",
): Promise<boolean> {
  const deployments = tomcatDeploymentConfigs(config);
  if (deployments.some((d) => (d.params?.deployment ?? "artifact") !== "artifact")) return false;
  const artifacts = await call(commands.runTomcatArtifacts());
  for (const deployment of deployments) {
    const p = deployment.params ?? {};
    const artifact = p.artifact ? artifacts.find((a) => a.id === p.artifact) : artifacts[0];
    if (!artifact) return false;
    const request = nextRequestId();
    // oxlint-disable-next-line no-await-in-loop -- deployments compile and copy in turn
    const info = await resolveJavaLaunch(
      artifact.module,
      false,
      buildPolicy,
      request,
      followLaunchBuild(request, tx`Build before launch: ${config.name}`),
    ).catch(() => null);
    if (!info) return false;
    if (info.build === "failed" || info.build === "withErrors" || info.build === "cancelled")
      throw updateBuildError(info);
    // oxlint-disable-next-line no-await-in-loop
    if (!(await call(commands.runTomcatSync(deployment, artifact.module, info.classPaths, resourcesOnly))))
      return false;
  }
  return true;
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
