import { call, commands, isTauri } from "./ipc";

/** A document closes only after its final project view closes, including other windows. */
export class EditorInputLeases {
  private live = new Map<string, Promise<void>>();
  private released = new Map<string, Promise<boolean>>();
  private pending = new Map<string, Promise<unknown>>();
  retain(key: string): void {
    if (this.live.has(key)) return;
    this.released.delete(key);
    const ready = Promise.resolve(this.pending.get(key)).then(async () => {
      if (isTauri()) await call(commands.windowRetainEditorInput(key));
    });
    this.live.set(key, ready);
    this.pending.set(key, ready);
  }
  release(key: string): Promise<boolean> {
    const previous = this.released.get(key);
    if (previous) return previous;
    const closed = Promise.resolve(this.pending.get(key)).then(() =>
      isTauri() ? call(commands.windowReleaseEditorInput(key)) : true,
    );
    this.live.delete(key);
    this.released.set(key, closed);
    this.pending.set(key, closed);
    const clean = () =>
      setTimeout(() => {
        if (this.released.get(key) === closed) this.released.delete(key);
        if (this.pending.get(key) === closed) this.pending.delete(key);
      }, 0);
    void closed.then(clean, clean);
    return closed;
  }
  async ready(): Promise<void> {
    await Promise.all(this.live.values());
  }
}
