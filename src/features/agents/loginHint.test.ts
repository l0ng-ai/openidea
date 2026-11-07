import { renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { _resetI18nForTests, setLocale } from "@/platform/i18n";
import { useAgentErrorText } from "./loginHint";

afterEach(() => _resetI18nForTests());

it.each([
  ["Run `cursor-agent login` in a terminal.", "在终端中运行 `cursor-agent login`。"],
  ["Run `'/registry path/cursor-agent' login` in a terminal.", "在终端中运行 `'/registry path/cursor-agent' login`。"],
  [
    "Run `& 'C:\\Agent Tools\\cursor-agent.cmd' login` in a terminal.",
    "在终端中运行 `& 'C:\\Agent Tools\\cursor-agent.cmd' login`。",
  ],
  ["Run `'/registry/claude'` in a terminal and sign in.", "在终端中运行 `'/registry/claude'` 并登录。"],
])("translates sign-in guidance with its command intact: %s", async (hint, translated) => {
  await setLocale("zh");
  const { result } = renderHook(() => useAgentErrorText(`Cursor needs you to sign in. ${hint}`));
  expect(result.current).toBe(`Cursor 需要你登录。${translated}`);
});

it("preserves external agent errors", async () => {
  await setLocale("zh");
  const { result } = renderHook(() => useAgentErrorText("Agent says: authentication failed"));
  expect(result.current).toBe("Agent says: authentication failed");
});
