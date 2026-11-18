/** A server that starts after all takes down the balloons that said it could not. */
import { afterEach, expect, it, vi } from "vitest";
import type { IdeEvent } from "@/bindings";
import { emitLocalIdeEvent } from "@/platform/ipc";
import { provideNotificationService } from "@/workbench/contributions";
import { installServerReadyExpiry } from "../missing";

const expire = vi.fn();
provideNotificationService({ notify: () => {}, expire });
const dispose = installServerReadyExpiry();
afterEach(() => expire.mockClear());

const status = (s: string) =>
  emitLocalIdeEvent({
    type: "languageServer",
    server: 1,
    name: "jdtls",
    status: s,
    message: null,
  } as unknown as IdeEvent);

it.each(["starting", "busy", "missing", "misconfigured", "crashed"])(
  "keeps the prompts while the server is %s",
  (s) => {
    status(s);
    expect(expire).not.toHaveBeenCalled();
  },
);

it("expires the missing, JDK and expired-build prompts once the server is ready", () => {
  status("ready");
  expect(expire.mock.calls.map(([key]) => key)).toEqual([
    "lsp-missing-jdtls",
    "jdk-required-jdtls",
    "lsp-expired-jdtls",
  ]);
  dispose();
});
