import { beforeEach, describe, expect, it } from "vitest";
import { _resetReleaseNotesForTests, recordInstalledUpdate, recordedNotes, releaseNotesOf } from "./releaseNotes";

beforeEach(() => {
  _resetReleaseNotesForTests();
});

describe("the notes an install records", () => {
  it("are shown for the version that was installed", () => {
    recordInstalledUpdate("0.1.40", "## What's new\n\n- dev containers");
    expect(releaseNotesOf("0.1.40")).toBe("## What's new\n\n- dev containers");
    expect(releaseNotesOf("0.1.41")).toBeNull();
  });

  it("replace the previous install's notes", () => {
    recordInstalledUpdate("0.1.40", "- first");
    recordInstalledUpdate("0.1.41", "- second");
    expect(releaseNotesOf("0.1.40")).toBeNull();
    expect(releaseNotesOf("0.1.41")).toBe("- second");
  });

  it("leave nothing when the manifest had no notes", () => {
    recordInstalledUpdate("0.1.40", "- first");
    recordInstalledUpdate("0.1.41", "   ");
    expect(releaseNotesOf("0.1.40")).toBeNull();
    expect(releaseNotesOf("0.1.41")).toBeNull();
  });

  it("ignore a stored value of the wrong shape", () => {
    localStorage.setItem("openidea.whatsNew.notes.v1", '{"version":5,"text":true}');
    expect(releaseNotesOf("0.1.40")).toBeNull();
  });
});

describe("the notes' languages", () => {
  it("show the configured language when the manifest carried its translation", () => {
    // The manifest's `notes.<lang>` entries arrive keyed by their base language code.
    recordInstalledUpdate("0.1.40", "- English", { zh: "- 中文", pt: "- Português" });
    expect(releaseNotesOf("0.1.40", "zh")).toBe("- 中文");
    expect(releaseNotesOf("0.1.40", "pt")).toBe("- Português");
    expect(recordedNotes("0.1.40")?.texts).toEqual({ zh: "- 中文", pt: "- Português" });
  });

  it("fall back to English when a language has no translation", () => {
    recordInstalledUpdate("0.1.40", "- English", { ko: "- 한국어" });
    expect(releaseNotesOf("0.1.40", "zh")).toBe("- English");
    expect(releaseNotesOf("0.1.40")).toBe("- English");
  });

  it("keep English and empty translations out of the languages", () => {
    recordInstalledUpdate("0.1.40", "- English", { en: "- English again", zh: "  ", "": "- nothing" });
    expect(recordedNotes("0.1.40")).toEqual({ text: "- English", texts: {} });
  });

  it("read entries recorded before translations existed", () => {
    localStorage.setItem("openidea.whatsNew.notes.v1", JSON.stringify({ version: "0.1.40", text: "- older" }));
    expect(releaseNotesOf("0.1.40", "zh")).toBe("- older");
    expect(recordedNotes("0.1.40")).toEqual({ text: "- older", texts: {} });
  });
});
