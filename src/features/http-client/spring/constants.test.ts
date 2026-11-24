import { describe, expect, it, vi } from "vitest";
import { ConstantPool, type ConstantFiles } from "./constants";
import { controllersOf } from "./endpoints";
import { parseSource } from "./source";

function project(files: Record<string, string>): ConstantFiles & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    filesNamed: vi.fn(async (name: string) => Object.keys(files).filter((p) => p.endsWith(`/${name}`))),
    read: async (path) => {
      reads.push(path);
      return files[path] ?? null;
    },
  };
}

async function paths(text: string, files: ConstantFiles) {
  const file = parseSource(text);
  const pool = new ConstantPool(files);
  await pool.load([file]);
  return controllersOf(file, pool.resolverFor(file)).flatMap((c) =>
    c.endpoints.map((e) => `${e.httpMethod} ${e.paths}`),
  );
}

const defines = {
  "/p/common/src/main/java/com/acme/common/AppServiceDefine.java": `package com.acme.common;
public interface AppServiceDefine {
    String API_WEBAPI_PREFIX = "/api";
}`,
  "/p/cockpit/src/main/java/com/acme/cockpit/CockpitApiDefine.java": `package com.acme.cockpit;
public interface CockpitApiDefine {
    String API_COCKPIT_PREFIX = "/cockpit";
    String PATH_MAP = "/map";
}`,
};

describe("mapping constants of other classes", () => {
  it("joins constants of interfaces in other files and modules", async () => {
    const files = project(defines);
    const text = `package com.acme.cockpit.web;
import com.acme.common.AppServiceDefine;
import com.acme.cockpit.CockpitApiDefine;
@RestController
@RequestMapping(AppServiceDefine.API_WEBAPI_PREFIX + CockpitApiDefine.API_COCKPIT_PREFIX)
public class CockpitMapController {
    @GetMapping(CockpitApiDefine.PATH_MAP + "/layers")
    public MapLayerVO layers(@RequestParam(required = false) String type) { return null; }
}`;
    expect(await paths(text, files)).toEqual(["GET /api/cockpit/map/layers"]);
  });

  it("follows static imports, superclasses and constants built from other classes", async () => {
    const files = project({
      ...defines,
      "/p/web/src/main/java/com/acme/web/Routes.java": `package com.acme.web;
import com.acme.common.AppServiceDefine;
public final class Routes {
    public static final String ORDERS = AppServiceDefine.API_WEBAPI_PREFIX + "/orders";
}`,
      "/p/web/src/main/java/com/acme/web/BaseController.java": `package com.acme.web;
public abstract class BaseController {
    protected static final String ITEMS = "/items";
}`,
    });
    const text = `package com.acme.web;
import static com.acme.web.Routes.ORDERS;
@RestController
@RequestMapping(ORDERS)
public class OrderController extends BaseController {
    @GetMapping(ITEMS + "/{id}")
    public Item item(@PathVariable String id) { return null; }
}`;
    expect(await paths(text, files)).toEqual(["GET /api/orders/items/{id}"]);
  });

  it("prefers the imported package when several classes share the name", async () => {
    const files = project({
      "/p/a/src/main/java/com/a/Paths.java": `package com.a;\npublic interface Paths { String ROOT = "/a"; }`,
      "/p/b/src/main/java/com/b/Paths.java": `package com.b;\npublic interface Paths { String ROOT = "/b"; }`,
    });
    const text = `package com.app;
import com.b.Paths;
@RestController
class C {
    @GetMapping(Paths.ROOT)
    String get() { return ""; }
}`;
    expect(await paths(text, files)).toEqual(["GET /b"]);
  });

  it("looks each class up once, and leaves out a constant no project file declares", async () => {
    const files = project(defines);
    const text = `@RestController
class C {
    @GetMapping(Missing.PATH)
    String a() { return ""; }
    @GetMapping(CockpitApiDefine.PATH_MAP)
    String b() { return ""; }
    @PostMapping(CockpitApiDefine.PATH_MAP + "/x")
    String c() { return ""; }
}`;
    expect(await paths(text, files)).toEqual(["GET /", "GET /map", "POST /map/x"]);
    expect(files.reads).toEqual(["/p/cockpit/src/main/java/com/acme/cockpit/CockpitApiDefine.java"]);
  });
});
