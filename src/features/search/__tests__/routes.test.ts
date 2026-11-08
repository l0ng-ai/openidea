import { describe, expect, it } from "vitest";
import type { EndpointEntry } from "@/workbench/contributions";
import { matchRoutes } from "../everywhere/routes";

const route = (over: Partial<EndpointEntry> = {}): EndpointEntry => ({
  method: "POST",
  url: "/deeplink/menu/search",
  controller: "DeepLinkController",
  methodName: "searchMenus",
  path: "/p/tg-tenant-server/src/main/java/DeepLinkController.java",
  rel: "tg-tenant-server/src/main/java/DeepLinkController.java",
  line: 45,
  col: 4,
  ...over,
});

const routes: EndpointEntry[] = [
  route(),
  route({
    method: "GET",
    url: "/deeplink/menu/{menuId}",
    methodName: "getMenuDetail",
    line: 52,
    col: 4,
  }),
];

describe("endpoints in Search Everywhere", () => {
  it("finds a controller method by the request path it answers", () => {
    for (const query of [
      "/deeplink/menu/search",
      "deeplink/menu/search",
      "/tg-tenant/deeplink/menu/search",
      "POST /tg-tenant/deeplink/menu/search",
      "post /deeplink/menu/search",
    ]) {
      const { items } = matchRoutes(routes, query, 5);
      expect(items[0]?.container, query).toBe("DeepLinkController.searchMenus");
      expect(items[0]?.display, query).toBe("POST /deeplink/menu/search");
    }
  });

  it("honours an HTTP method prefix", () => {
    expect(matchRoutes(routes, "GET /deeplink/menu/x", 5).items).toEqual([]);
    expect(matchRoutes(routes, "GET /deeplink/menu", 5).items[0]?.container).toBe("DeepLinkController.getMenuDetail");
  });

  it("finds it by controller or method name too", () => {
    expect(matchRoutes(routes, "searchMenus", 5).items[0]?.container).toBe("DeepLinkController.searchMenus");
    expect(matchRoutes(routes, "DeepLinkController.getMenuDetail", 5).items[0]?.container).toBe(
      "DeepLinkController.getMenuDetail",
    );
    expect(matchRoutes(routes, "deeplink", 5).items).toHaveLength(2);
  });

  it("finds a named route by its name and keeps routes answering several methods", () => {
    const named = [
      ...routes,
      route({
        method: "PUT|PATCH",
        url: "/posts/{post}",
        name: "posts.update",
        detail: "posts.update · PostController@update",
      }),
    ];
    expect(matchRoutes(named, "posts.update", 5).items[0]?.container).toBe("posts.update · PostController@update");
    expect(matchRoutes(named, "update", 5).items[0]?.display).toBe("PUT|PATCH /posts/{post}");
    expect(matchRoutes(named, "PATCH /posts/{post}", 5).items).toHaveLength(1);
    expect(matchRoutes(named, "DELETE /posts/{post}", 5).items).toEqual([]);
  });

  it("says nothing for an empty or unrelated query", () => {
    expect(matchRoutes(routes, "", 5).items).toEqual([]);
    expect(matchRoutes(routes, "   ", 5).items).toEqual([]);
    expect(matchRoutes(routes, "unrelated-thing", 5).items).toEqual([]);
  });
});
