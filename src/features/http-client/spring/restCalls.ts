/** RestTemplate / WebClient calls whose URL is one string literal; URLs built
 * from variables or concatenation need dataflow and are not followed. */
import { literal, MAX_NAVIGATION_SOURCE, VERBS, type HttpShape } from "./feign";
import { tokenize, type Tok } from "./source";

const TEMPLATE = new Map([
  ["getForObject", "GET"],
  ["getForEntity", "GET"],
  ["headForHeaders", "HEAD"],
  ["postForObject", "POST"],
  ["postForEntity", "POST"],
  ["postForLocation", "POST"],
  ["patchForObject", "PATCH"],
  ["put", "PUT"],
  ["delete", "DELETE"],
  ["optionsForAllow", "OPTIONS"],
]);

export interface RestCall extends HttpShape {
  /** The URL literal, excluding quotes. */
  from: number;
  to: number;
  service: string | null;
}

/** `HttpMethod.X` written from `from` up to the next `,` or `)`, and that index. */
function verb(toks: Tok[], from: number): [string | null, number] {
  let written = "",
    i = from;
  for (; i < toks.length && i < from + 12 && ![",", ")"].includes(toks[i]!.text); i++) written += toks[i]!.text;
  const name = /^(?:org\.springframework\.http\.)?HttpMethod\.(\w+)$/.exec(written)?.[1];
  return [name && VERBS.has(name) ? name : null, i];
}

/** Index after Kotlin's explicit type arguments (`getForObject<List<User>>`), else `at`. */
function afterTypeArgs(toks: Tok[], at: number): number {
  if (toks[at]?.text !== "<") return at;
  for (let i = at, depth = 0; i < toks.length && i < at + 32; i++) {
    if (toks[i]!.text === "<") depth++;
    else if (toks[i]!.text === ">" && !--depth) return i + 1;
  }
  return -1;
}

/** A literal sole or first argument at `toks[at]`, as a matchable call. */
function call(toks: Tok[], at: number, method: string | null): RestCall | null {
  const t = toks[at],
    value = literal(t);
  if (!method || value === null || ![",", ")"].includes(toks[at + 1]?.text ?? "")) return null;
  const url = /^(?:https?:\/\/([^/?#]*))?(\/[^?#]*)?(?:[?#].*)?$/.exec(value);
  if (!url || (url[1] === undefined && url[2] === undefined)) return null;
  const host = url[1];
  return {
    paths: [url[2] ?? "/"],
    methods: [method],
    from: t!.start + 1,
    to: t!.end - 1,
    // A bare host is a load-balanced service id; real hosts can be any service.
    service: host && /^[\w-]+$/.test(host) && host !== "localhost" ? host : null,
  };
}

export function restCalls(text: string): RestCall[] {
  if (text.length > MAX_NAVIGATION_SOURCE || !/RestTemplate|WebClient|RestClient/.test(text)) return [];
  const toks = tokenize(text);
  const result: RestCall[] = [];
  for (let i = 1; i < toks.length; i++) {
    const name = toks[i]!.text;
    if (toks[i]!.kind !== "id" || toks[i - 1]!.text !== ".") continue;
    let found: RestCall | null = null;
    // Fluent: `.get().uri("…")` or `.method(HttpMethod.X).uri("…")`.
    const [fluent, close] =
      name === "method"
        ? verb(toks, i + 2)
        : [VERBS.has(name.toUpperCase()) && name === name.toLowerCase() ? name.toUpperCase() : null, i + 2];
    if (
      fluent &&
      toks[i + 1]?.text === "(" &&
      toks
        .slice(close, close + 4)
        .map((t) => t.text)
        .join("") === ").uri("
    )
      found = call(toks, close + 4, fluent);
    else {
      const open = afterTypeArgs(toks, i + 1);
      const exchange = name === "exchange" && toks[open + 2]?.text === "," ? verb(toks, open + 3)[0] : null;
      if (open > 0 && toks[open]?.text === "(") found = call(toks, open + 1, TEMPLATE.get(name) ?? exchange);
    }
    if (found) result.push(found);
  }
  return result;
}
