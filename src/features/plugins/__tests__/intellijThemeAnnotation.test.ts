import { describe, expect, it } from "vitest";
import { convertIcls } from "../intellijTheme";

const opt = (name: string, value: string) =>
  `<option name="${name}"><value><option name="FOREGROUND" value="${value}"/></value></option>`;
const scheme = (parent: string, ...options: string[]) =>
  `<scheme name="t" version="142" parent_scheme="${parent}"><attributes>${options.join("")}</attributes></scheme>`;

describe("annotation colour of a theme plugin's scheme (#6108)", () => {
  it("keeps Darcula's annotation colour when the file only changes DEFAULT_METADATA", () => {
    const { tokens } = convertIcls(scheme("Darcula", opt("DEFAULT_METADATA", "1d8711")));
    // Java annotations are drawn with --syn-decorator.
    expect(tokens["--syn-annotation"]).toBe("#bbb529");
    expect(tokens["--syn-decorator"]).toBe("#bbb529");
  });

  it("takes the file's annotation key for annotations", () => {
    const { tokens } = convertIcls(
      scheme("Darcula", opt("DEFAULT_METADATA", "1d8711"), opt("ANNOTATION_NAME_ATTRIBUTES", "9e880d")),
    );
    expect(tokens["--syn-annotation"]).toBe("#9e880d");
    expect(tokens["--syn-decorator"]).toBe("#9e880d");
  });

  it("falls back to DEFAULT_METADATA without a bundled parent", () => {
    const { tokens } = convertIcls(
      `<scheme name="t" version="142"><attributes>${opt("DEFAULT_METADATA", "1d8711")}</attributes></scheme>`,
    );
    expect(tokens["--syn-annotation"]).toBe("#1d8711");
    expect(tokens["--syn-decorator"]).toBe("#1d8711");
  });

  it("leaves a light parent's annotation colour to the base theme", () => {
    const { tokens } = convertIcls(scheme("Default", opt("DEFAULT_METADATA", "1d8711")));
    expect(tokens["--syn-annotation"]).toBeUndefined();
    expect(tokens["--syn-decorator"]).toBeUndefined();
  });
});
