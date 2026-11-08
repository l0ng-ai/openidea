import { afterEach, expect, it } from "vitest";
import { windowsPty } from "./windowsPty";
import { usePlatform } from "@/platform/platformInfo";
import { useRemote } from "@/platform/remote";

const initialPlatform = usePlatform.getState();
const initialRemote = useRemote.getState();
afterEach(() => {
  useRemote.setState(initialRemote);
  usePlatform.setState(initialPlatform);
});

it.each(["linux", "windows"])("does not apply the desktop build to a remote %s PTY", (os) => {
  usePlatform.setState({ os: "windows", windowsBuildNumber: 22631 });
  useRemote.setState({
    session: { os, host: "test", root: "/repo", target: { kind: "ssh", config: "test" }, commands: [] },
  });
  expect(windowsPty()).toBeUndefined();
});
