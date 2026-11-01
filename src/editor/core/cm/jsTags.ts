import { tags as t, type styleTags } from "@lezer/highlight";

/** @lezer/javascript styles `.` as a deref operator, but not `?.`. */
export const JS_TAGS: Parameters<typeof styleTags>[0] = { "?.": t.derefOperator };
