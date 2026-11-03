import { describe, expect, it } from "vitest";
import { isNeonTranslation, neonFileKind } from "./neonFileKind";

// The names of intellij-neon's NeonFileKindTest.
describe("neonFileKind", () => {
  it.each([
    "config.neon",
    "services.neon",
    "common.neon",
    "config.local.neon",
    "common.prod.neon",
    "config.dev.neon",
    "config.test.neon",
    "config.dist.neon",
    "cs.neon",
  ])("%s is a config", (name) => {
    expect(neonFileKind(name)).toBe("config");
  });

  it.each(["phpstan.neon", "phpstan-baseline.neon", "phpstan.cs.neon", "PHPStan.dist.neon"])(
    "%s is a PHPStan config",
    (name) => {
      expect(neonFileKind(name)).toBe("phpstan");
    },
  );

  it.each([
    "messages.cs.neon",
    "apiToken.sk_SK.neon",
    "messages.pt-BR.neon",
    "messages.pt-br.neon",
    "messages.zh-Hant.neon",
    "messages.sr_Latn_RS.neon",
    "messages.es-419.neon",
    "messages.fil.neon",
    "admin.forms.en_US.neon",
  ])("%s is a translation", (name) => {
    expect(neonFileKind(name)).toBe("translation");
  });

  it("counts only the two catalogues as translations", () => {
    expect(isNeonTranslation("translation")).toBe(true);
    expect(isNeonTranslation("icuTranslation")).toBe(true);
    expect(isNeonTranslation("config")).toBe(false);
    expect(isNeonTranslation("phpstan")).toBe(false);
  });

  it.each(["messages+intl-icu.pt-BR.neon", "messages+intl-icu.en.neon"])("%s is an ICU translation", (name) => {
    expect(neonFileKind(name)).toBe("icuTranslation");
  });
});
