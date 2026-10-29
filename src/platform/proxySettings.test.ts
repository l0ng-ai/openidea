import { describe, expect, it } from "vitest";
import { validateSettings } from "@/features/settings/model/schema";
import { DEFAULT_PROXY, proxyProblem, validateProxy, withProxyKind, type ProxySettingsValid } from "./proxySettings";

const manual = (patch: Partial<ProxySettingsValid> = {}): ProxySettingsValid => ({
  ...DEFAULT_PROXY,
  mode: "manual",
  host: "proxy.corp",
  port: 3128,
  ...patch,
});

describe("validateProxy", () => {
  it("defaults to auto-detect", () => {
    expect(validateProxy(undefined)).toEqual(DEFAULT_PROXY);
    expect(DEFAULT_PROXY.mode).toBe("auto");
    expect(validateSettings({}).proxy).toEqual(DEFAULT_PROXY);
  });

  it("keeps valid values", () => {
    const raw = {
      mode: "manual",
      kind: "socks",
      host: "10.0.0.1",
      port: 1081,
      noProxy: "*.example.com, 192.168.*",
      authenticate: true,
      login: "me",
      password: "pw",
    };
    expect(validateProxy(raw)).toEqual(raw);
    expect(validateProxy({ mode: "none" }).mode).toBe("none");
  });

  it("falls back on malformed values", () => {
    const p = validateProxy({ mode: "pac", kind: "ftp", host: 7, port: 70000, authenticate: "yes", login: null });
    expect(p).toEqual(DEFAULT_PROXY);
    expect(validateProxy({ kind: "socks", port: 0 }).port).toBe(1080);
    expect(validateProxy({ port: 80.5 }).port).toBe(80);
    expect(validateProxy([]).mode).toBe("auto");
  });
});

describe("withProxyKind", () => {
  it("moves a default port along and keeps a custom one", () => {
    expect(withProxyKind(manual({ port: 80 }), "socks")).toMatchObject({ kind: "socks", port: 1080 });
    expect(withProxyKind(manual({ kind: "socks", port: 1080 }), "http").port).toBe(80);
    expect(withProxyKind(manual({ port: 3128 }), "socks").port).toBe(3128);
  });
});

describe("proxyProblem", () => {
  it("checks only a manual configuration", () => {
    expect(proxyProblem({ ...DEFAULT_PROXY, host: "" })).toBeNull();
    expect(proxyProblem({ ...DEFAULT_PROXY, mode: "none" })).toBeNull();
    expect(proxyProblem(manual())).toBeNull();
  });

  it("reports a missing or invalid host, port and login", () => {
    expect(proxyProblem(manual({ host: "  " }))).toBe("Proxy host is empty");
    expect(proxyProblem(manual({ host: "http://proxy" }))).toBe("Invalid proxy host");
    expect(proxyProblem(manual({ host: "user@proxy" }))).toBe("Invalid proxy host");
    expect(proxyProblem(manual({ port: 0 }))).toBe("Proxy port must be between 1 and 65535");
    expect(proxyProblem(manual({ authenticate: true, login: "" }))).toBe("Proxy login is empty");
    expect(proxyProblem(manual({ authenticate: true, login: "me", password: "" }))).toBeNull();
    expect(proxyProblem(manual({ authenticate: false, login: "" }))).toBeNull();
  });
});
