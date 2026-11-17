import { beforeEach, describe, expect, it, vi } from "vitest";

type Question = { id: number; server: string; message: string; actions: readonly string[] };
type Handler = (event: Question) => unknown;

const mocks = vi.hoisted(() => ({
  handlers: {} as Record<string, Handler>,
  ask: vi.fn(),
  answer: vi.fn(async () => ({ status: "ok", data: null })),
  call: vi.fn(async () => null),
}));

vi.mock("@/platform/ipc", async (original) => ({
  ...(await original<object>()),
  onIdeEvent: (type: string, handler: Handler) => {
    mocks.handlers[type] = handler;
    return () => {};
  },
  commands: { lspMessageRequestAnswer: mocks.answer },
  call: mocks.call,
}));
vi.mock("@/workbench/messages", async (original) => ({
  ...(await original<object>()),
  ask: mocks.ask,
}));

import { activate } from "./index";

const question = {
  id: 7,
  server: "dart",
  message: "Renamed field will be invisible in 'lib/other.dart'",
  actions: ["Rename Anyway", "Cancel"],
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handlers = {};
  activate();
});

describe("language server message requests", () => {
  it("shows the server's actions and answers with the chosen one", async () => {
    mocks.ask.mockResolvedValue({ button: "0", checked: false });
    await mocks.handlers.lspMessageRequest!(question);
    expect(mocks.ask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "dart",
        body: question.message,
        verbatim: true,
        buttons: [
          { id: "0", label: "Rename Anyway", primary: true },
          { id: "1", label: "Cancel", primary: false },
        ],
      }),
    );
    expect(mocks.answer).toHaveBeenCalledWith(7, "Rename Anyway");
    expect(mocks.call).toHaveBeenCalled();
  });

  it("answers null when the dialog is dismissed", async () => {
    mocks.ask.mockResolvedValue({ button: "cancel", checked: false });
    await mocks.handlers.lspMessageRequest!(question);
    expect(mocks.answer).toHaveBeenCalledWith(7, null);
  });
});
