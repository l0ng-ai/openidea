import { describe, expect, it } from "vitest";
import { restCalls } from "./restCalls";

const java = (body: string) => `import org.springframework.web.client.RestTemplate;
import org.springframework.web.reactive.function.client.WebClient;
class Calls { RestTemplate rest; WebClient web; void run() { ${body} } }`;
const shape = (text: string) =>
  restCalls(text).map((c) => ({ ...c, url: text.slice(c.from, c.to), from: undefined, to: undefined }));

describe("literal RestTemplate and WebClient call sites", () => {
  it("reads the verb, path and link span of RestTemplate calls", () => {
    const text = java(`rest.getForObject("/users/{id}", User.class, id);
      rest.postForEntity("/users", body, User.class);
      rest.put("/users/{id}", body);
      rest.delete("/users/{id}");
      rest.exchange("/users", HttpMethod.PATCH, entity, User.class);
      rest.exchange("/users", org.springframework.http.HttpMethod.HEAD, null, Void.class);
      rest.postForLocation("/users", body);
      rest.patchForObject("/users/{id}", body, User.class);
      rest.headForHeaders("/users");
      rest.optionsForAllow("/users");`);
    expect(shape(text)).toMatchObject([
      { methods: ["GET"], paths: ["/users/{id}"], url: "/users/{id}" },
      { methods: ["POST"], paths: ["/users"] },
      { methods: ["PUT"], paths: ["/users/{id}"] },
      { methods: ["DELETE"], paths: ["/users/{id}"] },
      { methods: ["PATCH"], paths: ["/users"] },
      { methods: ["HEAD"], paths: ["/users"] },
      { methods: ["POST"], paths: ["/users"] },
      { methods: ["PATCH"], paths: ["/users/{id}"] },
      { methods: ["HEAD"], paths: ["/users"] },
      { methods: ["OPTIONS"], paths: ["/users"] },
    ]);
  });

  it("reads WebClient verbs and method(HttpMethod.X), in Java and Kotlin", () => {
    const text = java(`web.get().uri("/users/{id}", id).retrieve();
      web.post()
        .uri("/users")
        .bodyValue(body);
      web.method(HttpMethod.PUT).uri("/users/{id}");`);
    expect(shape(text).map((c) => [c.methods[0], c.paths[0]])).toEqual([
      ["GET", "/users/{id}"],
      ["POST", "/users"],
      ["PUT", "/users/{id}"],
    ]);
    const kotlin = `import org.springframework.web.client.RestTemplate
class Calls(private val rest: RestTemplate) {
  fun find(id: Long) = rest.getForObject<List<User>>("/users/{id}", id)
}`;
    expect(
      restCalls(`class C { RestClient client; void run() { client.delete().uri("/users/{id}"); } }`),
    ).toMatchObject([{ methods: ["DELETE"], paths: ["/users/{id}"] }]);
    expect(shape(kotlin)).toMatchObject([{ methods: ["GET"], paths: ["/users/{id}"], url: "/users/{id}" }]);
  });

  it("maps a bare load-balanced host to its service and drops query strings", () => {
    const calls = restCalls(
      java(`rest.getForObject("http://users/users/{id}?full=true", User.class);
        rest.getForObject("https://api.example.com/users/{id}", User.class);
        rest.getForObject("http://localhost:8080/users", User.class);
        rest.getForObject("http://users", User.class);`),
    );
    expect(calls.map((c) => [c.service, c.paths[0]])).toEqual([
      ["users", "/users/{id}"],
      [null, "/users/{id}"],
      [null, "/users"],
      ["users", "/"],
    ]);
  });

  it("skips URLs that need dataflow, unknown verbs and non-URL arguments", () => {
    expect(
      restCalls(
        java(`rest.getForObject(url, User.class);
          rest.getForObject("/users/" + id, User.class);
          rest.getForObject(BASE + "/users", User.class);
          rest.exchange("/users", method, entity, User.class);
          web.method(verb).uri("/users");
          web.get().uri(builder -> builder.path("/users").build());
          map.put("key", value);
          getForObject("/users");`),
      ),
    ).toEqual([]);
    expect(restCalls(`class Plain { void run() { map.put("/users", value); } }`)).toEqual([]);
    expect(restCalls(`class K(val rest: RestTemplate) { fun f() = rest.getForObject("/users/$id") }`)).toEqual([]);
  });
});
