import { beforeEach, describe, expect, it } from "vitest";
import { _resetReleaseNotesForTests, recordInstalledUpdate, releaseNotesOf } from "./releaseNotes";

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
