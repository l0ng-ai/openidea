import { afterEach, describe, expect, it, vi } from "vitest";
import { commands, emitLocalIdeEvent } from "@/platform/ipc";
import { ipcPath } from "@/platform/paths";
import { useProject } from "@/platform/project";
import { pythonEndpointsOf, pythonRouteIndex, registerPythonEndpointProvider } from "./routeIndex";

const scanSources = vi.spyOn(commands, "pythonRouteSources");
const readText = vi.spyOn(commands, "fsReadText");

const MAIN = `from fastapi import FastAPI
from app.items import router
app = FastAPI()
app.include_router(router, prefix="/api")
`;
const items = (path: string) => `from fastapi import APIRouter
router = APIRouter()

@router.get("${path}")
def read(): ...
`;

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  scanSources.mockReset();
  readText.mockReset();
  useProject.setState({ project: null });
});

const urls = async () => (await pythonRouteIndex("/p")).map((e) => `${e.method} ${e.url}`);
const changed = (kind: "created" | "modified" | "removed", path: string) =>
  emitLocalIdeEvent({ type: "fsChanged", created: [], modified: [], removed: [], [kind]: [ipcPath(path)] });

describe("the Flask / FastAPI endpoint provider", () => {
  it("scans once, then reads only the changed files again", async () => {
    dispose = registerPythonEndpointProvider();
    scanSources.mockResolvedValue({
      status: "ok",
      data: [
        { path: ipcPath("/p/app/main.py"), text: MAIN },
        { path: ipcPath("/p/app/items.py"), text: items("/items") },
      ],
    });
    expect(await urls()).toEqual(["GET /api/items"]);

    readText.mockResolvedValue({ status: "ok", data: items("/things") });
    changed("modified", "/p/app/items.py");
    expect(await urls()).toEqual(["GET /api/things"]);
    expect(readText).toHaveBeenCalledTimes(1);

    // A file that no longer imports either framework, or was removed, leaves the index.
    readText.mockResolvedValue({ status: "ok", data: "x = 1\n" });
    changed("modified", "/p/app/items.py");
    expect(await urls()).toEqual([]);
    changed("removed", "/p/notes.txt");
    expect(readText).toHaveBeenCalledTimes(2);
    expect(scanSources).toHaveBeenCalledTimes(1);
  });

  it("reads the settings module a prefix names, which the scan doesn't return", async () => {
    dispose = registerPythonEndpointProvider();
    scanSources.mockResolvedValue({
      status: "ok",
      data: [
        {
          path: ipcPath("/p/backend/app/main.py"),
          text: `from fastapi import FastAPI\nfrom app.items import router\nfrom app.core.config import settings\napp = FastAPI()\napp.include_router(router, prefix=settings.API_V1_STR)\n`,
        },
        { path: ipcPath("/p/backend/app/items.py"), text: items("/items") },
      ],
    });
    const config = ipcPath("/p/backend/app/core/config.py");
    readText.mockImplementation(async (path) =>
      path === config
        ? { status: "ok", data: `class Settings:\n    API_V1_STR: str = "/api/v1"\nsettings = Settings()\n` }
        : { status: "error", error: { kind: "notFound", message: "no such file" } as never },
    );
    expect(await urls()).toEqual(["GET /api/v1/items"]);
    expect(readText.mock.calls.map(([path]) => path)).toContain(config);
    // Tried once per index, found or not.
    const reads = readText.mock.calls.length;
    await urls();
    expect(readText).toHaveBeenCalledTimes(reads);
  });

  it("gives the gutter the routes of the text being edited", async () => {
    dispose = registerPythonEndpointProvider();
    scanSources.mockResolvedValue({
      status: "ok",
      data: [
        { path: ipcPath("/p/app/main.py"), text: MAIN },
        { path: ipcPath("/p/app/items.py"), text: items("/items") },
      ],
    });
    const edited = `\n\n${items("/edited")}`;
    const routes = await pythonEndpointsOf("/p", ipcPath("/p/app/items.py"), edited);
    expect(routes.map((e) => `${e.url} ${e.line}`)).toEqual(["/api/edited 5"]);
    // What is on disk is unchanged for everyone else.
    expect(await urls()).toEqual(["GET /api/items"]);
  });
});
