import { describe, expect, it } from "vitest";
import { componentFileItems, componentUrls } from "./componentFiles";

const fakeFs = (tree: Record<string, string[]>) => async (dir: string) => tree[dir] ?? null;

const ANGULAR = fakeFs({
  "/p/app/user": [
    "user.component.ts",
    "user.component.html",
    "user.component.scss",
    "user.component.spec.ts",
    "user.service.ts",
    "user.service.spec.ts",
    "README.md",
  ],
});

const REACT = fakeFs({
  "/p/src/Button": [
    "Button.tsx",
    "Button.module.css",
    "Button.test.tsx",
    "Button.stories.tsx",
    "Button.js",
    "ButtonGroup.tsx",
    "index.ts",
  ],
});

describe("component related files", () => {
  it("lists an Angular component's template, styles and spec, grouped", async () => {
    expect(await componentFileItems("/p/app/user/user.component.ts", "", ANGULAR)).toEqual([
      { path: "/p/app/user/user.component.html", group: "Template" },
      { path: "/p/app/user/user.component.scss", group: "Styles" },
      { path: "/p/app/user/user.component.spec.ts", group: "Test" },
    ]);
  });

  it("goes back to the component from its template, styles or spec", async () => {
    const others = ["user.component.html", "user.component.scss", "user.component.spec.ts"];
    const all = await Promise.all(others.map((o) => componentFileItems(`/p/app/user/${o}`, "", ANGULAR)));
    all.forEach((items, i) => {
      expect(items[0]).toEqual({ path: "/p/app/user/user.component.ts", group: "Source" });
      expect(items).toHaveLength(3);
      expect(items.map((it) => it.path)).not.toContain(`/p/app/user/${others[i]}`);
    });
  });

  it("pairs a service with its spec only", async () => {
    expect(await componentFileItems("/p/app/user/user.service.ts", "", ANGULAR)).toEqual([
      { path: "/p/app/user/user.service.spec.ts", group: "Test" },
    ]);
  });

  it("lists a React component's CSS module, test and stories, and the reverse", async () => {
    expect(await componentFileItems("/p/src/Button/Button.tsx", "", REACT)).toEqual([
      { path: "/p/src/Button/Button.module.css", group: "Styles" },
      { path: "/p/src/Button/Button.test.tsx", group: "Test" },
      { path: "/p/src/Button/Button.stories.tsx", group: "Stories" },
    ]);
    const back = await componentFileItems("/p/src/Button/Button.module.css", "", REACT);
    expect(back.map((i) => i.path)).toEqual([
      "/p/src/Button/Button.js",
      "/p/src/Button/Button.tsx",
      "/p/src/Button/Button.test.tsx",
      "/p/src/Button/Button.stories.tsx",
    ]);
  });

  it("follows templateUrl and styleUrls to other files", async () => {
    const fs = fakeFs({
      "/p/app/user": ["user.component.ts"],
      "/p/app/shared": ["card.html", "card.css"],
      "/p/app": ["theme.scss"],
    });
    const text = `@Component({
  selector: "app-user",
  templateUrl: "../shared/card.html",
  styleUrls: ["../shared/card.css", './missing.css', "../theme.scss"],
})`;
    expect(await componentFileItems("/p/app/user/user.component.ts", text, fs)).toEqual([
      { path: "/p/app/shared/card.html", group: "Template" },
      { path: "/p/app/shared/card.css", group: "Styles" },
      { path: "/p/app/theme.scss", group: "Styles" },
    ]);
  });

  it("reads templateUrl, styleUrl and styleUrls", () => {
    expect(componentUrls(`templateUrl: './a.html', styleUrl: "./a.css"`)).toEqual([
      { ref: "./a.html", group: "template" },
      { ref: "./a.css", group: "styles" },
    ]);
    expect(componentUrls("styleUrls: [`./a.scss`, './b.scss']").map((u) => u.ref)).toEqual(["./a.scss", "./b.scss"]);
  });

  it("finds nothing for unrelated files", async () => {
    const fs = fakeFs({ "/p": ["main.ts", "notes.md", "foo.c", "foo.h", "users_controller.rb", "app.module.ts"] });
    const files = ["main.ts", "notes.md", "foo.c", "users_controller.rb", "app.module.ts"];
    expect(await Promise.all(files.map((f) => componentFileItems(`/p/${f}`, "", fs)))).toEqual(files.map(() => []));
    expect(await componentFileItems("/q/Button.tsx", "", fs)).toEqual([]);
  });
});
