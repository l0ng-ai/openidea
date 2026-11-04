/**
 * Feature activation. Each feature exports `activate(): void | (() => void)`
 * that registers actions, tool windows, status items and services, returning
 * a disposer. The editor provides the editor service; app must install its launch
 * barrier before welcome can restore a remembered project.
 */
import { activate as projectTrust } from "./project-trust";
import { activate as editor } from "@/editor/core";
import { activate as editorLsp } from "@/editor/lsp";
import { activate as welcome } from "./welcome";
import { activate as projectTree } from "./project-tree";
import { activate as search } from "./search";
import { activate as dependencies } from "./dependencies";
import { activate as codeInsight } from "./code-insight";
import {
  activate as vcs,
  activateComparisonWindow,
  activateDiffViewer,
  activateSettingsPages as vcsPages,
} from "./vcs";
import { activate as terminal } from "./terminal";
import { activate as run } from "./run";
import { activate as runAnything } from "./run-anything";
import { activate as macros } from "./macros";
import { activate as debuggerFeature } from "./debugger";
import { activate as coverage } from "./coverage";
import { activate as colorPreview } from "./color-preview";
import { activate as profiler } from "./profiler";
import { activate as buildTools } from "./build-tools";
import { activate as build } from "./build";
import { activate as templates, activateSettingsPages as templatesPages } from "./templates";
import { activate as todo, activateSettingsPages as todoPages } from "./todo";
import { activate as settings, activateRuntimeSettings, activateSettingsWindow } from "./settings";
import { activate as app, activateLocale as appLocale, activateMenuBridge, confirmLeave } from "./app";
import { activate as perf } from "./perf";
import { activate as plugins, activateSettingsPages as pluginsPages } from "./plugins";
import { activate as tools, activateSettingsPages as toolsPages } from "./tools";
import { activate as scratch } from "./scratch";
import { activate as libraries } from "./libraries";
import { activate as viewers } from "./viewers";
import { activate as notebook } from "./notebook";
import { activate as web } from "./web";
import { activate as analysis } from "./analysis";
import { activate as services } from "./services";
import { activate as github } from "./github";
import { activate as httpClient } from "./http-client";
import { activate as database } from "./database";
import { activate as graphql } from "./graphql";
import { activate as deployment, activateDeploymentWindow } from "./deployment";
import { activate as agents, activateSettingsPages as agentsPages } from "./agents";
import { activate as vim, activateSettingsPages as vimPages } from "./vim";
import { activate as ssh } from "./ssh";
import { activate as remoteDev } from "./remote-dev";

type Activate = () => void | (() => void);

const features: Array<[string, Activate]> = [
  ["project-trust", projectTrust],
  ["editor", editor],
  ["editor-lsp", editorLsp],
  ["app", app],
  ["welcome", welcome],
  ["project-tree", projectTree],
  ["search", search],
  ["code-insight", codeInsight],
  ["dependencies", dependencies],
  ["vcs", vcs],
  ["terminal", terminal],
  ["run", run],
  ["run-anything", runAnything],
  ["macros", macros],
  ["debugger", debuggerFeature],
  ["coverage", coverage],
  ["color-preview", colorPreview],
  ["profiler", profiler],
  ["build-tools", buildTools],
  ["build", build],
  ["templates", templates],
  ["todo", todo],
  ["settings", settings],
  ["perf", perf],
  ["plugins", plugins],
  ["tools", tools],
  ["scratch", scratch],
  ["libraries", libraries],
  ["notebook", notebook],
  ["viewers", viewers],
  ["web", web],
  ["analysis", analysis],
  ["services", services],
  ["github", github],
  ["http-client", httpClient],
  ["database", database],
  ["graphql", graphql],
  ["deployment", deployment],
  ["agents", agents],
  ["vim", vim],
  ["ssh", ssh],
  ["remote-dev", remoteDev],
];

function activateAll(what: string, list: Array<[string, Activate]>): () => void {
  const disposers: Array<() => void> = [];
  for (const [name, activate] of list) {
    try {
      const d = activate();
      if (d) disposers.push(d);
    } catch (e) {
      console.error(`${what} of ${name} failed to activate`, e);
    }
  }
  return () => disposers.reverse().forEach((d) => d());
}

export function activateFeatures(): () => void {
  return activateAll("feature", features);
}

export { SettingsWindow } from "./settings";
export { ComparisonWindow } from "./vcs";
export { DeploymentWindow } from "./deployment";

/**
 * A comparison window of project window `parent`: the changed files between two revisions and
 * their diffs, with the editor and Git but no workbench.
 */
export function activateComparisonWindowFeatures(parent: string): () => void {
  return activateAll("comparison window", [
    ["locale", appLocale],
    ["settings", activateRuntimeSettings],
    ["menu", activateMenuBridge],
    ["editor", editor],
    ["vcs", vcs],
    ["comparison", () => activateComparisonWindow(parent, (project) => confirmLeave(undefined, project))],
  ]);
}

/**
 * The Sync with Deployed window of project window `parent`: local files next to their copies on a
 * deployment server, with the diff viewer but no workbench.
 */
export function activateDeploymentWindowFeatures(parent: string): () => void {
  return activateAll("deployment window", [
    ["locale", appLocale],
    ["settings", activateRuntimeSettings],
    ["diff", activateDiffViewer],
    ["deployment", () => activateDeploymentWindow(parent)],
  ]);
}

/**
 * The native Settings window of project window `parent`: only the settings
 * pages (no workbench, project, editors or background services).
 */
export function activateSettingsWindowFeatures(parent: string): () => void {
  const pages: Array<[string, Activate]> = [
    ["project-trust", projectTrust],
    ["locale", appLocale],
    ["settings", () => activateSettingsWindow(parent)],
    ["templates", templatesPages],
    ["todo", todoPages],
    ["plugins", pluginsPages],
    ["tools", toolsPages],
    ["agents", agentsPages],
    ["vim", vimPages],
    ["vcs", vcsPages],
  ];
  return activateAll("settings pages", pages);
}
