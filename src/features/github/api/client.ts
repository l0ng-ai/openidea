/**
 * GitHub API access through gh (`commands.ghApi`, which runs `gh api` in the project root
 * with gh's authentication), like IntelliJ's `GithubApiRequestExecutor`:
 *
 *   const data = await graphql<{ repository: … }>(findRepository, { repoOwner, repoName });
 *   const page = await rest<GHLabelDto[]>("GET", `${repoPath()}/labels?per_page=100`);
 *
 * Documents are sent with the fragments they spread (`withFragments`). Requests address
 * the connected repository explicitly (`repoPath()`, `repoVariables()`), not gh's
 * `{owner}/{repo}` placeholders, since a project can have several GitHub remotes.
 */
import { call, commands } from "@/platform/ipc";
import { withFragments } from "./document";
import type { GHRepositoryCoordinates } from "./types";

export type GHApiMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** A GraphQL response with `errors` (IntelliJ's `GithubConfusingException`). */
export class GHGraphQLError extends Error {
  constructor(
    message: string,
    readonly errors: ReadonlyArray<{ message: string; type?: string; path?: unknown[] }>,
  ) {
    super(message);
    this.name = "GHGraphQLError";
  }
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** `data` of a GraphQL response body; throws on `errors` (gh usually fails the call first). */
export function graphqlData<T>(text: string): T {
  const json = JSON.parse(text) as { data?: T; errors?: Array<{ message: string; type?: string; path?: unknown[] }> };
  if (json.errors?.length) throw new GHGraphQLError(json.errors.map((e) => e.message).join("\n"), json.errors);
  if (json.data === undefined) throw new GHGraphQLError("GitHub returned no data", []);
  return json.data;
}

/** Runs a document from `queries.ts` with `variables` (undefined values are dropped). */
export async function graphql<T>(doc: string, variables: Record<string, unknown> = {}): Promise<T> {
  const body = JSON.stringify({ query: withFragments(doc), variables: definedOnly(variables) });
  const text = await call(commands.ghApi({ method: "POST", endpoint: "graphql", body, paginate: false }));
  return graphqlData<T>(text);
}

function definedOnly(v: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined));
}

/**
 * A REST call (`endpoint` relative to the API root, e.g. `repos/o/r/pulls/1/files`).
 * `paginate` follows every `Link` page and concatenates array pages. Empty bodies
 * (`204 No Content`) come back as `null`.
 */
export async function rest<T>(
  method: GHApiMethod,
  endpoint: string,
  body?: unknown,
  opts: { paginate?: boolean } = {},
): Promise<T> {
  const text = await call(
    commands.ghApi({
      method,
      endpoint,
      body: body === undefined ? null : JSON.stringify(body),
      paginate: opts.paginate ?? false,
    }),
  );
  return parseRest<T>(text, opts.paginate ?? false);
}

/** Parses a REST body; `--slurp` pages (an array of pages) are flattened when they are arrays. */
export function parseRest<T>(text: string, paginated: boolean): T {
  if (!text.trim()) return null as T;
  const json = JSON.parse(text) as unknown;
  if (paginated && Array.isArray(json) && json.every(Array.isArray)) return (json as unknown[][]).flat() as T;
  return json as T;
}

// ---------------------------------------------------------------------------
// The connected repository

let current: (GHRepositoryCoordinates & { id: string | null }) | null = null;

/** Set by `data/repository.ts` when the tool window connects (null: disconnected). */
export function setCurrentRepository(repo: (GHRepositoryCoordinates & { id: string | null }) | null) {
  current = repo;
}

/** The connected repository: `owner`, `name` and its GraphQL node `id` (once loaded). */
export function currentRepository(): GHRepositoryCoordinates & { id: string | null } {
  if (!current) throw new Error("Not connected to a GitHub repository");
  return current;
}

/** `repos/owner/name`, the prefix of the connected repository's REST endpoints. */
export function repoPath(repo: GHRepositoryCoordinates = currentRepository()): string {
  return `repos/${repo.owner}/${repo.name}`;
}

/** The `$repoOwner` / `$repoName` variables of the repository documents. */
export function repoVariables(repo: GHRepositoryCoordinates = currentRepository()) {
  return { repoOwner: repo.owner, repoName: repo.name };
}
