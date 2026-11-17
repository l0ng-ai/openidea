/** Web documentation links a language server's convention lets us resolve to a declaration. */
import { findInPackage, pkgGoDevLink } from "./go";
import { findRustItem, rustDocLink } from "./rust";
import type { DocTarget } from "./symbols";

/** Looks up the declaration `href` documents; null when no language's rule reads the link. */
export function docUrlResolver(href: string): (() => Promise<DocTarget | null>) | null {
  const go = pkgGoDevLink(href);
  if (go) return () => findInPackage(go.importPath, go.name);
  const rust = rustDocLink(href);
  if (rust) return () => findRustItem(rust);
  return null;
}
