import { describe, expect, it } from "vitest";
import type { EndpointDecl, PluginEndpoint } from "@/bindings";
import { affectsProvider, globMatcher, providerId, toEndpoint } from "./pluginProviders";

const ROOT = "/p/app";
const DECL: EndpointDecl = {
  framework: "Rails",
  command: "endpoints",
  markers: ["config/routes.rb"],
  watch: ["config/routes.rb", "config/routes/*.rb", "lib/**/routes.rb"],
};

describe("plugin endpoint providers", () => {
  it("matches project-relative globs", () => {
    expect(globMatcher("config/routes/*.rb")("config/routes/admin.rb")).toBe(true);
    expect(globMatcher("config/routes/*.rb")("config/routes/api/v1.rb")).toBe(false);
    expect(globMatcher("lib/**/routes.rb")("lib/routes.rb")).toBe(true);
    expect(globMatcher("lib/**/routes.rb")("lib/a/b/routes.rb")).toBe(true);
    expect(globMatcher("src/**")("src/main/java/A.java")).toBe(true);
    expect(globMatcher("app/?.rb")("app/a.rb")).toBe(true);
    expect(globMatcher("app/?.rb")("app/ab.rb")).toBe(false);
    expect(globMatcher("a.b")("axb")).toBe(false);
  });

  it("re-runs on watched files and on the files the table reported", () => {
    const files = [`${ROOT}/config/routes.rb`, `${ROOT}/config/routes/shared.rb`];
    expect(affectsProvider(`${ROOT}/config/routes/admin.rb`, ROOT, DECL, files)).toBe(true);
    expect(affectsProvider(`${ROOT}/config/routes/shared.rb`, ROOT, DECL, [])).toBe(true);
    expect(affectsProvider(`${ROOT}/config/routes/shared.rb`, ROOT, { ...DECL, watch: [] }, files)).toBe(true);
    expect(affectsProvider(`${ROOT}/app/models/photo.rb`, ROOT, DECL, files)).toBe(false);
    expect(affectsProvider("/elsewhere/config/routes.rb", ROOT, DECL, files)).toBe(false);
  });

  it("maps a plugin endpoint to the window's model, with a default request", () => {
    const base: PluginEndpoint = {
      method: "GET",
      path: "/photos/:id",
      target: "photos#show",
      targetClass: "PhotosController",
      name: "photo",
      file: `${ROOT}/config/routes.rb`,
      line: 4,
      docs: [["Helper", "photo_path"]],
    };
    const e = toEndpoint(base, providerId("rails", 0), DECL, "app");
    expect(e).toMatchObject({
      id: "plugin:rails:0:/p/app/config/routes.rb:4 GET /photos/:id photos#show",
      framework: "Rails",
      type: "HTTP",
      module: "app",
      targetClass: "PhotosController",
      docs: [["Helper", "photo_path"]],
    });
    expect(e.request).toEqual({ name: "photos#show", method: "GET", url: "http://localhost/photos/:id", headers: [] });
    const withRequest = toEndpoint(
      {
        ...base,
        method: "ANY",
        targetClass: "",
        request: {
          method: "POST",
          url: "http://localhost:3000/photos",
          headers: [{ name: "Accept", value: "*/*" }],
          body: "{}",
        },
      },
      providerId("rails", 0),
      { ...DECL, type: "WebSocket", icon: "file-ruby" },
      "app",
    );
    expect(withRequest.targetClass).toBe("photos#show");
    expect(withRequest.type).toBe("WebSocket");
    expect(withRequest.icon).toBe("file-ruby");
    expect(withRequest.request).toMatchObject({
      method: "POST",
      body: "{}",
      headers: [{ name: "Accept", value: "*/*" }],
    });
  });
});
