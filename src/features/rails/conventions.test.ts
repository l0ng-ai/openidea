import { describe, expect, it } from "vitest";
import { actionAt, controllerName, pluralize, railsFile, railsTargets, singularize, type RailsFs } from "./conventions";

const CONTROLLER = `class Admin::UsersController < ApplicationController
  before_action :load_user

  def index
    @users = User.all
  end

  def show
  end
end
`;

const files: Record<string, string[]> = {
  "/app/app/views/admin/users": ["index.html.erb", "show.html.erb", "_form.html.erb"],
  "/app/app/helpers/admin": ["users_helper.rb"],
  "/app/app/models": ["user.rb"],
  "/app/app/controllers/admin": ["users_controller.rb"],
  "/app/app/controllers": ["people_controller.rb", "users_controller.rb"],
  "/app/db/migrate": [
    "20240101000000_create_users.rb",
    "20240102000000_add_email_to_users.rb",
    "20240103_create_posts.rb",
  ],
};
const texts: Record<string, string> = {
  "/app/app/controllers/admin/users_controller.rb": CONTROLLER,
  "/app/app/controllers/users_controller.rb": "class UsersController\nend\n",
};
const fs: RailsFs = { list: async (d) => files[d] ?? null, read: async (p) => texts[p] ?? null };

describe("rails conventions", () => {
  it("inflects and names", () => {
    expect(pluralize("user")).toBe("users");
    expect(pluralize("category")).toBe("categories");
    expect(pluralize("box")).toBe("boxes");
    expect(pluralize("person")).toBe("people");
    expect(singularize("users")).toBe("user");
    expect(singularize("categories")).toBe("category");
    expect(singularize("addresses")).toBe("address");
    expect(singularize("people")).toBe("person");
    expect(controllerName("admin/order_items")).toBe("Admin::OrderItemsController");
  });

  it("classifies files under app/", () => {
    expect(railsFile("/app/app/controllers/admin/users_controller.rb")).toEqual({
      kind: "controller",
      root: "/app",
      resource: "admin/users",
    });
    expect(railsFile("/app/app/views/users/index.html.erb")).toMatchObject({ kind: "view", file: "index.html.erb" });
    expect(railsFile("/app/app/views/layouts/application.html.erb")).toBeNull();
    expect(railsFile("/app/app/controllers/application_controller.rb")).toBeNull();
    expect(railsFile("/app/app/models/concerns/taggable.rb")).toBeNull();
    expect(railsFile("/app/lib/tasks/x.rb")).toBeNull();
  });

  it("finds the action at the caret", () => {
    expect(actionAt(CONTROLLER, CONTROLLER.indexOf("User.all"))).toBe("index");
    expect(actionAt(CONTROLLER, CONTROLLER.indexOf("before_action"))).toBeNull();
  });

  it("goes from an action to its views, and from a controller to all of them, its helper and model", async () => {
    const at = CONTROLLER.indexOf("User.all");
    const path = "/app/app/controllers/admin/users_controller.rb";
    expect(await railsTargets(path, CONTROLLER, at, fs)).toEqual([
      { path: "/app/app/views/admin/users/index.html.erb", group: "view" },
      { path: "/app/app/helpers/admin/users_helper.rb", group: "helper", label: undefined },
      { path: "/app/app/models/user.rb", group: "model", label: undefined },
    ]);
    const all = await railsTargets(path, CONTROLLER, 0, fs);
    expect(all.filter((t) => t.group === "view").map((t) => t.path.split("/").pop())).toEqual([
      "_form.html.erb",
      "index.html.erb",
      "show.html.erb",
    ]);
  });

  it("goes from a view to its action", async () => {
    const [target] = await railsTargets("/app/app/views/admin/users/show.html.erb", "", 0, fs);
    expect(target).toEqual({
      path: "/app/app/controllers/admin/users_controller.rb",
      group: "controller",
      line: 7,
      label: "Admin::UsersController#show",
    });
    const [partial] = await railsTargets("/app/app/views/admin/users/_form.html.erb", "", 0, fs);
    expect(partial).toMatchObject({ line: undefined, label: "Admin::UsersController" });
  });

  it("goes from a model to its controller and migrations", async () => {
    const targets = await railsTargets("/app/app/models/user.rb", "", 0, fs);
    expect(targets.map((t) => [t.group, t.path.split("/").pop()])).toEqual([
      ["controller", "users_controller.rb"],
      ["migration", "20240101000000_create_users.rb"],
      ["migration", "20240102000000_add_email_to_users.rb"],
    ]);
  });
});
