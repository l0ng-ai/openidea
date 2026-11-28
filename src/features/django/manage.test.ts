import { describe, expect, it, vi } from "vitest";
import { commandItems, manageArgs, manageConfig, parseHelp } from "./manage";

const HELP = `
Type 'manage.py help <subcommand>' for help on a specific subcommand.

Available subcommands:

[auth]
    changepassword
    createsuperuser

[django]
    check
    makemigrations
    migrate
    sqlmigrate

[polls]
    close_poll
`;

describe("manage.py tasks", () => {
  it("reads the commands of manage.py help by app", () => {
    expect(parseHelp(HELP)).toEqual([
      { name: "changepassword", app: "auth" },
      { name: "createsuperuser", app: "auth" },
      { name: "check", app: "django" },
      { name: "makemigrations", app: "django" },
      { name: "migrate", app: "django" },
      { name: "sqlmigrate", app: "django" },
      { name: "close_poll", app: "polls" },
    ]);
  });

  it("recognizes manage.py command lines", () => {
    expect(manageArgs("manage.py migrate polls 0001")).toEqual(["migrate", "polls", "0001"]);
    expect(manageArgs("python manage.py shell -c 'print(1)'")).toEqual(["shell", "-c", "print(1)"]);
    expect(manageArgs("./manage.py ")).toEqual([]);
    expect(manageArgs("py manage.py check")).toEqual(["check"]);
    expect(manageArgs("python3.12 manage.py check")).toEqual(["check"]);
    // Windows: backslashes in paths stay.
    expect(manageArgs("manage.py loaddata C:\\x\\a.json", true)).toEqual(["loaddata", "C:\\x\\a.json"]);
    expect(manageArgs("manage.pyx migrate")).toBeNull();
    expect(manageArgs("ls")).toBeNull();
  });

  it("runs the line in manage.py's directory in a terminal", () => {
    const c = manageConfig("/p/.venv/bin/python", "/p/site/manage.py", ["migrate", "--plan"]);
    expect(c).toMatchObject({
      name: "manage.py migrate --plan",
      kind: "python",
      command: "/p/.venv/bin/python",
      args: ["manage.py", "migrate", "--plan"],
      cwd: "/p/site",
      emulateTerminal: true,
    });
  });

  it("completes the command word, prefix matches first", () => {
    const run = vi.fn();
    const list = parseHelp(HELP);
    expect(commandItems("manage.py migr", list, run).map((i) => i.label)).toEqual([
      "manage.py migrate",
      "manage.py makemigrations",
      "manage.py sqlmigrate",
    ]);
    expect(commandItems("manage.py migrate ", list, run)).toEqual([]);
    expect(commandItems("pytest", list, run)).toEqual([]);
    const [first] = commandItems("manage.py check", list, run);
    expect(first).toMatchObject({ detail: "django", completion: "manage.py check " });
    first!.run();
    expect(run).toHaveBeenCalledWith("manage.py check");
  });
});
