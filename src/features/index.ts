/**
 * Feature activation. Each feature exports `activate(): void | (() => void)`
 * that registers actions, tool windows, status items and services, returning
 * a disposer. The editor provides the editor service; app must install its launch
 * barrier before welcome can restore a remembered project.
 */
import { activate as mcp } from "./mcp";
import { activate as projectTrust } from "./project-trust";
import { activate as editor } from "@/editor/core";
import { activate as editorLsp } from "@/editor/lsp";
import { activate as welcome } from "./welcome";
import { activate as projectTree } from "./project-tree";
import { activate as search } from "./search";
import { activate as dependencies } from "./dependencies";
import { activate as codeInsight } from "./code-insight";
import { activate as vcs } from "./vcs";
import { activate as terminal } from "./terminal";
import { activate as run } from "./run";
import { activate as dotnet } from "./dotnet";
import { activate as runAnything } from "./run-anything";
import { activate as macros } from "./macros";
import { activate as debuggerFeature } from "./debugger";
import { activate as coverage } from "./coverage";
import { activate as colorPreview } from "./color-preview";
import { activate as profiler } from "./profiler";
import { activate as logcat } from "./logcat";
import { activate as buildTools } from "./build-tools";
import { activate as build } from "./build";
import { activate as templates } from "./templates";
import { activate as todo } from "./todo";
import { activate as settings } from "./settings";
import { activate as app } from "./app";
import { activate as perf } from "./perf";
import { activate as plugins } from "./plugins";
import { activate as tools } from "./tools";
import { activate as scratch } from "./scratch";
import { activate as libraries } from "./libraries";
import { activate as viewers } from "./viewers";
import { activate as notebook } from "./notebook";
import { activate as web } from "./web";
import { activate as analysis } from "./analysis";
import { activate as services } from "./services";
import { activate as github } from "./github";
import { activate as httpClient } from "./http-client";
import { activate as cucumber } from "./cucumber";
import { activate as rails } from "./rails";
import { activate as thymeleaf } from "./thymeleaf";
import { activate as database } from "./database";
import { activate as graphql } from "./graphql";
import { activate as deployment } from "./deployment";
import { activate as agents } from "./agents";
import { activate as vim } from "./vim";
import { activate as ssh } from "./ssh";
import { activate as lspMessages } from "./lsp-messages";
import { activate as remoteDev } from "./remote-dev";
import { activate as whatsNew } from "./whats-new";

type Activate = () => void | (() => void);

const features: Array<[string, Activate]> = [
  ["project-trust", projectTrust],
  ["editor", editor],
  ["editor-lsp", editorLsp],
  ["mcp", mcp],
  ["app", app],
  ["whats-new", whatsNew],
  ["welcome", welcome],
  ["project-tree", projectTree],
  ["search", search],
  ["code-insight", codeInsight],
  ["dependencies", dependencies],
  ["vcs", vcs],
  ["terminal", terminal],
  ["run", run],
  ["dotnet", dotnet],
  ["run-anything", runAnything],
  ["macros", macros],
  ["debugger", debuggerFeature],
  ["coverage", coverage],
  ["color-preview", colorPreview],
  ["profiler", profiler],
  ["logcat", logcat],
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
  ["cucumber", cucumber],
  ["rails", rails],
  ["thymeleaf", thymeleaf],
  ["database", database],
  ["graphql", graphql],
  ["deployment", deployment],
  ["agents", agents],
  ["vim", vim],
  ["ssh", ssh],
  ["lsp-messages", lspMessages],
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
