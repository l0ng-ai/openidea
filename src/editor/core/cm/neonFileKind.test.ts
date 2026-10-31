import { describe, expect, it } from "vitest";
import { neonFileKind } from "./neonFileKind";

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
    "phpstan.neon",
    "phpstan-baseline.neon",
    "phpstan.cs.neon",
  ])("%s is a config", (name) => {
    expect(neonFileKind(name)).toBe("config");
  });

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

  it.each(["messages+intl-icu.pt-BR.neon", "messages+intl-icu.en.neon"])("%s is an ICU translation", (name) => {
    expect(neonFileKind(name)).toBe("icuTranslation");
  });
});
