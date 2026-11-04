import { describe, expect, it } from "vitest";
import type { Diagnostic } from "@/bindings";
import {
  analyzeSchema,
  childNodes,
  endpointLines,
  expandEndpoint,
  discoverSchemas,
  globToRegExp,
  httpRequestText,
  introspectionTarget,
  introspectionToSdl,
  jsonWithoutTemplates,
  parseConfig,
  parseVariables,
  outsideRanges,
  parseYaml,
  projectNodes,
  queryContext,
  queryText,
  responseErrorCount,
  schemaStats,
  unresolvedTypes,
  type SchemaFile,
} from "./model";
import { schemaOf } from "./store";

describe("parseYaml", () => {
  it("reads nested maps, lists and flow lists", () => {
    expect(
      parseYaml(`# graphql-config
schema:
  - schema.graphql   # main
  - 'types/**/*.graphql'
documents: [a.graphql, "b.graphql"]
extensions:
  endpoints:
    default:
      url: http://localhost:4000/graphql
      headers:
        Authorization: Bearer x
`),
    ).toEqual({
      schema: ["schema.graphql", "types/**/*.graphql"],
      documents: ["a.graphql", "b.graphql"],
      extensions: {
        endpoints: {
          default: { url: "http://localhost:4000/graphql", headers: { Authorization: "Bearer x" } },
        },
      },
    });
  });

  it("reads lists of maps", () => {
    expect(parseYaml("items:\n  - name: a\n    url: x\n  - b\n")).toEqual({ items: [{ name: "a", url: "x" }, "b"] });
  });
});

describe("parseConfig", () => {
  it("reads schema pointers and endpoints from YAML", () => {
    const c = parseConfig(
      "graphql.config.yml",
      "schema: schema.graphql\nextensions:\n  endpoints:\n    local: http://localhost/graphql\n",
    );
    expect(c).toEqual({
      schema: ["schema.graphql"],
      endpoints: [{ name: "local", url: "http://localhost/graphql", headers: {} }],
      dynamic: false,
      variables: [],
    });
  });

  it("reads JSON, a `.graphqlrc` holding JSON and the legacy schemaPath", () => {
    expect(parseConfig("graphql.config.json", '{"schema":["a.graphql"]}').schema).toEqual(["a.graphql"]);
    expect(parseConfig(".graphqlrc", '{ "schemaPath": "s.graphqls" }').schema).toEqual(["s.graphqls"]);
  });

  it("takes the keys of a schema map as pointers", () => {
    expect(parseConfig(".graphqlrc.json", '{"schema":{"https://api.dev/graphql":{"headers":{}}}}').schema).toEqual([
      "https://api.dev/graphql",
    ]);
  });

  it("does not evaluate JS/TS configs and survives broken ones", () => {
    expect(parseConfig("graphql.config.ts", "export default {}").dynamic).toBe(true);
    expect(parseConfig("graphql.config.json", "{").schema).toEqual([]);
  });
});

describe("globToRegExp", () => {
  it("matches graphql-config globs", () => {
    expect(globToRegExp("**/*.graphql").test("schema.graphql")).toBe(true);
    expect(globToRegExp("**/*.graphql").test("a/b/c.graphql")).toBe(true);
    expect(globToRegExp("src/*.{graphql,gql}").test("src/q.gql")).toBe(true);
    expect(globToRegExp("src/*.graphql").test("src/a/q.graphql")).toBe(false);
    expect(globToRegExp("./schema.graphql").test("schema.graphql")).toBe(true);
  });
});

describe("analyzeSchema", () => {
  const text = `
"""
type NotAType
"""
type Query { a(x: In): Int, color: Color }
# type Commented
extend type Query { b: [Missing!]! }
enum Color { RED }
input In { x: Int, d: Date }
scalar Date
union U = Query | Gone
directive @auth on FIELD_DEFINITION
`;

  it("counts definitions as IDEA's summary does, not comments or descriptions", () => {
    const a = analyzeSchema(text);
    expect(a.stats).toEqual({ types: 3, inputs: 1, enums: 1, directives: 1 });
    expect(a.defined.sort()).toEqual(["Color", "Date", "In", "Query", "U"]);
  });

  it("reports types used but defined nowhere, at their position", () => {
    const file: SchemaFile = { path: "/p/s.graphql", ...analyzeSchema(text) };
    const [project] = discoverSchemas("/p", [], [file]);
    const errors = unresolvedTypes(project!).map((e) => [e.diagnostic.message, e.diagnostic.range.start]);
    expect(errors).toEqual([
      ["The field type 'Missing' is not present when resolving type 'Query'", { line: 6, col: 24 }],
      ["The field type 'Gone' is not present when resolving type 'U'", { line: 10, col: 18 }],
    ]);
    expect(schemaStats(project!).types).toBe(3);
  });
});

const file = (path: string): SchemaFile => ({
  path,
  stats: { types: 0, inputs: 0, enums: 0, directives: 0 },
  defined: [],
  references: [],
});
const files = [file("/p/schema.graphql"), file("/p/api/user.graphqls"), file("/p/web/query.graphql")];

describe("discoverSchemas", () => {
  it("puts every file in the default schema without a config", () => {
    const p = discoverSchemas("/p", [], files)[0]!;
    expect(p.configPath).toBeNull();
    expect(p.files.map((f) => f.path)).toEqual(["/p/api/user.graphqls", "/p/schema.graphql", "/p/web/query.graphql"]);
  });

  it("picks a config's files by its globs, relative to its folder", () => {
    const p = discoverSchemas(
      "/p",
      [
        {
          path: "/p/api/.graphqlrc.yml",
          config: { schema: ["*.graphqls", "https://x.dev/graphql"], endpoints: [], dynamic: false, variables: [] },
        },
      ],
      files,
    )[0]!;
    expect(p.root).toBe("/p/api");
    expect(p.files.map((f) => f.path)).toEqual(["/p/api/user.graphqls"]);
    expect(p.remote).toEqual(["https://x.dev/graphql"]);
  });
});

describe("tree", () => {
  const diag = (severity: Diagnostic["severity"]): Diagnostic => ({
    range: { start: { line: 1, col: 2 }, end: { line: 1, col: 4 } },
    severity,
    message: "Unknown type",
    source: "graphql",
    code: null,
  });

  it("shows IDEA's sections: summary, errors and endpoints", () => {
    const root = projectNodes(discoverSchemas("/p", [], []))[0]!;
    const none = () => [];
    const [summary, errors, endpoints] = childNodes(root, none)!;
    expect([summary!.kind, errors!.kind, endpoints!.kind]).toEqual(["summary", "errors", "endpoints"]);
    expect(childNodes(summary!, none)).toEqual([]);
    expect(childNodes(errors!, none)?.map((n) => n.kind)).toEqual(["noErrors"]);
    expect(childNodes(endpoints!, none)?.map((n) => n.kind)).toEqual(["noEndpoints"]);
  });

  it("lists errors and warnings of the schema's files", () => {
    const root = projectNodes(discoverSchemas("/p", [], files))[0]!;
    const errors = childNodes(root, () => [])![1]!;
    const found = childNodes(errors, (path) =>
      path === "/p/schema.graphql" ? [diag("error"), diag("hint"), diag("warning")] : [],
    );
    expect(found?.map((n) => (n.kind === "error" ? n.diagnostic.severity : n.kind))).toEqual(["error", "warning"]);
  });
});

describe("queries", () => {
  it("runs the selection, else the document", () => {
    expect(queryText("  { a }\n", null)).toBe("{ a }");
    expect(queryText("{ a } { b }", { from: 6, to: 11 })).toBe("{ b }");
    expect(queryText("{ a }", { from: 2, to: 2 })).toBe("{ a }");
  });

  it("runs the operation around the caret with the fragments it uses, as IDEA does", () => {
    const doc = `# { not: "this" }
query A { ...F }
query B($id: ID!) { node(id: $id) { ... on User { name } ...G } }
fragment F on Query { x }
fragment G on Node { id ...H }
fragment H on Node { "}" }
`;
    const inB = doc.indexOf("node(");
    expect(queryText(doc, { from: inB, to: inB })).toBe(
      'query B($id: ID!) { node(id: $id) { ... on User { name } ...G } }\n\nfragment G on Node { id ...H }\n\nfragment H on Node { "}" }',
    );
    const inA = doc.indexOf("...F");
    expect(queryText(doc, { from: inA, to: inA })).toBe("query A { ...F }\n\nfragment F on Query { x }");
    // Outside every operation (in the comment): the whole document.
    expect(queryText(doc, { from: 3, to: 3 })).toBe(doc.trim());
  });

  it("reports what was sent so the rest can be greyed out", () => {
    const doc = "query A { a }\nquery B { b }\n";
    expect(queryContext(doc, { from: 2, to: 5 }).ranges).toEqual([{ from: 2, to: 5 }]);
    const inB = doc.indexOf("b }");
    expect(queryContext(doc, { from: inB, to: inB }).ranges).toEqual([{ from: 14, to: 27 }]);
    expect(outsideRanges(doc.length, [{ from: 14, to: 27 }])).toEqual([
      { from: 0, to: 14 },
      { from: 27, to: 28 },
    ]);
  });

  it("counts the errors of a GraphQL response", () => {
    expect(responseErrorCount('{"errors":[{"message":"a"},{"message":"b"}]}')).toBe(2);
    expect(responseErrorCount('{"data":{}}')).toBe(0);
    expect(responseErrorCount("<html>")).toBe(0);
  });

  it("escapes braces in strings so the HTTP client does not expand them", () => {
    const json = jsonWithoutTemplates({ query: "{ a { b }}", variables: { o: { p: 1 } } });
    expect(json).not.toContain("{{");
    expect(JSON.parse(json)).toEqual({ query: "{ a { b }}", variables: { o: { p: 1 } } });
  });

  it("reads variables as a JSON object", () => {
    expect(parseVariables("  ")).toEqual({ variables: null });
    expect(parseVariables('{"code":"VN"}')).toEqual({ variables: { code: "VN" } });
    expect("error" in parseVariables("[1]")).toBe(true);
    expect("error" in parseVariables("{")).toBe(true);
  });

  it("posts the query as JSON with the endpoint's headers", () => {
    expect(
      httpRequestText({ name: "x", url: "http://h/graphql", headers: { Authorization: "Bearer t" } }, "{ a }"),
    ).toBe(
      'POST http://h/graphql\nContent-Type: application/json\nAuthorization: Bearer t\n\n{"query":"\\u007b a \\u007d"}\n',
    );
  });

  it("uses the schema listing the file, else the closest config folder", () => {
    const projects = discoverSchemas(
      "/p",
      [
        {
          path: "/p/.graphqlrc.yml",
          config: { schema: ["schema.graphql"], endpoints: [], dynamic: false, variables: [] },
        },
        {
          path: "/p/api/.graphqlrc.yml",
          config: { schema: ["*.graphqls"], endpoints: [], dynamic: false, variables: [] },
        },
      ],
      files,
    );
    expect(schemaOf(projects, "/p/schema.graphql")?.configPath).toBe("/p/.graphqlrc.yml");
    expect(schemaOf(projects, "/p/api/ops/q.graphql")?.configPath).toBe("/p/api/.graphqlrc.yml");
  });
});

describe("introspection", () => {
  const ref = (name: string, kind = "OBJECT") => ({ kind, name, ofType: null });
  const nonNull = (t: object) => ({ kind: "NON_NULL", name: null, ofType: t });
  const list = (t: object) => ({ kind: "LIST", name: null, ofType: t });
  const body = JSON.stringify({
    data: {
      __schema: {
        queryType: { name: "Query" },
        mutationType: null,
        subscriptionType: null,
        directives: [{ name: "include", locations: ["FIELD"], args: [] }],
        types: [
          {
            kind: "OBJECT",
            name: "Query",
            description: "Root",
            interfaces: [],
            fields: [
              {
                name: "countries",
                args: [{ name: "filter", type: ref("Filter", "INPUT_OBJECT"), defaultValue: null }],
                type: nonNull(list(nonNull(ref("Country")))),
              },
              {
                name: "old",
                args: [],
                type: ref("String", "SCALAR"),
                isDeprecated: true,
                deprecationReason: "Use countries",
              },
            ],
          },
          {
            kind: "OBJECT",
            name: "Country",
            interfaces: [],
            fields: [{ name: "code", args: [], type: nonNull(ref("ID", "SCALAR")) }],
          },
          {
            kind: "INPUT_OBJECT",
            name: "Filter",
            inputFields: [{ name: "code", type: ref("String", "SCALAR"), defaultValue: '"VN"' }],
          },
          { kind: "ENUM", name: "Color", enumValues: [{ name: "RED" }] },
          { kind: "SCALAR", name: "String" },
          { kind: "OBJECT", name: "__Type", fields: [] },
        ],
      },
    },
  });

  it("prints the schema as IDEA writes it: header, kinds then names, sorted fields", () => {
    expect(introspectionToSdl(body)).toBe(`# This file was generated. Do not edit manually.

schema {
    query: Query
}

type Country {
    code: ID!
}

"Root"
type Query {
    countries(filter: Filter): [Country!]!
    old: String @deprecated(reason: "Use countries")
}

enum Color {
    RED
}

input Filter {
    code: String = "VN"
}
`);
  });

  it("fails on a response without a schema", () => {
    expect(() => introspectionToSdl('{"errors":[{"message":"Introspection disabled"}]}')).toThrow(
      "Introspection disabled",
    );
  });

  it("writes to the config's first schema file, else schema.graphql", () => {
    const [p] = discoverSchemas(
      "/p",
      [
        {
          path: "/p/graphql.config.yml",
          config: { schema: ["types/*.graphqls", "./api.graphql"], endpoints: [], dynamic: false, variables: [] },
        },
      ],
      [],
    );
    expect(introspectionTarget(p!)).toBe("/p/api.graphql");
    const [d] = discoverSchemas("/p", [], []);
    expect(introspectionTarget(d!)).toBe("/p/schema.graphql");
  });
});

describe("endpointLines", () => {
  it("finds each endpoint's line in YAML and JSON configs", () => {
    const yaml = `schema: s.graphql
extensions:
  endpoints:
    countries:
      url: https://c/
    local: http://l/
`;
    expect(endpointLines("graphql.config.yml", yaml)).toEqual([
      { endpoint: "countries", line: 3 },
      { endpoint: "local", line: 5 },
    ]);
    const json = `{
  "extensions": {
    "endpoints": {
      "dev": "http://d/"
    }
  }
}`;
    expect(endpointLines("graphql.config.json", json)).toEqual([{ endpoint: "dev", line: 3 }]);
    expect(endpointLines("graphql.config.yml", "schema: s.graphql")).toEqual([]);
  });
});

describe("environment variables", () => {
  it("lists the ${NAME} variables a config uses and expands endpoints with them", () => {
    const c = parseConfig(
      "graphql.config.yml",
      `extensions:
  endpoints:
    api:
      url: \${API_URL:http://localhost:4000}/graphql
      headers:
        Authorization: Bearer \${TOKEN}
`,
    );
    expect(c.variables).toEqual(["API_URL", "TOKEN"]);
    const api = c.endpoints[0]!;
    expect(expandEndpoint(api, { TOKEN: "t" })).toEqual({
      name: "api",
      url: "http://localhost:4000/graphql",
      headers: { Authorization: "Bearer t" },
    });
    expect(expandEndpoint(api, { API_URL: "https://x.dev" }).url).toBe("https://x.dev/graphql");
  });
});

describe("environment variables dialog", () => {
  it("copies and pastes values as NAME=value lines", async () => {
    const { formatEnvironment, parseEnvironment } = await import("./EnvironmentDialog");
    const names = ["API_TOKEN", "COUNTRIES_HOST"];
    expect(formatEnvironment(names, { API_TOKEN: "t" })).toBe("API_TOKEN=t\nCOUNTRIES_HOST=");
    expect(parseEnvironment("# comment\nAPI_TOKEN = a=b\r\nOTHER=x\nCOUNTRIES_HOST=https://h\n", names)).toEqual({
      API_TOKEN: "a=b",
      COUNTRIES_HOST: "https://h",
    });
  });
});

describe("running an endpoint with environment variables", () => {
  it("needs the variables that have neither a value nor a default", async () => {
    const { missingVariables } = await import("./model");
    const endpoint = {
      name: "env",
      url: "${HOST:https://h}/graphql",
      headers: { Authorization: "Bearer ${TOKEN}", "X-Team": "${TEAM}" },
    };
    expect(missingVariables(endpoint, {})).toEqual(["TOKEN", "TEAM"]);
    expect(missingVariables(endpoint, { TOKEN: "t" })).toEqual(["TEAM"]);
    expect(missingVariables(endpoint, { TOKEN: "t", TEAM: "a" })).toEqual([]);
    // An empty value counts as not set.
    expect(missingVariables(endpoint, { TOKEN: "", TEAM: "a" })).toEqual(["TOKEN"]);
  });

  it("shows sizes as IDEA does", async () => {
    const { formatSize } = await import("./model");
    expect(formatSize(286)).toBe("286 bytes");
    expect(formatSize(1741)).toBe("1.7 kb");
  });
});
