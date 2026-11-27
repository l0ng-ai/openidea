import { afterEach, expect, it } from "vitest";
import { _resetI18nForTests, setLocale, tx } from "@/platform/i18n";
import { usePlatform } from "@/platform/platformInfo";
import { patchSavedBody } from "../patches";

afterEach(() => _resetI18nForTests());

it.each([
  ["macos", "Patch file created successfully. Show it in Finder?", "补丁文件已创建。是否在访达中显示？"],
  ["windows", "Patch file created successfully. Show it in Explorer?", "补丁文件已创建。是否在资源管理器中显示？"],
  ["linux", "Patch file created successfully. Show it in Files?", "补丁文件已创建。是否在文件管理器中显示？"],
])("asks to show the saved patch in the %s file manager", async (os, english, chinese) => {
  const previous = usePlatform.getState().os;
  try {
    usePlatform.setState({ os });
    expect(patchSavedBody()).toBe(english);
    await setLocale("zh");
    expect(tx(patchSavedBody())).toBe(chinese);
  } finally {
    usePlatform.setState({ os: previous });
  }
});
