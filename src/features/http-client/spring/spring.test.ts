import { describe, expect, it } from "vitest";
import { springAt, springControllers, type Endpoint } from "./endpoints";
import {
  appendRequests,
  bodyLookup,
  findHost,
  hostFromConfig,
  parseProperties,
  parseYaml,
  renderRequest,
  skeleton,
  type SourceReader,
} from "./request";
import { parseSource } from "./source";

const JAVA = `package com.example.demo.web;

import com.example.demo.dto.CreateUser;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.*;

/** Users { not a brace } */
@RestController
@RequestMapping(UserController.BASE + "/users")
public class UserController {
    static final String BASE = "/api";
    private static final String BY_ID = "/{id}";
    private final UserService service;

    public UserController(UserService service) { this.service = service; }

    @GetMapping
    public List<User> list(@RequestParam(defaultValue = "0") int page, @RequestParam("q") String query,
                           @RequestParam Map<String, String> all) {
        return service.list(); // "}" in a comment
    }

    @GetMapping(BY_ID)
    public User get(@PathVariable Long id, @RequestHeader("X-Trace") String trace) {
        if (id == null) { throw new IllegalArgumentException("{"); }
        return service.get(id);
    }

    @PostMapping(value = {"", "/new"}, consumes = MediaType.APPLICATION_JSON_VALUE, produces = "application/json")
    public User create(@Valid @RequestBody CreateUser body) { return service.create(body); }

    @RequestMapping(path = "/{id:\\\\d+}/avatar", method = RequestMethod.PUT)
    public void avatar(@PathVariable("id") long id, @RequestBody byte[] data) {}

    @DeleteMapping(path = BY_ID, params = "force=true", headers = "X-Api=1")
    public void delete(@PathVariable Long id) {}

    @org.springframework.web.bind.annotation.PatchMapping("/{id}/name")
    public void rename(@PathVariable Long id, @RequestBody Rename rename) {}

    public void helper() {}

    record Rename(String name, boolean notify) {}
}
`;

const KOTLIN = `package com.example.demo.web

import org.springframework.web.bind.annotation.*

const val API = "/api/v2"

@RestController
@RequestMapping(API)
class OrderController(private val service: OrderService) {
    companion object {
        const val ORDERS = "/orders"
    }

    @GetMapping("\${ORDERS}/{id}", ORDERS + "/by-id/{id}")
    fun get(@PathVariable id: Long): Order = service.get(id)

    @PostMapping(ORDERS)
    suspend fun create(@RequestBody order: NewOrder, @RequestParam(required = false) dryRun: Boolean?): Order {
        return service.create(order)
    }

    @RequestMapping(value = [ORDERS + "/search"], method = [RequestMethod.POST, RequestMethod.GET])
    fun search(@RequestParam("q") query: String) = service.search(query)
}

data class NewOrder(val item: String, val quantity: Int, val tags: List<String> = emptyList())
`;

function byMethod(endpoints: Endpoint[], name: string): Endpoint {
  const e = endpoints.find((x) => x.methodName === name);
  if (!e) throw new Error(`no endpoint ${name}`);
  return e;
}

describe("Spring mappings (Java)", () => {
  const [ctrl] = springControllers(JAVA);
  const eps = ctrl!.endpoints;

  it("finds the controller and its mapped methods only", () => {
    expect(ctrl!.name).toBe("UserController");
    expect(eps.map((e) => e.methodName)).toEqual(["list", "get", "create", "avatar", "delete", "rename"]);
    expect(JAVA.slice(byMethod(eps, "get").offset).startsWith("get(")).toBe(true);
    expect(JAVA.slice(ctrl!.offset).startsWith("UserController {")).toBe(true);
  });

  it("combines class and method paths, resolving constants of the file", () => {
    expect(byMethod(eps, "list").paths).toEqual(["/api/users"]);
    expect(byMethod(eps, "get").paths).toEqual(["/api/users/{id}"]);
    expect(byMethod(eps, "create").paths).toEqual(["/api/users", "/api/users/new"]);
    expect(byMethod(eps, "rename").paths).toEqual(["/api/users/{id}/name"]);
  });

  it("reads HTTP methods from shortcuts and RequestMapping#method", () => {
    expect(eps.map((e) => e.httpMethod)).toEqual(["GET", "GET", "POST", "PUT", "DELETE", "PATCH"]);
  });

  it("reads request parameters, headers, bodies, consumes and produces", () => {
    expect(byMethod(eps, "list").query).toEqual([
      { name: "page", value: "0" },
      { name: "q", value: null },
    ]);
    expect(byMethod(eps, "get").headers).toEqual([{ name: "X-Trace", value: "{{X-Trace}}" }]);
    const create = byMethod(eps, "create");
    expect(create).toMatchObject({
      bodyType: "CreateUser",
      consumes: "application/json",
      produces: "application/json",
    });
    expect(byMethod(eps, "delete")).toMatchObject({
      query: [{ name: "force", value: "true" }],
      headers: [{ name: "X-Api", value: "1" }],
    });
  });

  it("renders requests with path variables, query and JSON body", () => {
    const host = "http://localhost:8080";
    expect(renderRequest(byMethod(eps, "list"), { host })).toBe(
      "### UserController.list\nGET http://localhost:8080/api/users?page=0&q={{q}}\n",
    );
    expect(renderRequest(byMethod(eps, "get"), { host })).toBe(
      "### UserController.get\nGET http://localhost:8080/api/users/{{id}}\nX-Trace: {{X-Trace}}\n",
    );
    expect(renderRequest(byMethod(eps, "avatar"), { host })).toBe(
      "### UserController.avatar\nPUT http://localhost:8080/api/users/{{id}}/avatar\nContent-Type: application/json\n\n{}\n",
    );
    const file = parseSource(JAVA);
    const lookup = (n: string) => file.classes.flatMap((c) => c.classes).find((c) => c.name === n) ?? null;
    const rename = byMethod(eps, "rename");
    expect(renderRequest(rename, { host, body: skeleton(rename.bodyType!, lookup) })).toBe(
      [
        "### UserController.rename",
        "PATCH http://localhost:8080/api/users/{{id}}/name",
        "Content-Type: application/json",
        "",
        "{",
        '  "name": "",',
        '  "notify": false',
        "}",
        "",
      ].join("\n"),
    );
    expect(renderRequest(byMethod(eps, "create"), { host, path: "/api/users/new" })).toBe(
      [
        "### UserController.create",
        "POST http://localhost:8080/api/users/new",
        "Accept: application/json",
        "Content-Type: application/json",
        "",
        "{}",
        "",
      ].join("\n"),
    );
  });
});

describe("Spring mappings (Kotlin)", () => {
  const [ctrl] = springControllers(KOTLIN);
  const eps = ctrl!.endpoints;

  it("finds mappings with companion and top-level constants, arrays and suspend functions", () => {
    expect(ctrl!.name).toBe("OrderController");
    expect(eps.map((e) => [e.methodName, e.httpMethod, e.paths])).toEqual([
      ["get", "GET", ["/api/v2/orders/{id}", "/api/v2/orders/by-id/{id}"]],
      ["create", "POST", ["/api/v2/orders"]],
      ["search", "POST", ["/api/v2/orders/search"]],
    ]);
    expect(byMethod(eps, "create")).toMatchObject({ bodyType: "NewOrder", query: [{ name: "dryRun", value: null }] });
    expect(byMethod(eps, "search").query).toEqual([{ name: "q", value: null }]);
  });

  it("builds the body from a data class of the file", async () => {
    const file = parseSource(KOTLIN);
    const lookup = await bodyLookup("/p/src/main/kotlin/com/example/demo/web/OrderController.kt", file, eps, {
      read: async () => null,
    });
    expect(skeleton("NewOrder", lookup)).toEqual({ item: "", quantity: 0, tags: [] });
  });
});

describe("non-controllers", () => {
  it("ignores classes that are not controllers and files without any", () => {
    expect(springControllers('@Service class A { @GetMapping("/x") void a() {} }')).toEqual([]);
    expect(springControllers("class A {}")).toEqual([]);
    expect(
      springControllers('@FeignClient interface C { @GetMapping("/x") String a(); }\n@Controller class B {}'),
    ).toEqual([{ name: "B", offset: expect.any(Number), range: expect.any(Object), endpoints: [] }]);
  });

  it("uses GET for a RequestMapping without method and the class-level method otherwise", () => {
    const [c] = springControllers(
      '@Controller @RequestMapping(value="/a", method=RequestMethod.POST) class A { @RequestMapping("/b") String b() { return ""; } }',
    );
    expect(c!.endpoints[0]).toMatchObject({ httpMethod: "POST", paths: ["/a/b"] });
    const [d] = springControllers('@RestController class D { @RequestMapping("/b") String b() { return ""; } }');
    expect(d!.endpoints[0]).toMatchObject({ httpMethod: "GET", paths: ["/b"] });
  });
});

describe("server address", () => {
  it("reads server.port and the context path from properties", () => {
    const props = parseProperties(
      "# comment\nserver.port=9090\nserver.servlet.context-path = /shop/\nspring.application.name: demo\n",
    );
    expect(hostFromConfig([props])).toBe("http://localhost:9090/shop");
  });

  it("reads nested and flattened keys from YAML's first document", () => {
    const yml = parseYaml(
      'spring:\n  application:\n    name: demo # x\nserver:\n  port: ${PORT:8181}\n  servlet:\n    context-path: "/api"\n---\nserver:\n  port: 1\n',
    );
    expect(hostFromConfig([yml])).toBe("http://localhost:8181/api");
    expect(hostFromConfig([parseYaml("server.port: 7070\n")])).toBe("http://localhost:7070");
  });

  it("defaults to localhost:8080 and keeps unknown placeholders out", () => {
    expect(hostFromConfig([])).toBe("http://localhost:8080");
    expect(hostFromConfig([parseProperties("server.port=${PORT}\n")])).toBe("http://localhost:8080");
    expect(hostFromConfig([parseProperties("server.port=0\n")])).toBe("http://localhost:8080");
    expect(hostFromConfig([parseProperties("server.port=8443\nserver.ssl.enabled=true\n")])).toBe(
      "https://localhost:8443",
    );
    expect(hostFromConfig([parseYaml("spring:\n  webflux:\n    base-path: /rx\n")])).toBe("http://localhost:8080/rx");
  });

  it("looks in the module's src/main/resources", async () => {
    const files: Record<string, string> = {
      "/ws/api/src/main/resources/application.yml": "server:\n  port: 8001\n",
      "/ws/src/main/resources/application.properties": "server.port=9000\n",
    };
    const fs: SourceReader = { read: async (p) => files[p] ?? null };
    expect(await findHost("/ws/api/src/main/java/a/A.java", "/ws", fs)).toBe("http://localhost:8001");
    expect(await findHost("/ws/other/A.java", "/ws", fs)).toBe("http://localhost:9000");
  });

  it("reads the active profiles' files over the base ones", async () => {
    const files: Record<string, string> = {
      "/ws/api/src/main/resources/application.yml":
        "server:\n  port: 8001\n  servlet:\n    context-path: /api\nspring:\n  profiles:\n    active: ${PROFILE:local}, dev\n",
      "/ws/api/src/main/resources/application-local.properties": "server.port=7000\n",
      "/ws/api/src/main/resources/application-dev.yml": "server:\n  port: 9100\n",
    };
    const fs: SourceReader = { read: async (p) => files[p] ?? null };
    expect(await findHost("/ws/api/src/main/java/a/A.java", "/ws", fs)).toBe("http://localhost:9100/api");
    delete files["/ws/api/src/main/resources/application-dev.yml"];
    expect(await findHost("/ws/api/src/main/java/a/A.java", "/ws", fs)).toBe("http://localhost:7000/api");
  });
});

describe("body types from other files", () => {
  it("follows the import to the same source root, then the controller's directory", async () => {
    const files: Record<string, string> = {
      "/p/src/main/java/com/example/demo/dto/CreateUser.java":
        "package com.example.demo.dto;\npublic class CreateUser {\n  public static final int MAX = 3;\n  private String name;\n  private int age;\n  private Address address;\n  private List<String> roles;\n}\n",
      "/p/src/main/java/com/example/demo/dto/Address.java":
        "package com.example.demo.dto;\npublic record Address(String city, String zip) {}\n",
    };
    const fs: SourceReader = { read: async (p) => files[p] ?? null };
    const file = parseSource(JAVA);
    const eps = springControllers(JAVA)[0]!.endpoints;
    const lookup = await bodyLookup("/p/src/main/java/com/example/demo/web/UserController.java", file, eps, fs);
    expect(skeleton("CreateUser", lookup)).toEqual({ name: "", age: 0, address: { city: "", zip: "" }, roles: [] });
    expect(skeleton("Mono<CreateUser>", lookup)).toMatchObject({ name: "" });
    expect(skeleton("List<CreateUser>", lookup)).toEqual([]);
    expect(skeleton("Unknown", lookup)).toEqual({});
  });

  it("finds a DTO in another module through the index, with its superclass fields", async () => {
    const files: Record<string, string> = {
      "/ws/common/src/main/java/com/example/demo/dto/CreateUser.java":
        "package com.example.demo.dto;\nimport com.example.base.BaseEntity;\n@Data\npublic class CreateUser extends BaseEntity<Long> implements Serializable {\n  private String name;\n  private Address address;\n}\n",
      "/ws/common/src/main/java/com/example/demo/dto/Address.java":
        "package com.example.demo.dto;\npublic class Address { private String city; }\n",
      "/ws/base/src/main/java/com/example/base/BaseEntity.java":
        "package com.example.base;\npublic abstract class BaseEntity<ID> { private ID id; private LocalDateTime createdAt; }\n",
      // Same name, other package: not the imported class.
      "/ws/legacy/src/main/java/com/legacy/CreateUser.java":
        "package com.legacy;\npublic class CreateUser { int old; }\n",
    };
    const fs: SourceReader = {
      read: async (p) => files[p] ?? null,
      filesNamed: async (name) => Object.keys(files).filter((p) => p.endsWith(`/${name}`)),
    };
    const eps = springControllers(JAVA)[0]!.endpoints;
    const lookup = await bodyLookup(
      "/ws/web/src/main/java/com/example/demo/web/UserController.java",
      parseSource(JAVA),
      eps,
      fs,
    );
    expect(skeleton("CreateUser", lookup)).toEqual({ id: {}, createdAt: "", name: "", address: { city: "" } });
  });

  it("reads Java and Kotlin superclasses", () => {
    const java = parseSource("class A extends com.x.Base<T> implements I { }\ninterface J extends K {}");
    expect(java.classes.map((c) => c.superclass)).toEqual(["com.x.Base<T>", "K"]);
    const kotlin = parseSource(
      "class A(val a: Int) : Base(a), Serializable\nclass B : Serializable, Other()\nclass C : I",
    );
    expect(kotlin.classes.map((c) => c.superclass)).toEqual(["Base", "Other", undefined]);
  });
});

describe("appending to the request file", () => {
  const block = "### A.a\nGET http://localhost:8080/a\n";
  it("starts an empty file with the request", () => {
    expect(appendRequests("", [block])).toEqual({ insert: block, from: 0, caret: 8 });
  });

  it("separates from existing requests with a blank line before ###", () => {
    const existing = "### X\nGET http://x\n";
    const r = appendRequests(existing, [block, block]);
    expect(existing + r.insert).toBe(`${existing}\n${block}\n${block}`);
    expect((existing + r.insert).slice(r.caret).startsWith("GET http://localhost:8080/a")).toBe(true);
    expect(appendRequests("GET http://x", [block]).insert.startsWith("\n\n###")).toBe(true);
    expect(appendRequests("GET http://x\n\n", [block]).insert.startsWith("###")).toBe(true);
  });
});

describe("caret lookup", () => {
  it("finds the endpoint whose declaration (annotations included) holds the caret, and its controller", () => {
    const controllers = springControllers(JAVA);
    const at = (needle: string) => springAt(controllers, JAVA.indexOf(needle));
    expect(at("@GetMapping(BY_ID)").endpoint?.methodName).toBe("get");
    expect(at("service.get(id)").endpoint?.methodName).toBe("get");
    expect(at("public void helper").endpoint).toBeNull();
    expect(at("public void helper").controller?.name).toBe("UserController");
    expect(springAt(controllers, 0)).toEqual({ controller: null, endpoint: null });
  });
});
