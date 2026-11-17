import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { DEFAULT_CMAKE_PROFILE } from "@/platform/cmakeSettings";
import { parseArgs } from "@/platform/commandLine";
import { PageContext } from "../components/context";
import { validateSettings } from "../model/schema";
import { useSettingsDialog } from "../model/staging";
import { useSdks } from "../languages/api";
import { CMakeProfiles } from "../pages/cmake";

const savedDialog = useSettingsDialog.getState();
const savedSdks = useSdks.getState();
afterEach(() => {
  cleanup();
  useSettingsDialog.setState(savedDialog, true);
  useSdks.setState(savedSdks, true);
});

it.each([
  ["CMake arguments", "cmakeArgs"],
  ["Build arguments", "buildArgs"],
] as const)("round-trips spaces, quotes and empty values in %s", async (label, key) => {
  const args = ["two words", 'a "quote"', "it's", "", String.raw`C:\some path\file`];
  useSettingsDialog.setState({
    base: validateSettings({ cmake: { profiles: [{ ...DEFAULT_CMAKE_PROFILE, [key]: args }] } }),
    staged: {},
  });
  const mount = () =>
    render(
      <PageContext.Provider value={{ pageId: "build.cmake", scope: "project" }}>
        <CMakeProfiles />
      </PageContext.Provider>,
    );
  const view = mount();
  const input = screen.getByLabelText<HTMLInputElement>(label);
  expect(parseArgs(input.value)).toEqual(args);
  await userEvent.clear(input);
  const text = String.raw`-DNAME="two words" "-DQUOTE=it's" ""`;
  await userEvent.type(input, text);
  expect(input).toHaveValue(text);
  fireEvent.blur(input);
  const expected = ["-DNAME=two words", "-DQUOTE=it's", ""];
  expect(parseArgs(input.value)).toEqual(expected);
  expect(useSettingsDialog.getState().staged["project|cmake.profiles"]?.value).toEqual([
    { ...DEFAULT_CMAKE_PROFILE, [key]: expected },
  ]);
  view.unmount();
  mount();
  expect(parseArgs(screen.getByLabelText<HTMLInputElement>(label).value)).toEqual(expected);
});

it("displays each profile's arguments when switching profiles", () => {
  useSettingsDialog.setState({
    base: validateSettings({
      cmake: {
        profiles: [
          { ...DEFAULT_CMAKE_PROFILE, name: "Debug" },
          { ...DEFAULT_CMAKE_PROFILE, name: "Release", cmakeArgs: ["-DMESSAGE=release build"] },
        ],
      },
    }),
    staged: {},
  });
  render(
    <PageContext.Provider value={{ pageId: "build.cmake", scope: "project" }}>
      <CMakeProfiles />
    </PageContext.Provider>,
  );
  fireEvent.change(screen.getByLabelText("CMake arguments"), { target: { value: '"unfinished ' } });
  fireEvent.click(screen.getByRole("option", { name: "Release" }));
  expect(parseArgs(screen.getByLabelText<HTMLInputElement>("CMake arguments").value)).toEqual([
    "-DMESSAGE=release build",
  ]);
});

const VS = String.raw`C:\Program Files\Microsoft Visual Studio\2022\Community`;

function renderProfiles(profile: Partial<typeof DEFAULT_CMAKE_PROFILE> = {}) {
  useSettingsDialog.setState({
    base: validateSettings({ cmake: { profiles: [{ ...DEFAULT_CMAKE_PROFILE, ...profile }] } }),
    staged: {},
  });
  render(
    <PageContext.Provider value={{ pageId: "build.cmake", scope: "project" }}>
      <CMakeProfiles />
    </PageContext.Provider>,
  );
}

it("offers no toolchain choice where no Visual Studio is installed", () => {
  useSdks.setState({ byKind: { visualStudio: [] } });
  renderProfiles();
  expect(screen.queryByLabelText("Toolchain")).toBeNull();
  expect(screen.queryByLabelText("Architecture")).toBeNull();
});

it("selects a Visual Studio installation and its architecture for the profile", async () => {
  useSdks.setState({
    byKind: {
      visualStudio: [
        {
          path: VS,
          name: "Visual Studio Community 2022",
          version: "17.9.6",
          source: "vswhere",
          home: null,
          extra: null,
        },
      ],
    },
  });
  renderProfiles();
  expect(screen.queryByLabelText("Architecture")).toBeNull();
  await userEvent.click(screen.getByLabelText("Toolchain"));
  await userEvent.click(screen.getByRole("option", { name: /Visual Studio Community 2022 17\.9\.6/ }));
  const staged = () => useSettingsDialog.getState().staged["project|cmake.profiles"]?.value;
  expect(staged()).toEqual([{ ...DEFAULT_CMAKE_PROFILE, toolchain: VS }]);
  fireEvent.change(screen.getByLabelText("Architecture"), { target: { value: "x64_arm64" } });
  expect(staged()).toEqual([{ ...DEFAULT_CMAKE_PROFILE, toolchain: VS, toolchainArch: "x64_arm64" }]);
});

it("keeps showing a saved toolchain that is not installed here", () => {
  useSdks.setState({ byKind: { visualStudio: [] } });
  renderProfiles({ toolchain: VS, toolchainArch: "x86" });
  expect(screen.getByLabelText("Toolchain")).toHaveTextContent(VS);
  expect(screen.getByLabelText<HTMLInputElement>("Architecture").value).toBe("x86");
});
