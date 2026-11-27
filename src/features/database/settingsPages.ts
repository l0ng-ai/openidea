import { lazyComponent } from "@/ui";
import { registerSettingsPage } from "@/workbench/contributions";

/** Settings › Languages & Frameworks › SQL Resolution Scopes (also used by the Settings window). */
export function activateSettingsPages(): () => void {
  return registerSettingsPage({
    id: "languages.sqlResolutionScopes",
    title: "SQL Resolution Scopes",
    group: "Languages & Frameworks",
    order: 404.5,
    projectScope: true,
    defaultScope: "project",
    keywords: ["sql", "data source", "database", "schema", "mybatis", "mapper", "resolve", "dialect"],
    component: lazyComponent(() => import("./SqlScopesPage").then((m) => m.SqlScopesPage)),
  });
}
