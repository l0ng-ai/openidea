import { tags as t, type styleTags } from "@lezer/highlight";

/**
 * @lezer/javascript styles `.` as a deref operator, but not `?.`; it tags `this` as `self` (Python's
 * `self` colour) and `super` as an atom, which WebStorm colours as keywords.
 */
export const JS_TAGS: Parameters<typeof styleTags>[0] = { "?.": t.derefOperator, "this super": t.keyword };
