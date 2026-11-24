import { describe, expect, test } from "vitest";
import { RenameObservations } from "./commandObservation.ts";

const target = { doc: 7, pos: { line: 2, col: 8 }, newName: "renamed" };
const answer = { edit: { files: [] }, incomplete: null };

function deferred() {
  let resolve!: (value: unknown) => void;
  // The harness TypeScript project targets ES2023.
  const promise = new Promise<unknown>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("rename command observations", () => {
  test("consumes only a matching command in the current operation", async () => {
    const capture = new RenameObservations();
    const scope = capture.begin(target);
    await capture.invoke("lsp_rename", { ...target, doc: 8, request: 1 }, async () => answer);
    await capture.invoke("lsp_rename", { ...target, newName: "other", request: 2 }, async () => answer);
    await capture.invoke("lsp_rename", { ...target, pos: { line: 3, col: 8 }, request: 3 }, async () => answer);
    expect(capture.completed(scope)).toBeNull();
    await capture.invoke("lsp_rename", { ...target, request: 4 }, async () => answer);
    expect(await capture.wait(scope)).toEqual(answer);
  });

  test("reset and failure cannot supply a preceding success", async () => {
    const capture = new RenameObservations();
    const previous = capture.begin(target);
    await capture.invoke("lsp_rename", { ...target, request: 1 }, async () => answer);
    capture.reset();
    expect(capture.completed(previous)).toBeNull();
    await expect(capture.wait(previous)).rejects.toThrow("operation expired");
    const current = capture.begin(target);
    const waiting = capture.wait(current);
    const rejected = expect(waiting).rejects.toThrow("rename failed");
    await expect(
      capture.invoke("lsp_rename", { ...target, request: 2 }, async () => {
        throw new Error("rename failed");
      }),
    ).rejects.toThrow("rename failed");
    await rejected;
    expect(capture.completed(current)).toBeNull();
  });

  test("a failed retry clears a success in the same operation", async () => {
    const capture = new RenameObservations();
    const scope = capture.begin(target);
    await capture.invoke("lsp_rename", { ...target, request: 1 }, async () => answer);
    expect(capture.completed(scope)).toEqual(answer);
    await expect(
      capture.invoke("lsp_rename", { ...target, request: 2 }, async () => {
        throw new Error("retry failed");
      }),
    ).rejects.toThrow("retry failed");
    expect(capture.completed(scope)).toBeNull();
    await expect(capture.wait(scope)).rejects.toThrow("retry failed");
  });

  test("a delayed result from before reset cannot win over a new request", async () => {
    const capture = new RenameObservations();
    capture.begin(target);
    const old = deferred();
    const sending = capture.invoke("lsp_rename", { ...target, request: 1 }, () => old.promise);
    capture.reset();
    const current = capture.begin(target);
    old.resolve(answer);
    await sending;
    expect(capture.completed(current)).toBeNull();
    const fresh = { ...answer, preview: true };
    await capture.invoke("lsp_rename", { ...target, request: 2 }, async () => fresh);
    expect(await capture.wait(current)).toEqual(fresh);
  });

  test("a superseded in-flight request cannot overwrite the latest failure", async () => {
    const capture = new RenameObservations();
    const scope = capture.begin(target);
    const old = deferred();
    const sending = capture.invoke("lsp_rename", { ...target, request: 1 }, () => old.promise);
    await expect(
      capture.invoke("lsp_rename", { ...target, request: 2 }, async () => {
        throw new Error("latest failed");
      }),
    ).rejects.toThrow("latest failed");
    old.resolve(answer);
    await sending;
    expect(capture.completed(scope)).toBeNull();
    await expect(capture.wait(scope)).rejects.toThrow("latest failed");
  });
});
