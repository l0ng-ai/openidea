import { afterEach, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { usePlatform } from "@/platform/platformInfo";
import { Mnemonic } from "./Mnemonic";

const os = usePlatform.getState().os;
afterEach(() => usePlatform.setState({ os }));

const html = (text: string, char: string) =>
  render(<Mnemonic text={text} char={char} />).container.querySelector("span")!.innerHTML;

describe("Mnemonic", () => {
  it.each([
    ["In Project", "P", "In <u>P</u>roject"],
    ["Replace All", "A", "Replace <u>A</u>ll"],
    ["File mask:", "K", "File mas<u>k</u>:"],
    ["Open results in new tab", "B", "Open results in new ta<u>b</u>"],
    ["在项目", "P", "在项目 (<u>P</u>)"],
    ["文件掩码：", "K", "文件掩码 (<u>K</u>)："],
  ])("underlines %s's %s on Windows and Linux", (text, char, expected) => {
    usePlatform.setState({ os: "linux" });
    expect(html(text, char)).toBe(expected);
  });

  it("is plain text on macOS", () => {
    usePlatform.setState({ os: "macos" });
    expect(html("在项目", "P")).toBe("在项目");
  });
});
