import { afterEach, describe, expect, it, vi } from "vitest";
import { fragmentsOf, withFragments } from "./document";
import { FRAGMENTS } from "./fragments";
import * as Q from "./queries";
import { GHGraphQLError, graphqlData, parseRest } from "./client";
import { timelineItems } from "./requests";

const definitions = (text: string) => [...text.matchAll(/^\s*fragment\s+(\S+)\s+on\s/gm)].map((m) => m[1]!);
const spreads = (text: string) => new Set([...text.matchAll(/^\s*\.\.\.([A-Za-z_]\w*)/gm)].map((m) => m[1]!));

describe("GraphQL documents", () => {
  it("ports every IntelliJ fragment and query", () => {
    expect(Object.keys(FRAGMENTS)).toHaveLength(39);
    expect(Object.keys(Q)).toHaveLength(40);
    for (const [name, text] of Object.entries(FRAGMENTS)) expect(definitions(text), name).toEqual([name]);
  });

  it.each(Object.entries(Q))("sends %s with every fragment it needs, once", (_name, doc) => {
    const text = withFragments(doc);
    const defined = definitions(text);
    expect(new Set(defined).size).toBe(defined.length);
    for (const s of spreads(text)) expect(defined, s).toContain(s);
    // Only fragments that are spread somewhere are added.
    for (const d of fragmentsOf(doc)) expect(spreads(text).has(d), d).toBe(true);
  });

  it("resolves fragments transitively, like GHGQLQueryLoader", () => {
    const names = fragmentsOf(Q.issueSearch);
    expect(names).toEqual(
      expect.arrayContaining([
        "pageInfo",
        "pullRequestInfoShort",
        "rates",
        "nodeInfo",
        "actor",
        "actorInfo",
        "userInfo",
        "user",
        "labelInfo",
        "pullRequestReviewer",
        "teamInfo",
        "pullRequestReview",
        "reactions",
        "reaction",
        "enterpriseUserAccountInfo",
        "organizationInfo",
      ]),
    );
    expect(names).not.toContain("repository");
    // Fragments go first, the operation last.
    expect(withFragments(Q.issueSearch).trim()).toMatch(/^fragment[\s\S]*\nquery issueSearch[\s\S]*\}$/);
  });

  it("does not add fragments a document defines itself", () => {
    const text = withFragments(Q.pullRequestTimeline);
    expect(definitions(text).filter((d) => d === "gitRefName")).toHaveLength(1);
    expect(fragmentsOf(Q.pullRequestTimeline)).not.toContain("gitRefName");
    expect(fragmentsOf(Q.pullRequestTimeline)).not.toContain("issueCommentInfo");
  });

  it("treats inline fragments as selections, not spreads", () => {
    expect(fragmentsOf(Q.findPendingReview)).toEqual(expect.arrayContaining(["pullRequestPendingReview", "nodeInfo"]));
    expect(fragmentsOf(`query { node(id: "x") { ... on User { id } } }`)).toEqual([]);
  });

  it("fails on an unknown fragment", () => {
    expect(() => withFragments(`query {\n  viewer {\n    ...nope\n  }\n}`)).toThrow(/nope/);
  });
});

describe("client", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns data and throws GraphQL errors", () => {
    expect(graphqlData<{ a: number }>('{"data":{"a":1}}')).toEqual({ a: 1 });
    expect(() => graphqlData('{"errors":[{"message":"bad"},{"message":"worse"}]}')).toThrow(GHGraphQLError);
    expect(() => graphqlData('{"errors":[{"message":"bad"}]}')).toThrow("bad");
  });

  it("flattens slurped REST pages and maps empty bodies to null", () => {
    expect(parseRest("[[1,2],[3]]", true)).toEqual([1, 2, 3]);
    expect(parseRest('[{"a":1}]', false)).toEqual([{ a: 1 }]);
    expect(parseRest("  ", false)).toBeNull();
  });

  it("sends documents with their fragments through gh", async () => {
    const ipc = await import("@/platform/ipc");
    const ghApi = vi
      .spyOn(ipc.commands, "ghApi")
      .mockResolvedValue({ status: "ok", data: '{"data":{"repository":null}}' } as never);
    const { graphql } = await import("./client");
    await graphql(Q.findRepository, { repoOwner: "o", repoName: "r", cursor: undefined });
    const req = ghApi.mock.calls[0]![0];
    expect(req).toMatchObject({ method: "POST", endpoint: "graphql", paginate: false });
    const body = JSON.parse(req.body!) as { query: string; variables: Record<string, unknown> };
    expect(body.variables).toEqual({ repoOwner: "o", repoName: "r" });
    expect(definitions(body.query)).toEqual(expect.arrayContaining(["repository", "repositoryOwnerName", "rates"]));
  });
});

describe("timeline items", () => {
  it("drops IntelliJ's ignored types and marks unknown ones", () => {
    const items = timelineItems([
      { __typename: "IssueComment" },
      { __typename: "MentionedEvent" },
      { __typename: "SubscribedEvent" },
      { __typename: "AutoMergeEnabledEvent" },
    ]);
    expect(items.map((i) => i.__typename)).toEqual(["IssueComment", "Unknown"]);
    expect(items[1]).toEqual({ __typename: "Unknown", type: "AutoMergeEnabledEvent" });
  });
});
