import { executeAction, getAction } from "@/platform/actions";
import { getContext, setContext } from "@/platform/context";

/** Dispatches an awaitable build and consumes only its fresh completion status. */
export async function buildTask(action: string, arg: unknown): Promise<string | null> {
  if (!getAction(action)) return "Building is not available";
  if (getContext()["build.running"]) return "A build is already running";
  setContext("build.lastStatus", null);
  if (!(await executeAction(action, arg))) return "A build is already running";
  switch (getContext()["build.lastStatus"]) {
    case "success":
      return null;
    case "cancelled":
      return "Build cancelled";
    case "failed":
      return "Build failed";
    default:
      return "Build did not start";
  }
}
