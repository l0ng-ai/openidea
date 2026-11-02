import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import type { DataSource } from "@/bindings";
import { placeLinks, placeMarkers, placedLinkAt } from "./editor";
import {
  defaultSchemaOf,
  dependsOn,
  globMatcher,
  linkAt,
  matchesFile,
  targetLabel,
  targetLocation,
  type NavLink,
} from "./model";

const ROOT = "/p/app";
const DECL = { files: ["config/routes.rb", "config/routes/*.rb", "app/controllers/**/*.rb"] };

const link = (line: number, from: number, to: number, file = "a.rb"): NavLink => ({
  line,
  from,
  to,
  targets: [{ file: `${ROOT}/${file}` }],
});

describe("code navigation model", () => {
  it("matches project-relative globs", () => {
    expect(globMatcher("config/routes/*.rb")("config/routes/admin.rb")).toBe(true);
    expect(globMatcher("config/routes/*.rb")("config/routes/api/v1.rb")).toBe(false);
    expect(globMatcher("lib/**/routes.rb")("lib/routes.rb")).toBe(true);
    expect(globMatcher("lib/**/routes.rb")("lib/a/b/routes.rb")).toBe(true);
    expect(globMatcher("app/views/**")("app/views/photos/show.html.erb")).toBe(true);
    expect(globMatcher("app/?.rb")("app/a.rb")).toBe(true);
    expect(globMatcher("app/?.rb")("app/ab.rb")).toBe(false);
    expect(globMatcher("a.b")("axb")).toBe(false);
  });

  it("asks about the files the declaration's globs cover", () => {
    expect(matchesFile(DECL, ROOT, `${ROOT}/config/routes.rb`)).toBe(true);
    expect(matchesFile(DECL, ROOT, `${ROOT}/config/routes/admin.rb`)).toBe(true);
    expect(matchesFile(DECL, ROOT, `${ROOT}/app/controllers/admin/photos_controller.rb`)).toBe(true);
    expect(matchesFile(DECL, ROOT, `${ROOT}/app/models/photo.rb`)).toBe(false);
    expect(matchesFile(DECL, ROOT, "/elsewhere/config/routes.rb")).toBe(false);
    expect(matchesFile({ files: [] }, ROOT, `${ROOT}/config/routes.rb`)).toBe(false);
  });

  it("re-runs when a reported file or directory changes", () => {
    const deps = [`${ROOT}/config/routes.rb`, `${ROOT}/app/views/photos`];
    expect(dependsOn(deps, `${ROOT}/config/routes.rb`)).toBe(true);
    expect(dependsOn(deps, `${ROOT}/app/views/photos/show.html.erb`)).toBe(true);
    expect(dependsOn(deps, `${ROOT}/app/views/photos.rb`)).toBe(false);
    expect(dependsOn(deps, `${ROOT}/config/routes/admin.rb`)).toBe(false);
  });

  it("finds the narrowest link at a line and column, end inclusive", () => {
    const links = [link(6, 17, 34), link(6, 20, 26, "b.rb"), link(7, 0, 5, "c.rb")];
    expect(linkAt(links, 6, 17)).toBe(links[0]);
    expect(linkAt(links, 6, 34)).toBe(links[0]);
    expect(linkAt(links, 6, 22)).toBe(links[1]);
    expect(linkAt(links, 6, 16)).toBeNull();
    expect(linkAt(links, 6, 35)).toBeNull();
    expect(linkAt(links, 7, 2)).toBe(links[2]);
    expect(linkAt(links, 8, 2)).toBeNull();
  });

  it("maps targets to editor locations and labels", () => {
    expect(targetLocation({ file: "/p/a.rb", line: 3, col: 2 })).toEqual({
      path: "/p/a.rb",
      range: { start: { line: 2, col: 2 }, end: { line: 2, col: 2 } },
    });
    expect(targetLocation({ file: "/p/a.rb" })?.range.start).toEqual({ line: 0, col: 0 });
    expect(targetLocation({ table: "photos" })).toBeNull();
    expect(targetLabel({ file: "/p/app/controllers/photos_controller.rb" })).toBe("photos_controller.rb");
    expect(targetLabel({ table: "photos", schema: "public" })).toBe("public.photos");
    expect(targetLabel({ table: "photos", title: "photos in Database" })).toBe("photos in Database");
  });

  it("picks the schema a table opens in", () => {
    const pg: DataSource = { id: "1", driver: "postgres" };
    expect(defaultSchemaOf(pg, "app")).toBe("app");
    expect(defaultSchemaOf({ ...pg, options: { defaultSchema: "crm" } })).toBe("crm");
    expect(defaultSchemaOf(pg)).toBe("public");
    expect(defaultSchemaOf({ id: "2", driver: "sqlite" })).toBe("main");
    expect(defaultSchemaOf({ id: "3", driver: "sqlServer" })).toBe("dbo");
    expect(defaultSchemaOf({ id: "4", driver: "mysql", database: "shop" })).toBe("shop");
  });

  it("places links and markers as offsets of the document, clipped to it", () => {
    const doc = Text.of(["Rails.application.routes.draw do", '  get "up" => "rails/health#show"', "end"]);
    const placed = placeLinks(doc, [link(2, 14, 33), link(2, 30, 99, "b.rb"), link(9, 0, 3, "c.rb"), link(1, 5, 5)]);
    expect(placed.map((l) => [l.from, l.to, doc.sliceString(l.from, l.to)])).toEqual([
      [47, 66, '"rails/health#show"'],
      [63, 66, 'ow"'],
    ]);
    expect(placedLinkAt(placed, 64)?.link.targets[0]?.file).toBe(`${ROOT}/b.rb`);
    expect(placedLinkAt(placed, 50)?.link.targets[0]?.file).toBe(`${ROOT}/a.rb`);
    expect(placedLinkAt(placed, 46)).toBeNull();
    const markers = placeMarkers(doc, [
      { line: 3, targets: [] },
      { line: 1, targets: [{ table: "t" }] },
      { line: 4, targets: [] },
    ]);
    expect(markers.map((m) => [m.pos, m.marker.line])).toEqual([
      [0, 1],
      [67, 3],
    ]);
  });
});
