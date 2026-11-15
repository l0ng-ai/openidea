import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RefLabels } from "../GitLog";

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
});
