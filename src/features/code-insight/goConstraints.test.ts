import { expect, it } from "vitest";
import { goConstraintExcluded } from "./goConstraints";

it("recognizes build exclusion without confusing unrelated package errors", () => {
  expect(
    goConstraintExcluded("No packages found for open file x.go.\nThis file may be excluded due to its build tags"),
  ).toBe(true);
  expect(goConstraintExcluded("This file may be excluded due to its GOOS/GOARCH, or other build constraints.")).toBe(
    true,
  );
  expect(goConstraintExcluded("No packages found for open file x.go.")).toBe(false);
  expect(goConstraintExcluded("undefined: missingSymbol")).toBe(false);
  expect(goConstraintExcluded("invalid build tags syntax")).toBe(false);
});
