import { lazyPage } from "../lazyPage";
import type { PageSpec } from "../spec";
import { INSPECTION_KEYWORDS, cachedInspectionLanguages } from "./inspectionsModel";

const InspectionsPage = lazyPage("editor.inspections", () =>
  import("./InspectionsBody").then((m) => m.InspectionsPage),
);

export const INSPECTIONS_PAGE: PageSpec = {
  id: "editor.inspections",
  title: "Inspections",
  group: "Editor",
  order: 25,
  keywords: INSPECTION_KEYWORDS,
  component: InspectionsPage,
  dynamicLabels: () => cachedInspectionLanguages().flatMap((l) => [l.name, ...l.servers]),
};
