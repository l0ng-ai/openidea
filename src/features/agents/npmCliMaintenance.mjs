// Runs with the local Node executable, outside the project. npm may update only the
// package that owns the selected executable.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

function maintain({ npm, command, program, pkg, update }) {
  const real = (file) => fs.realpathSync(file);
  const exists = (file) => fs.existsSync(file);
  const windows = process.platform === "win32";
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const options = {
    encoding: "utf8",
    timeout: update ? 180000 : 20000,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    // npm and version-manager shims (asdf, nodenv, nvm-windows) find node on PATH.
    env: { ...process.env, [pathKey]: path.dirname(process.execPath) + path.delimiter + (process.env[pathKey] ?? "") },
  };
  const npmCli = path.join(path.dirname(npm), "node_modules", "npm", "bin", "npm-cli.js");
  const run = (...args) => {
    if (!windows || /\.exe$/i.test(npm)) return execFileSync(npm, args, options).trim();
    if (exists(npmCli)) return execFileSync(process.execPath, [npmCli, ...args], options).trim();
    // Node cannot start a .cmd shim without a shell; quote for cmd.exe, refusing what it would expand.
    if ([npm, ...args].some((arg) => /["%!\r\n]/.test(arg))) throw new Error("Unsupported npm path");
    const line = [npm, ...args].map((arg) => `"${arg}"`).join(" ");
    const cmd = process.env.ComSpec ?? "cmd.exe";
    return execFileSync(cmd, ["/d", "/s", "/c", `"${line}"`], { ...options, windowsVerbatimArguments: true }).trim();
  };
  const binAt = (dir) => path.join(dir, windows ? "" : "bin", command + (windows ? ".cmd" : ""));
  const packageAt = (dir) => path.join(dir, windows ? "" : "lib", "node_modules", pkg);
  const prefix = run("prefix", "--global");
  const folder = packageAt(prefix);
  const manifest = path.join(folder, "package.json");
  const unsupported = { status: "unmanaged" };
  if (!exists(manifest) || fs.lstatSync(folder).isSymbolicLink()) return unsupported;
  const read = () => JSON.parse(fs.readFileSync(manifest, "utf8"));
  const installed = read();
  const bin = typeof installed.bin === "string" ? installed.bin : installed.bin?.[command];
  if (installed.name !== pkg || !bin) return unsupported;
  const entry = real(path.resolve(folder, bin));
  const link = binAt(prefix);
  if (!exists(link)) return unsupported;
  if (windows) {
    // Check npm's generated cmd shim, not just an unrelated .cmd in the same prefix.
    const target = path.relative(prefix, entry).replaceAll("/", "\\").toLowerCase();
    const shim = fs.readFileSync(link, "utf8").replaceAll("/", "\\").toLowerCase();
    if (!shim.includes("%dp0%\\" + target + '"')) return unsupported;
  } else if (real(link) !== entry) return unsupported;

  // `program` is what the agent launcher starts, so another install it prefers is left alone.
  const same = (a, b) => (windows ? real(a).toLowerCase() === real(b).toLowerCase() : real(a) === real(b));
  if (!path.isAbsolute(program) || !exists(program) || !same(program, link)) return unsupported;
  const current = installed.version;
  const latest = JSON.parse(run("view", pkg + "@latest", "version", "--json"));
  const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  if (typeof latest !== "string" || !stable.test(latest) || !stable.test(current))
    return { status: "channel", current };
  const a = current.split(".").map(Number),
    b = latest.split(".").map(Number);
  const diff = a.findIndex((n, i) => n !== b[i]);
  if (diff < 0 || a[diff] > b[diff]) return { status: "current", current };
  let writable = true;
  try {
    for (const dir of [
      folder,
      path.dirname(folder),
      path.join(prefix, windows ? "" : "lib", "node_modules"),
      path.dirname(link),
    ])
      fs.accessSync(dir, fs.constants.W_OK);
  } catch (error) {
    if (!["EACCES", "EPERM", "EROFS"].includes(error.code)) throw error;
    writable = false;
  }
  const offer = { status: writable ? "available" : "permission", current, latest, prefix };
  if (!writable || !update || update.latest !== latest || update.prefix !== prefix || update.current !== current)
    return offer;
  run("install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", pkg + "@" + latest);
  const version = read().version;
  if (version !== latest || !exists(link)) throw new Error("Installation verification failed");
  return { status: "updated", current: version };
}

// The IDE may decode this output with a non-UTF-8 console code page; ASCII survives it.
const reply = (value) =>
  console.log(
    JSON.stringify(value).replace(/[^\x20-\x7e]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")),
  );

try {
  reply(maintain(JSON.parse(process.argv[1])));
} catch (error) {
  // npm's raw output can contain private registry URLs.
  const code = String(error.stderr ?? "").match(
    /\b(?:EACCES|EPERM|EROFS|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|E404|E401|E403)\b/,
  )?.[0];
  reply({ status: "error", code: code ?? String(error.code ?? error.status ?? "npm") });
}
