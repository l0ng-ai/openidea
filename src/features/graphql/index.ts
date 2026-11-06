/**
 * GraphQL (IDEA's GraphQL plugin, scoped): the GraphQL tool window listing the
 * project's schemas from graphql-config (or the default project-wide schema),
 * their errors and endpoints, and running a query against an endpoint. Editing
 * support (completion, diagnostics, navigation) comes from `graphql-lsp`,
 * declared in `languages/graphql.toml`.
 */
import { activeEditor, registerEditorContribution } from "@/editor/api";
import { registerActions } from "@/platform/actions";
import { onFileOperation } from "@/platform/fileOps";
import { basename, useProject } from "@/platform/project";
import { registerOverlay, registerToolWindow, toolWindowService } from "@/workbench/contributions";
import { EnvironmentDialogOverlay } from "./EnvironmentDialog";
import { GRAPHQL_LANGUAGE, graphqlEditorExtension, runFromView } from "./editor";
import { GraphQLTabs, GraphQLView } from "./GraphQLView";
import { isConfigFile, isSchemaFile } from "./model";
import {
  TOOL_WINDOW,
  addSchemaConfiguration,
  discoverSchemasNow,
  openConfiguration,
  rerunIntrospection,
  resetGraphQL,
  useGraphQL,
} from "./store";

function activeGraphQLEditor() {
  const e = activeEditor();
  return e && e.ctx.language === GRAPHQL_LANGUAGE ? e : null;
}

export function activate(): () => void {
  const disposers = [
    registerToolWindow({
      id: TOOL_WINDOW,
      title: "GraphQL",
      icon: "toolwindow-graphql",
      anchor: "bottom",
      // IDEA's stripe: right above Git (order 5).
      order: 4,
      stripe: "onUse",
      component: GraphQLView,
      headerContent: GraphQLTabs,
    }),
    registerEditorContribution({ id: "graphql.toolbar", order: 58, extensions: graphqlEditorExtension }),
    registerOverlay({ id: "graphql.environment", component: EnvironmentDialogOverlay }),
    // A reopened project starts over.
    useProject.subscribe((s, prev) => {
      if (s.project?.root !== prev.project?.root) resetGraphQL();
    }),
    // New or deleted schema / config files change what discovery finds.
    onFileOperation((op) => {
      if (!useGraphQL.getState().projects) return;
      if (op.paths.some((p) => isSchemaFile(basename(p)) || isConfigFile(basename(p)))) void discoverSchemasNow();
    }),
    registerActions([
      {
        id: "graphql.showToolWindow",
        title: "GraphQL",
        category: "Tools",
        icon: "toolwindow-graphql",
        keywords: ["schema", "endpoints", "graphql-config"],
        when: "projectOpen",
        run: () => toolWindowService().show(TOOL_WINDOW, true),
      },
      {
        id: "graphql.addConfiguration",
        title: "Add Schema Configuration",
        description: "Open the project's graphql-config, creating graphql.config.yml when there is none",
        category: "Tools",
        icon: "plus",
        keywords: ["graphql", "graphql-config", "graphqlrc", "schema"],
        when: "projectOpen",
        run: () => addSchemaConfiguration(),
      },
      {
        id: "graphql.editConfiguration",
        title: "Open Configuration File",
        description: "Opens the GraphQL config file for the current file's schema",
        category: "Tools",
        icon: "settings",
        keywords: ["graphql", "graphql-config", "graphqlrc", "settings"],
        when: "projectOpen",
        run: () => openConfiguration(activeGraphQLEditor()?.ctx.path),
      },
      {
        id: "graphql.introspect",
        title: "Rerun Introspection Query",
        description: "Reruns the latest introspection query to update the local schema file",
        category: "Tools",
        icon: "refresh",
        keywords: ["graphql", "introspection", "schema", "endpoint", "download"],
        when: "editorLangId == graphql",
        run: async () => {
          const e = activeGraphQLEditor();
          if (e) await rerunIntrospection(e.ctx.path);
        },
      },
      {
        id: "graphql.restartDiscovery",
        title: "Restart Schema Discovery",
        description: "Find the project's GraphQL schemas and configurations again",
        category: "Tools",
        icon: "refresh",
        keywords: ["graphql", "schema", "refresh", "reload"],
        when: "projectOpen",
        run: () => discoverSchemasNow(),
      },
      {
        id: "graphql.runQuery",
        title: "Execute GraphQL",
        description: "Executes the current GraphQL file against the specified GraphQL endpoint",
        category: "Run",
        icon: "run",
        keywords: ["graphql", "run", "execute", "query", "endpoint"],
        when: "editorTextFocus && editorLangId == graphql",
        run: async () => {
          const e = activeGraphQLEditor();
          if (e) await runFromView(e.ctx.path, e.view);
        },
      },
    ]),
  ];
  return () => disposers.forEach((d) => d());
}
