import { describe, expect, it } from "vitest";
import { callsEndpoint, controllerMethods, feignMethods, sameHttpPath } from "./feign";

const imports = `import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.*;\n`;
const client = (
  annotation = '@FeignClient(name="users", path="/api")',
  mapping = '@GetMapping("/users/{id}")',
) => `${imports}${annotation}
interface Client { ${mapping} String find(); }`;
const server = (mapping = '@GetMapping("/{user}")', prefix = '@RequestMapping("/api/users")') => `${imports}
@RestController ${prefix} class Users { ${mapping} String get() { return ""; } }`;

describe("literal source Feign navigation", () => {
  it("reads Java and Kotlin methods, including literal name/value aliases and exact link spans", () => {
    for (const annotation of [
      '@FeignClient(name="users",path="/api")',
      '@FeignClient(value="users",path="/api")',
      '@FeignClient("users")',
    ]) {
      const text = client(annotation);
      const method = feignMethods(text)[0]!;
      expect(method.service).toBe("users");
      expect(method.name).toBe("Client.find");
      expect(text.slice(method.links[0]!.from, method.links[0]!.to)).toBe("/users/{id}");
      expect(text.slice(method.nameFrom, method.nameFrom + 4)).toBe("find");
    }
    const kotlin = `${imports.replaceAll(";", "")}@FeignClient(value="users",path="/api")\ninterface Users {\n @GetMapping("/users/{id}")\n fun find(): String\n}`;
    expect(feignMethods(kotlin)[0]).toMatchObject({ service: "users", methods: ["GET"], paths: ["/api/users/{id}"] });
  });

  it("keeps unresolved discovery names and explicit URLs as method/path candidates", () => {
    for (const args of [
      'name="${service}"',
      "name=NAME",
      'name="users",value="admin"',
      'name="users",url="http://localhost"',
      'name="users",url="${url:}"',
    ]) {
      expect(feignMethods(client(`@FeignClient(${args})`))[0]?.service).toBeNull();
    }
    expect(feignMethods(client('@FeignClient(name="users",contextId="admin")'))[0]?.service).toBe("users");
  });

  it("rejects foreign/shadowed annotations, malformed aliases, dynamic paths and default methods", () => {
    expect(
      feignMethods(client().replace("org.springframework.cloud.openfeign.FeignClient", "other.FeignClient")),
    ).toEqual([]);
    expect(feignMethods(client() + " class FeignClient {} ")).toEqual([]);
    expect(feignMethods(client('@FeignClient(name="users",name="admin")'))).toEqual([]);
    expect(feignMethods(client('@FeignClient(name="users",path=PREFIX)'))).toEqual([]);
    expect(feignMethods(client(undefined, "@GetMapping(PATH)"))).toEqual([]);
    expect(feignMethods(client(undefined, '@GetMapping("/${path}")'))).toEqual([]);
    expect(feignMethods(client().replace("String find();", 'default String find() { return ""; }'))).toEqual([]);
    expect(feignMethods(client().replace("interface Client", "class Client"))).toEqual([]);
  });

  it("supports fully qualified annotations and preserves UTF-16 offsets", () => {
    const text =
      '// 😀\n@org.springframework.cloud.openfeign.FeignClient("users") interface Client { @org.springframework.web.bind.annotation.GetMapping("/users") String find(); }';
    const method = feignMethods(text)[0]!;
    expect(method.service).toBe("users");
    expect(method.nameFrom).toBe(text.indexOf("find()"));
  });

  it("handles multiple server methods and unconstrained mappings without inventing GET-only semantics", () => {
    const get = feignMethods(client())[0]!;
    expect(callsEndpoint(get, controllerMethods(server())[0]!)).toBe(true);
    expect(callsEndpoint(get, controllerMethods(server('@PostMapping("/{user}")'))[0]!)).toBe(false);
    for (const verb of ["POST", "PATCH", "GET"]) {
      const c = feignMethods(
        client(undefined, `@RequestMapping(value="/users/{id}",method=RequestMethod.${verb})`),
      )[0]!;
      expect(callsEndpoint(c, controllerMethods(server('@RequestMapping("/{user}")'))[0]!)).toBe(true);
    }
    const c = feignMethods(client(undefined, '@PostMapping("/users/{id}")'))[0]!;
    expect(
      callsEndpoint(
        c,
        controllerMethods(server('@RequestMapping(path="/{user}",method={RequestMethod.GET,RequestMethod.POST})'))[0]!,
      ),
    ).toBe(true);
    expect(
      callsEndpoint(
        c,
        controllerMethods(
          server('@RequestMapping("/{user}")', '@RequestMapping(path="/api/users",method=RequestMethod.GET)'),
        )[0]!,
      ),
    ).toBe(false);
    const combined = controllerMethods(
      server('@PostMapping("/{user}")', '@RequestMapping(path="/api/users",method=RequestMethod.GET)'),
    )[0]!;
    expect(combined.methods).toEqual(["GET", "POST"]);
    expect(callsEndpoint(get, combined)).toBe(true);
    expect(callsEndpoint(c, combined)).toBe(true);
  });

  it("matches each path alternative, HEAD-to-GET and only supported whole path segments", () => {
    const c = feignMethods(client(undefined, '@GetMapping({"/other", "/users/{id}"})'))[0]!;
    expect(callsEndpoint(c, controllerMethods(server())[0]!)).toBe(true);
    const head = { ...c, methods: ["HEAD"] };
    expect(callsEndpoint(head, controllerMethods(server())[0]!)).toBe(true);
    for (const [a, b, expected] of [
      ["/a/{id}", "/a/{name}", true],
      ["/a/{id}", "/a/b/c", false],
      ["/a/**", "/a/b", false],
      ["/a/{id:[0-9]+}", "/a/1", false],
      ["/a/${id}", "/a/1", false],
    ] as const) {
      expect(sameHttpPath(a, b)).toBe(expected);
    }
  });
});
