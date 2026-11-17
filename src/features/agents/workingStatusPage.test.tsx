import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { SettingsFormContext } from "@/workbench/contributions";
import { useSettingsFormFor } from "@/features/settings/components/context";
import { closeSettings, openSettings, stagedValue, useSettingsDialog } from "@/features/settings/model/staging";
import { WORKING_STATUS_PAGE } from "./model";
import { WorkingStatusPage as Page } from "./WorkingStatusPage";
import { PLAYFUL_WORDS } from "./workingStatus";

function WorkingStatusPage() {
  const form = useSettingsFormFor(WORKING_STATUS_PAGE, "global");
  return (
    <SettingsFormContext.Provider value={form}>
      <Page />
    </SettingsFormContext.Provider>
  );
}

const staged = () => stagedValue(useSettingsDialog.getState(), "global", "agents.playfulWords");
const words = () =>
  within(screen.getByRole("list", { name: "Playful words" }))
    .queryAllByRole("listitem")
    .map((item) => item.textContent);
/** The page with playful words turned on, so its word controls are enabled. */
function renderOn() {
  render(<WorkingStatusPage />);
  fireEvent.click(screen.getByRole("checkbox", { name: "Playful words while the agent works" }));
}

describe("Working Status settings", () => {
  beforeEach(() => openSettings(WORKING_STATUS_PAGE));
  afterEach(() => closeSettings());

  it("is off by default, and turning it on enables the words", () => {
    render(<WorkingStatusPage />);
    const toggle = screen.getByRole("checkbox", { name: "Playful words while the agent works" });
    expect(toggle).not.toBeChecked();
    expect(screen.getByRole("textbox", { name: "New playful word" })).toBeDisabled();
    fireEvent.click(toggle);
    expect(stagedValue(useSettingsDialog.getState(), "global", "agents.playfulStatus")).toBe(true);
    expect(screen.getByRole("textbox", { name: "New playful word" })).toBeEnabled();
  });

  it("turns the built-in words into the user's own on the first edit, and restores them", () => {
    renderOn();
    const builtIn = [...PLAYFUL_WORDS.working];
    expect(words()).toEqual(builtIn);

    fireEvent.click(screen.getByRole("button", { name: `Remove ${builtIn[0]}` }));
    const input = screen.getByRole("textbox", { name: "New playful word" });
    fireEvent.change(input, { target: { value: "  Reticulating splines…  " } });
    // Enter adds the word and is not left to press the Settings dialog's OK.
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
    const own = [...builtIn.slice(1), "Reticulating splines…"];
    expect(words()).toEqual(own);
    expect(staged()).toEqual({ working: own });

    fireEvent.click(screen.getByRole("button", { name: "Restore Built-in Words" }));
    expect(staged()).toEqual({});
    expect(words()).toEqual(builtIn);
  });

  it("keeps an emptied list, which leaves the status factual", () => {
    renderOn();
    for (const word of PLAYFUL_WORDS.working) fireEvent.click(screen.getByRole("button", { name: `Remove ${word}` }));
    expect(staged()).toEqual({ working: [] });
    expect(screen.getByText("No playful words: the status stays factual")).toBeInTheDocument();
  });

  it("saves the quiet time while the text is a valid number, and drops invalid text on blur", () => {
    renderOn();
    const after = () => stagedValue(useSettingsDialog.getState(), "global", "agents.playfulAfterSeconds");
    const seconds = screen.getByRole("textbox", { name: "Start after the agent reports nothing new for" });
    expect(seconds).toHaveValue("0");
    fireEvent.change(seconds, { target: { value: "25" } });
    expect(after()).toBe(25);
    fireEvent.change(seconds, { target: { value: "601" } });
    expect(seconds).toHaveAttribute("aria-invalid", "true");
    expect(after()).toBe(25);
    fireEvent.blur(seconds);
    expect(seconds).toHaveValue("25");
  });
});
