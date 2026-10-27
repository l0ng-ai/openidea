import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SSH_CONFIG, type SshConfigValid } from "@/platform/remoteSettings";
import { answerAskpass, askpassAnswer, dropAskpass, enqueueAskpass, useAskpass } from "./askpass";
import { sessionItems } from "./session";

describe("askpass queue", () => {
  beforeEach(() => useAskpass.setState({ queue: [] }));

  it("queues prompts in arrival order, once each", () => {
    enqueueAskpass({ id: 1, prompt: "Password:", kind: "secret" });
    enqueueAskpass({ id: 2, prompt: "Continue connecting (yes/no)?", kind: "confirm" });
    enqueueAskpass({ id: 1, prompt: "Password:", kind: "secret" });
    expect(useAskpass.getState().queue.map((p) => p.id)).toEqual([1, 2]);
  });

  it("drops a prompt answered elsewhere", () => {
    enqueueAskpass({ id: 1, prompt: "a", kind: "text" });
    enqueueAskpass({ id: 2, prompt: "b", kind: "text" });
    dropAskpass(1);
    dropAskpass(9);
    expect(useAskpass.getState().queue.map((p) => p.id)).toEqual([2]);
  });

  it("answers the backend and shows the next prompt", () => {
    const send = vi.fn((_id: number, _answer: string | null) => Promise.resolve());
    enqueueAskpass({ id: 1, prompt: "a", kind: "secret" });
    enqueueAskpass({ id: 2, prompt: "b", kind: "secret" });
    answerAskpass(1, "hunter2", send);
    expect(send).toHaveBeenCalledWith(1, "hunter2");
    expect(useAskpass.getState().queue.map((p) => p.id)).toEqual([2]);
  });

  it("maps choices to answers", () => {
    expect(askpassAnswer("secret", { text: "pw" })).toBe("pw");
    expect(askpassAnswer("text", { text: "" })).toBe("");
    expect(askpassAnswer("confirm", { confirm: true })).toBe("yes");
    expect(askpassAnswer("confirm", { confirm: false })).toBe("no");
    expect(askpassAnswer("secret", null)).toBeNull();
    expect(askpassAnswer("confirm", null)).toBeNull();
  });
});

describe("Start SSH Session chooser", () => {
  const config = (patch: Partial<SshConfigValid>): SshConfigValid => ({ ...DEFAULT_SSH_CONFIG, ...patch });

  it("lists configurations, then a way to edit them", () => {
    const start = vi.fn();
    const configure = vi.fn();
    const items = sessionItems(
      [
        config({ id: "a", name: "Dev box", host: "box", user: "dev", port: 2222 }),
        config({ id: "b", host: "bastion" }),
        config({ id: "c", name: "Empty" }),
      ],
      start,
      configure,
    );
    expect(items.map((i) => [i.label, i.detail])).toEqual([
      ["Dev box", "dev@box:2222"],
      ["bastion", undefined],
      ["Empty", undefined],
      ["Edit SSH Configurations…", undefined],
    ]);
    expect(items[2]!.disabled).toBeTruthy();
    void items[0]!.run();
    expect(start).toHaveBeenCalledWith("a");
    void items[3]!.run();
    expect(configure).toHaveBeenCalled();
  });

  it("offers to add one when there are none", () => {
    const items = sessionItems([], vi.fn(), vi.fn());
    expect(items.map((i) => i.label)).toEqual(["No SSH configurations. Add one…"]);
  });
});
