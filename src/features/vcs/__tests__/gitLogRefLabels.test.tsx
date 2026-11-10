import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RefLabels } from "../GitLog";

const css = readFileSync("src/features/vcs/GitLog.module.css", "utf8");

const LONG_LOCAL = "feature-connection-storm-v2";
const LONG_REMOTE = "gitlab/feature-connection-storm-v2";
const REMOTES = new Set([LONG_REMOTE]);

describe("RefLabels long branch names (#2447)", () => {
  it("renders full names with title tooltips in regular mode", () => {
    render(<RefLabels refs={[LONG_LOCAL, LONG_REMOTE]} remoteNames={REMOTES} />);
    expect(screen.getByTitle(LONG_LOCAL)).toHaveTextContent(LONG_LOCAL);
    expect(screen.getByTitle(LONG_REMOTE)).toHaveTextContent(LONG_REMOTE);
  });

  it("absorbs the remote into the local label in compact mode", () => {
    render(<RefLabels refs={[LONG_LOCAL, LONG_REMOTE]} compact remoteNames={REMOTES} />);
    expect(screen.getByTitle(`${LONG_LOCAL}, ${LONG_REMOTE}`)).toHaveTextContent(`gitlab & ${LONG_LOCAL}`);
  });

  it("lets labels size to content: no fixed pixel cap, ellipsis and clipping kept", () => {
    const refBlocks = [...css.matchAll(/\.ref\s*\{([^}]*)\}/g)].map((m) => m[1]);
    expect(refBlocks.length).toBeGreaterThan(0);
    for (const block of refBlocks) expect(block).not.toMatch(/max-width:\s*\d+px/);
    expect(refBlocks[0]).toMatch(/text-overflow:\s*ellipsis/);
    const refsBlock = css.match(/\.refs\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(refsBlock).toMatch(/overflow:\s*hidden/);
  });
});
