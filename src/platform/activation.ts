export type Activate = () => void | (() => void);

export function activateAll(what: string, list: Array<[string, Activate]>): () => void {
  const disposers: Array<() => void> = [];
  for (const [name, activate] of list) {
    try {
      const dispose = activate();
      if (dispose) disposers.push(dispose);
    } catch (error) {
      console.error(`${what} of ${name} failed to activate`, error);
    }
  }
  return () => disposers.reverse().forEach((dispose) => dispose());
}
