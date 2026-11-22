import { expect, it } from "vitest";
import { tail } from "./store";

it("keeps the newest output within the cap, cutting into the oldest kept span", () => {
  const spans = [{ text: "aaaa" }, { text: "bb", fg: "red" }, { text: "cc" }];
  expect(tail(spans, 10)).toBe(spans);
  expect(tail(spans, 5)).toEqual([{ text: "a" }, { text: "bb", fg: "red" }, { text: "cc" }]);
  expect(tail(spans, 3)).toEqual([{ text: "b", fg: "red" }, { text: "cc" }]);
  expect(tail([{ text: "0123456789" }], 3)).toEqual([{ text: "789" }]);
});
