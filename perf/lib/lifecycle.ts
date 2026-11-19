import { chromium, type Browser, type LaunchOptions } from "@playwright/test";
import type { Server } from "node:http";

export class DeadlineError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs} ms (wall clock)`);
    this.name = "DeadlineError";
  }
}

/** Runs on Node's clock even if the renderer, rAF, or an RPC never answers. */
export async function withDeadline<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const { promise, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new DeadlineError(label, timeoutMs)), timeoutMs);
  try {
    return await Promise.race([operation, promise]);
  } finally {
    clearTimeout(timer);
  }
}

export interface BrowserSession {
  browser: Browser;
  close(): Promise<void>;
}

export async function launchBrowser(options: LaunchOptions, cleanupMs = 5000): Promise<BrowserSession> {
  const server = await chromium.launchServer({ ...options, timeout: 30_000 });
  const close = async () => {
    try {
      await withDeadline(server.close(), cleanupMs, "browser close");
    } catch (error) {
      try {
        await withDeadline(server.kill(), cleanupMs, "browser kill");
      } catch (killError) {
        throw new AggregateError([error, killError], "Browser cleanup failed", { cause: killError });
      }
      throw error;
    }
  };
  try {
    const browser = await chromium.connect(server.wsEndpoint(), { timeout: 30_000 });
    return { browser, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Browser startup failed", { cause: cleanup });
    }
    throw error;
  }
}

export async function closeServer(server: Server) {
  server.closeAllConnections();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.close((error) => (error ? reject(error) : resolve()));
  await withDeadline(promise, 5000, "HTTP server close");
}
