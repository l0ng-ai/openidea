import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { usePlatform } from "@/platform/platformInfo";
import { validateAppearanceExtras } from "../model/behaviorSchema";
import { useSettingsDialog } from "../model/staging";
import { BEHAVIOR_PAGES } from "../pages/behavior";

const savedPlatform = usePlatform.getState();
const savedDialog = useSettingsDialog.getState();
afterEach(() => {
  usePlatform.setState(savedPlatform);
  useSettingsDialog.setState(savedDialog);
});
const option = BEHAVIOR_PAGES.find((p) => p.id === "appearance")!
  .sections!.find((s) => s.title === "UI Options")!
  .options.find((o) => o.kind === "custom")!;
if (option.kind !== "custom") throw new Error("UI Options missing");
const MainMenuStyleRow = option.component;

describe("Main menu appearance setting", () => {
  it.each(["windows", "linux"])("offers both styles on a frameless %s title bar", async (os) => {
    usePlatform.setState({ os, framelessTitleBar: true });
    render(<MainMenuStyleRow />);
    const select = screen.getByRole("button", { name: "Main menu" });
    expect(select).toHaveTextContent("Hamburger button");
    fireEvent.click(select);
    fireEvent.click(await screen.findByRole("option", { name: "Merged with main toolbar" }));
    expect(select).toHaveTextContent("Merged with main toolbar");
    expect(useSettingsDialog.getState().staged["global|appearance.mainMenuStyle"]?.value).toBe("merged");
  });

  it.each(["macos", "web", "linux"])("hides the setting without the frameless menu (%s)", (os) => {
    usePlatform.setState({ os, framelessTitleBar: false });
    render(<MainMenuStyleRow />);
    expect(screen.queryByText("Main menu")).toBeNull();
    expect(screen.queryByRole("button", { name: "Main menu" })).toBeNull();
    act(() => usePlatform.setState({ os: "windows", framelessTitleBar: true }));
    expect(screen.getByRole("button", { name: "Main menu" })).toBeInTheDocument();
  });

  it("preserves the hamburger default for existing or invalid settings", () => {
    expect(validateAppearanceExtras({}).mainMenuStyle).toBe("hamburger");
    expect(validateAppearanceExtras({ mainMenuStyle: "unknown" }).mainMenuStyle).toBe("hamburger");
    expect(validateAppearanceExtras({ mainMenuStyle: "merged" }).mainMenuStyle).toBe("merged");
  });
});
