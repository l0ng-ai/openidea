import { describe, expect, it } from "vitest";
import {
  PAGE_BYTES,
  ROW_BYTES,
  addressWidth,
  asciiChar,
  formatAddress,
  hexByte,
  memoryRows,
  parseAddress,
  rowOffset,
} from "../memoryView/bytes";

// The reporter's `constexpr char msg[] = "Hello, World!\n";` (#5921), as `memory read` printed it.
const MSG = [0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x2c, 0x20, 0x57, 0x6f, 0x72, 0x6c, 0x64, 0x21, 0x0a, 0x00];

describe("parseAddress", () => {
  it.each([
    ["0x7fffffff9f69", 0x7fffffff9f69n],
    ["0X16FDFE9A0", 0x16fdfe9a0n],
    ["140737488330601", 140737488330601n],
    // A value that starts with its address: GDB's and LLDB's `char *`.
    ['0x000000016fdfe9a0 "Hello, World!\\n"', 0x16fdfe9a0n],
    // Past 2^53, where a Number would round.
    ["0xfffffffffffffff1", 0xfffffffffffffff1n],
  ])("%s", (text, address) => {
    expect(parseAddress(text)).toBe(address);
  });

  it.each(["", "{...}", "1.5", "-4", "msg", "0xzz", "12abc", '"0x10"'])("%s is not an address", (text) => {
    expect(parseAddress(text)).toBeNull();
  });
});

describe("rows", () => {
  it("starts rows at multiples of 16 and keeps hex and ASCII byte for byte", () => {
    // GDB put the reporter's string at an address 9 bytes into its row: the page starts 9 bytes earlier.
    const target = 0x7fffffff9f69n;
    expect(rowOffset(target)).toBe(9);
    const start = target - BigInt(rowOffset(target));
    const data = [...Array<number>(9).fill(0xaa), ...MSG];
    const rows = memoryRows(start, data, 0);
    expect(rows.map((r) => r.address)).toEqual([0x7fffffff9f60n, 0x7fffffff9f70n]);
    expect(rows.every((r) => r.address % BigInt(ROW_BYTES) === 0n)).toBe(true);
    expect(rows[0]!.bytes).toHaveLength(ROW_BYTES);
    expect(rows[1]!.bytes).toHaveLength(data.length - ROW_BYTES);
    const text = rows.flatMap((r) => r.bytes).slice(9);
    expect(text.map(hexByte).join(" ")).toBe("48 65 6C 6C 6F 2C 20 57 6F 72 6C 64 21 0A 00");
    expect(text.map(asciiChar).join("")).toBe("Hello, World!..");
  });

  it("shows unreadable bytes as ?? after the ones read", () => {
    const rows = memoryRows(0x1000n, [0x41, 0x42], 18);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.bytes.map(hexByte).slice(0, 3)).toEqual(["41", "42", "??"]);
    expect(rows[1]!.bytes).toEqual([null, null, null, null]);
    expect(rows[0]!.bytes.map(asciiChar).join("")).toBe(`AB${" ".repeat(14)}`);
  });

  it("widens the address column only for addresses past 32 bits", () => {
    expect(addressWidth(memoryRows(0xffff_ff00n, Array<number>(PAGE_BYTES).fill(0), 0))).toBe(8);
    expect(addressWidth(memoryRows(0xffff_ff10n, Array<number>(PAGE_BYTES).fill(0), 0))).toBe(16);
    expect(formatAddress(0x9f60n, 8)).toBe("0x00009F60");
    expect(formatAddress(0x7fffffff9f60n, 16)).toBe("0x00007FFFFFFF9F60");
  });

  it("prints only printable ASCII", () => {
    expect([0x00, 0x1f, 0x20, 0x7e, 0x7f, 0xff].map(asciiChar).join("")).toBe(".. ~..");
  });
});
