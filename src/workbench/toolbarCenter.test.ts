import { describe, expect, it } from "vitest";
import { centerSpacerWidth } from "./toolbarCenter";

describe("main toolbar Center group", () => {
  const bar = { left: 0, width: 1000 };
  it("centres the group on the whole bar when the other groups leave room", () => {
    // Left group ends at 200, center group is 100 wide: it starts at 450.
    expect(centerSpacerWidth(bar, 100, 200, 600, 24)).toBe(250);
  });
  it("pushes the group against the right group when centring would overlap it", () => {
    // The spacers share 200px from 200: the right one keeps 24, so the group starts at 376, not 450.
    expect(centerSpacerWidth(bar, 100, 200, 200, 24)).toBe(176);
  });
  it("keeps the spacer's minimum after a wide left group", () => {
    expect(centerSpacerWidth(bar, 100, 500, 300, 24)).toBe(24);
  });
});
