import { describe, expect, it, vi } from "vitest";
import { _addEditor, _removeEditor, type TextEditorHandle } from "@/editor/api";
import type { LaravelRoute } from "@/platform/ipc";
import { provideEditorService, provideNotificationService } from "@/workbench/contributions";
import { endpointEntries, routeMenuItems, routesOf, type RouteActions } from "./routes";
import { matchRoutes } from "../../search/everywhere/routes";

vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: async () => String.raw`C:\Users\me\AppData\Roaming\ai.l0ng.openidea`,
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const m = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...m,
    call: async (p: Promise<unknown>) => await p,
    commands: { ...m.commands, fsCreateDir: async () => null, fsCreateFile: async () => null },
  };
});

const SCRATCH = "C:/Users/me/AppData/Roaming/ai.l0ng.openidea/scratches/generated-requests.http";

const route = (over: Partial<LaravelRoute> = {}): LaravelRoute => ({
  name: "posts.show",
  methods: ["GET"],
  uri: "/posts/{post}",
  action: String.raw`App\Http\Controllers\PostController@show`,
  middleware: ["web"],
  path: "D:/blog/routes/web.php",
  range: { start: { line: 10, col: 7 }, end: { line: 10, col: 15 } },
  url: "http://blog.test/posts/{post}",
  request: "### posts.show\nGET http://blog.test/posts/{{post}}\n",
  ...over,
});

const recorder = () => {
  const ran: string[] = [];
  const run: RouteActions = {
    goto: (r) => void ran.push(`goto ${r.uri}`),
    copyUrl: (r) => void ran.push(`copy ${r.url}`),
    open: (r) => void ran.push(`open ${r.url}`),
    createRequest: (r) => void ran.push(`request ${r.uri}`),
  };
  return { ran, run };
};

type Item = { label?: string; submenu?: Item[]; run?: () => void };

describe("Laravel route actions", () => {
  it("reads the routes of a lens or hint command", () => {
    const json = JSON.stringify([{ ...route(), path: String.raw`D:\blog\routes\web.php` }]);
    const [parsed] = routesOf([json]);
    expect(parsed?.path).toBe("D:/blog/routes/web.php");
    expect(parsed?.name).toBe("posts.show");
    expect(routesOf([])).toEqual([]);
    expect(routesOf(["not json"])).toEqual([]);
    expect(routesOf([JSON.stringify({ uri: "/" })])).toEqual([]);
  });

  it("offers the actions of one route", () => {
    const { ran, run } = recorder();
    const items = routeMenuItems([route()], run) as Item[];
    expect(items.map((i) => i.label)).toEqual([
      "Go to Declaration",
      "Copy URL",
      "Open in Browser",
      "Create HTTP Request",
    ]);
    for (const item of items) item.run?.();
    expect(ran).toEqual([
      "goto /posts/{post}",
      "copy http://blog.test/posts/{post}",
      "open http://blog.test/posts/{post}",
      "request /posts/{post}",
    ]);
  });

  it("gives each route its own submenu when there are several", () => {
    const { ran, run } = recorder();
    const items = routeMenuItems(
      [route({ name: "posts.index", uri: "/posts" }), route({ name: null, methods: ["PUT", "PATCH"] })],
      run,
    ) as Item[];
    expect(items.map((i) => i.label)).toEqual(["GET /posts · posts.index", "PUT|PATCH /posts/{post}"]);
    items[1]?.submenu?.[0]?.run?.();
    expect(ran).toEqual(["goto /posts/{post}"]);
  });

  it("creates the HTTP request in the generated requests scratch", async () => {
    const opened: string[] = [];
    const notified: unknown[] = [];
    const dispatched: { changes?: { insert?: string } }[] = [];
    provideEditorService({ openFile: async (path: string) => void opened.push(path) } as never);
    provideNotificationService({ notify: (n: unknown) => void notified.push(n) } as never);
    const editor = {
      view: {
        state: { doc: { toString: () => "" } },
        dispatch: (spec: { changes?: { insert?: string } }) => void dispatched.push(spec),
      },
      ctx: { doc: 1, path: SCRATCH, language: "http", uiMode: null, readOnly: false },
    } as unknown as TextEditorHandle;
    _addEditor(editor);
    try {
      const items = routeMenuItems([route()]) as Item[];
      items.find((i) => i.label === "Create HTTP Request")?.run?.();
      await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    } finally {
      _removeEditor(editor);
    }
    expect(notified).toEqual([]);
    expect(opened).toEqual([SCRATCH]);
    expect(dispatched[0]?.changes?.insert).toBe("### posts.show\nGET http://blog.test/posts/{{post}}\n");
  });

  it("feeds the Routes scope of Search Everywhere", () => {
    const entries = endpointEntries(
      [
        route(),
        route({ name: "dashboard.posts.update", methods: ["PUT", "PATCH"], uri: "/dashboard/posts/{post}" }),
        route({ name: "about", uri: "/about", action: "view about" }),
      ],
      "D:/blog",
    );
    expect(entries[0]).toMatchObject({
      method: "GET",
      url: "/posts/{post}",
      controller: "PostController",
      methodName: "show",
      rel: "routes/web.php",
      line: 10,
      col: 7,
      name: "posts.show",
      detail: "posts.show · PostController@show",
    });
    expect(entries[2]).toMatchObject({ controller: "view about", methodName: "", detail: "about · view about" });

    const top = (query: string) => matchRoutes(entries, query, 5).items[0];
    expect(top("posts.show")?.display).toBe("GET /posts/{post}");
    expect(top("posts.show")?.container).toBe("posts.show · PostController@show");
    expect(top("dashboard.posts")?.display).toBe("PUT|PATCH /dashboard/posts/{post}");
    expect(top("PATCH /dashboard/posts/{post}")?.container).toBe("dashboard.posts.update · PostController@show");
    expect(top("/about")?.container).toBe("about · view about");
    expect(matchRoutes(entries, "DELETE /about", 5).items).toEqual([]);
  });
});
