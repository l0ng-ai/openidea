import { describe, expect, it } from "vitest";
import { PROJECT_KINDS } from "../newProjectLanguages";
import { officialCase } from "../newProjectOfficialTests";
import { projectNames, starterFiles } from "../newProjectTemplates";

describe("framework starter tests", () => {
  it("gives every web framework the test file from that framework's own guide", () => {
    const names = projectNames("demo");
    const frameworks = PROJECT_KINDS.map((kind) => kind.id).filter((id) => officialCase(id, names));
    expect(frameworks).toEqual(
      expect.arrayContaining([
        "nextjs",
        "nuxt",
        "react",
        "vuejs",
        "django",
        "rails",
        "spring",
        "ktor",
        "axum",
        "phoenix",
        "flutter",
        "laravel",
      ]),
    );
    for (const id of frameworks) {
      const spec = officialCase(id, names);
      const files = starterFiles(id, "demo");
      const testFile = files.find((file) => file.path === spec?.path);
      expect(testFile, id).toBeTruthy();
      expect(testFile?.contents, id).toContain(spec?.marker);
      const paths = files.map((file) => file.path);
      expect(new Set(paths).size, id).toBe(paths.length);
    }
  });
});
