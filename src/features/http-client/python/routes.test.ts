// @vitest-environment node
import { describe, expect, it } from "vitest";
import { maskPython, moduleOf, normalizePath, pythonRoutes, type PythonSource } from "./routes";

const src = (rel: string, text: string): PythonSource => ({ path: `/p/${rel}`, rel, text });
const brief = (sources: PythonSource[]) =>
  pythonRoutes(sources).map((r) => `${r.framework} ${r.method} ${r.url} ${r.module}.${r.handler} ${r.line}:${r.col}`);

describe("pythonRoutes", () => {
  it("reads Flask routes on the app and on blueprints registered from another module", () => {
    const app = src(
      "app.py",
      `from flask import Flask
from views.users import bp as users_bp
import views.admin

app = Flask(__name__)

@app.route("/")
def index():
    return "hi"

@app.route("/items/<int:item_id>", methods=["GET", "POST"])
def item(item_id):
    ...

@app.post('/login')
async def login(): ...

app.register_blueprint(users_bp, url_prefix="/api/users")
app.register_blueprint(views.admin.admin)
`,
    );
    const users = src(
      "views/users.py",
      `from flask import Blueprint

bp = Blueprint("users", __name__, url_prefix="/ignored")

@bp.get("/<name>")
def show(name): ...

@bp.route(
    "/",  # the list
    methods=("GET",),
)
def list_users(): ...
`,
    );
    const admin = src(
      "views/admin.py",
      `import flask
admin = flask.Blueprint("admin", __name__, url_prefix="/admin")

@admin.delete(r"/cache")
def clear(): ...
`,
    );
    expect(brief([app, users, admin])).toEqual([
      "Flask GET / app.index 6:0",
      "Flask GET /items/{item_id} app.item 10:0",
      "Flask POST /items/{item_id} app.item 10:0",
      "Flask POST /login app.login 14:0",
      "Flask GET /api/users/{name} views.users.show 4:0",
      "Flask GET /api/users/ views.users.list_users 7:0",
      "Flask DELETE /admin/cache views.admin.clear 3:0",
    ]);
  });

  it("reads FastAPI routes with router prefixes, include_router prefixes and nested routers", () => {
    const main = src(
      "app/main.py",
      `from fastapi import FastAPI
from .routers import items, users
from .routers.v2 import router as v2_router

app = FastAPI()

@app.get("/health")
async def health(): ...

app.include_router(items.router, prefix="/api")
app.include_router(users.router)
app.include_router(v2_router, prefix="/v2")
`,
    );
    const items = src(
      "app/routers/items.py",
      `from fastapi import APIRouter, Depends

router = APIRouter(prefix="/items", tags=["items"], dependencies=[Depends(lambda: None)])

@router.get("/{item_id}")
async def read_item(item_id: int): ...

@router.api_route("/", methods=["PUT", "patch"])
def upsert(): ...
`,
    );
    const users = src(
      "app/routers/users.py",
      `from fastapi import APIRouter
router = APIRouter()

@router.get(
    path="/users/{path:path}",
    response_model=None,
)
def user_file(path: str): ...
`,
    );
    const v2 = src(
      "app/routers/v2/__init__.py",
      `from fastapi import APIRouter
from . import things

router = APIRouter(prefix="/x")
router.include_router(things.router, prefix="/things")
`,
    );
    const things = src(
      "app/routers/v2/things.py",
      `from fastapi import APIRouter
router = APIRouter()

@router.head("")
def probe(): ...
`,
    );
    expect(brief([main, items, users, v2, things])).toEqual([
      "FastAPI GET /health app.main.health 6:0",
      "FastAPI GET /api/items/{item_id} app.routers.items.read_item 4:0",
      "FastAPI PUT /api/items/ app.routers.items.upsert 7:0",
      "FastAPI PATCH /api/items/ app.routers.items.upsert 7:0",
      "FastAPI GET /users/{path} app.routers.users.user_file 3:0",
      "FastAPI HEAD /v2/x/things app.routers.v2.things.probe 3:0",
    ]);
  });

  it("matches imports of a src layout and skips paths built at runtime", () => {
    const main = src(
      "src/shop/main.py",
      `from fastapi import FastAPI
from shop.api import router
PREFIX = "/v1"
app = FastAPI()
app.include_router(router, prefix="/shop")

@app.get(f"{PREFIX}/x")
def dynamic(): ...

@app.get(PREFIX + "/y")
def concatenated(): ...
`,
    );
    const api = src(
      "src/shop/api.py",
      `import fastapi\nrouter = fastapi.APIRouter()\n\n@router.get("/cart")\ndef cart(): ...\n`,
    );
    expect(brief([main, api])).toEqual(["FastAPI GET /shop/cart src.shop.api.cart 3:0"]);
  });

  it("ignores decorators inside strings and comments, and other decorators", () => {
    const text = `from flask import Flask
app = Flask(__name__)
# @app.route("/commented")
doc = """
@app.route("/in-a-docstring")
"""
@app.errorhandler(404)
@app.cli.command("init")
def init(): ...
`;
    expect(brief([src("app.py", text)])).toEqual([]);
  });

  it("gives a blueprint registered twice a route per prefix", () => {
    const text = `from flask import Flask, Blueprint
bp = Blueprint("bp", __name__)
@bp.get("/x")
def x(): ...
app = Flask(__name__)
app.register_blueprint(bp, url_prefix="/a")
app.register_blueprint(bp, url_prefix="/b", name="b2")
`;
    expect(brief([src("app.py", text)])).toEqual(["Flask GET /a/x app.x 2:0", "Flask GET /b/x app.x 2:0"]);
  });
});

describe("helpers", () => {
  it("names modules after their file", () => {
    expect(moduleOf("app/routers/items.py")).toBe("app.routers.items");
    expect(moduleOf("app/__init__.py")).toBe("app");
    expect(moduleOf("main.py")).toBe("main");
  });

  it("writes path parameters as {name}", () => {
    expect(normalizePath("/u/<int:id>/<name>/<path:rest>")).toBe("/u/{id}/{name}/{rest}");
    expect(normalizePath("/files/{file_path:path}")).toBe("/files/{file_path}");
    expect(normalizePath("")).toBe("/");
  });

  it("masks strings and comments without moving offsets", () => {
    const text = `a = "x#y" # c\nb = '''l1\nl2''' + r"\\d" + f"{a}"\n`;
    const { code, strings } = maskPython(text);
    expect(code.length).toBe(text.length);
    expect(code.split("\n").length).toBe(text.split("\n").length);
    expect(code).not.toContain("#");
    expect([...strings.values()]).toEqual(["x#y", "l1\nl2", "\\d", null]);
  });
});
