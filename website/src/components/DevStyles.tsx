import { useEffect } from "react";
import { publicAsset } from "../lib/paths.mjs";

// Start has no index.html entry for StyleX's automatic dev-server injection.
// Production CSS is extracted into the normal Vite stylesheet instead.
export function DevStyles() {
  useEffect(() => {
    if (import.meta.env.DEV) void import("virtual:stylex:css-only");
  }, []);
  return import.meta.env.DEV ? (
    <link rel="stylesheet" href={publicAsset("virtual:stylex.css", import.meta.env.BASE_URL)} />
  ) : null;
}
