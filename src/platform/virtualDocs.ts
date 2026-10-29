/**
 * Virtual documents: read-only contents a language server provides for a
 * non-`file:` URI (library classes from jdtls' `jdt://contents/…`, decompiled
 * code). Locations into them carry the URI as their `path`; the editor opens
 * them as `virtual` editor inputs instead of files.
 */
import { call, commands, type VirtualDocument } from "./ipc";

/** True for `scheme:…` URIs other than `file:` (scheme of 2+ chars, so `C:\…` is a path). */
export function isVirtualUri(s: string | null | undefined): boolean {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]+):/.exec(s ?? "");
  return !!m && m[1]!.toLowerCase() !== "file";
}

/** Last path segment of a URI (without query / fragment), e.g. `SpringApplication.class`. */
export function virtualName(uri: string): string {
  const rest = uri.replace(/^[^:]+:(\/\/)?/, "").split(/[?#]/)[0]!;
  const seg = rest.split("/").filter(Boolean).pop() ?? uri;
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/** The URI's path without its last segment, e.g. `jdt://contents/x.jar/org.example`. */
export function virtualParent(uri: string): string {
  const base = uri.split(/[?#]/)[0]!;
  const i = base.lastIndexOf("/");
  return i > base.indexOf("://") + 2 ? base.slice(0, i) : base;
}

/**
 * Short human location of a virtual document, e.g. `spring-boot-4.1.1.jar › org.springframework.boot`
 * for `jdt://contents/spring-boot-4.1.1.jar/org.springframework.boot/SpringApplication.class?=…`.
 */
export function virtualContainer(uri: string): string {
  const scheme = uri.slice(0, uri.indexOf(":"));
  const rest = uri.replace(/^[^:]+:(\/\/)?/, "").split(/[?#]/)[0]!;
  const segs = rest
    .split("/")
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  segs.pop();
  if (scheme === "jdt" && segs[0] === "contents") segs.shift();
  return segs.join(" › ");
}

const cache = new Map<string, Promise<VirtualDocument>>();

/** Contents of a virtual document (cached; failures are retried on the next call). */
export function virtualDocument(uri: string): Promise<VirtualDocument> {
  let p = cache.get(uri);
  if (!p) {
    p = call(commands.lspVirtualDocument(uri));
    p.catch(() => cache.delete(uri));
    cache.set(uri, p);
  }
  return p;
}
