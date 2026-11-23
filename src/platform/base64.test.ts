import { expect, it } from "vitest";
import { toBase64 } from "./base64";

const decode = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

it("encodes every byte value and the empty input to standard padded base64", () => {
  expect(toBase64(new Uint8Array())).toBe("");
  expect(toBase64(new Uint8Array([0, 255]))).toBe("AP8=");
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  expect([...decode(toBase64(all))]).toEqual([...all]);
});

it("is a string of at most ceil(4n/3) characters, across the chunk boundary", () => {
  for (const n of [0x7fff, 0x8000, 0x8001, 5 * 0x8000 + 1]) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 31) % 256);
    const text = toBase64(bytes);
    expect(text).toHaveLength(4 * Math.ceil(n / 3));
    expect(decode(text)).toEqual(bytes);
  }
});
