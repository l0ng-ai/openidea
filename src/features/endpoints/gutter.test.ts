import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { computeMarks, endpointLines, endpointMenuItems, endpointsAt } from "./gutter";
import { endpoint } from "./testEndpoint";

const MAIN = "/p/app/config/routes.rb";
const ADMIN = "/p/app/config/routes/admin.rb";

const ENDPOINTS = [
  endpoint("GET", "/photos", "photos#index", { line: 4 }),
  endpoint("POST", "/photos", "photos#create", { line: 4 }),
  endpoint("GET", "/photos/:id", "photos#show", { line: 4 }),
  endpoint("ANY", "/sidekiq", "Sidekiq::Web", { line: 9 }),
  endpoint("GET", "/admin/stats", "admin/stats#index", { file: ADMIN, line: 2 }),
];

describe("endpoints gutter", () => {
  it("finds the endpoints of a line and the lines with endpoints", () => {
    expect(endpointsAt(ENDPOINTS, MAIN, 4).map((e) => e.target)).toEqual([
      "photos#index",
      "photos#create",
      "photos#show",
    ]);
    expect(endpointsAt(ENDPOINTS, ADMIN, 4)).toEqual([]);
    expect(endpointLines(ENDPOINTS, MAIN)).toEqual([4, 9]);
    expect(endpointLines(ENDPOINTS, ADMIN)).toEqual([2]);
  });

  it("marks the declaring lines of the file, within the document", () => {
    const state = EditorState.create({ doc: "a\nb\nc\nresources :photos\ne\nf\ng\nh\nmount X\n" });
    const marks = computeMarks(state, MAIN, ENDPOINTS);
    expect(marks.map((m) => [state.doc.lineAt(m.pos).number, m.title, m.endpoints.length])).toEqual([
      [4, "3 endpoints", 3],
      [9, "ANY /sidekiq → Sidekiq::Web", 1],
    ]);
    // A table from a longer, earlier version of the file: lines past the end are dropped.
    expect(computeMarks(EditorState.create({ doc: "x\n" }), MAIN, ENDPOINTS)).toEqual([]);
  });

  it("offers one submenu per endpoint when a line declares several", () => {
    const single = endpointMenuItems(ENDPOINTS.slice(3, 4));
    expect(single.map((i) => ("label" in i ? i.label : i.kind))).toEqual([
      "Generate Request in HTTP Client",
      "Show in Endpoints",
    ]);
    const several = endpointMenuItems(ENDPOINTS.slice(0, 3));
    expect(several.map((i) => ("label" in i ? i.label : i.kind))).toEqual([
      "GET /photos",
      "POST /photos",
      "GET /photos/:id",
      "separator",
      "Generate Requests for All Endpoints Here",
    ]);
  });
});
