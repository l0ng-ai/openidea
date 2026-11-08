/* global document, localStorage, navigator, window */
// Keep this independent of the module graph: a dependency can fail before main.tsx runs.
(() => {
  const zh = navigator.language.toLowerCase().startsWith("zh");
  const text = zh
    ? {
        title: "OpenIDEA 无法启动",
        report: "请复制下方详情，并附在 GitHub 问题中。",
        link: "报告问题",
        copy: "复制详情",
        copied: "已复制",
        manual: "无法复制。请选择下方详情并手动复制。",
        details: "启动错误详情",
        timeout: "启动未在 30 秒内完成。",
      }
    : {
        title: "OpenIDEA could not start",
        report: "Copy the details below and include them in a GitHub issue.",
        link: "Report an issue",
        copy: "Copy details",
        copied: "Copied",
        manual: "Could not copy. Select the details below and copy them.",
        details: "Startup error details",
        timeout: "Startup did not finish within 30 seconds.",
      };
  let failed = false;
  let ready = false;
  const describe = (reason) => {
    try {
      if (typeof reason?.stack === "string") {
        const message = String(reason);
        return reason.stack.includes(message) ? reason.stack : `${message}\n${reason.stack}`;
      }
      return (typeof reason === "string" ? reason : JSON.stringify(reason)) || String(reason);
    } catch {
      return "Unknown startup error";
    }
  };
  const show = (reason) => {
    if (failed || ready) return;
    failed = true;
    window.clearTimeout(timer);
    document.documentElement.dataset.boot = "failed";
    const render = () => {
      const panel = document.createElement("section");
      panel.id = "boot-error";
      panel.className = "splash boot-error";
      panel.setAttribute("role", "alert");
      const title = document.createElement("h1");
      title.textContent = text.title;
      const hint = document.createElement("p");
      hint.textContent = text.report;
      const details = document.createElement("textarea");
      details.readOnly = true;
      details.setAttribute("aria-label", text.details);
      details.value = `OpenIDEA startup failure\n${navigator.userAgent}\n\n${describe(reason)}`;
      const actions = document.createElement("div");
      actions.className = "boot-error-actions";
      const copy = document.createElement("button");
      copy.type = "button";
      copy.textContent = text.copy;
      const status = document.createElement("p");
      status.setAttribute("role", "status");
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(details.value);
          status.textContent = text.copied;
        } catch {
          details.focus();
          details.select();
          status.textContent = text.manual;
        }
      });
      const report = document.createElement("a");
      report.href = "https://github.com/l0ng-ai/openidea/issues/new?template=bug_report.yml";
      report.target = "_blank";
      report.rel = "noreferrer";
      report.textContent = text.link;
      actions.append(copy, report);
      panel.append(title, hint, details, actions, status);
      document.getElementById("splash")?.remove();
      document.body.appendChild(panel);
      copy.focus();
    };
    if (document.body) render();
    else document.addEventListener("DOMContentLoaded", render, { once: true });
  };
  const onError = (event) => {
    const target = event.target;
    if (target?.tagName === "SCRIPT" || (target?.tagName === "LINK" && target.rel === "modulepreload")) {
      show(`Could not load startup script: ${target.src || target.href}`);
    } else if (event.error || event.message) {
      show(event.error || `${event.message}\n${event.filename || ""}:${event.lineno || 0}:${event.colno || 0}`);
    }
  };
  const onRejection = (event) => show(event.reason);
  const onBootError = (event) => show(event.detail);
  const onReady = () => {
    ready = true;
    window.clearTimeout(timer);
    window.removeEventListener("error", onError, true);
    window.removeEventListener("unhandledrejection", onRejection);
    window.removeEventListener("openidea:boot-error", onBootError);
    window.removeEventListener("openidea:boot-ready", onReady);
  };
  const timer = window.setTimeout(() => show(text.timeout), 30_000);
  window.addEventListener("error", onError, true);
  window.addEventListener("unhandledrejection", onRejection);
  window.addEventListener("openidea:boot-error", onBootError);
  window.addEventListener("openidea:boot-ready", onReady);
})();

// Runs before the app's CSS loads: restores the last theme (theme.ts stores it)
// so a new window starts in it instead of flashing the light default.
// An external file because the CSP forbids inline scripts.
try {
  const root = document.documentElement;
  const addStyle = (id, css) => {
    const style = document.createElement("style");
    style.id = id;
    style.textContent = css;
    document.head.appendChild(style);
  };
  const last = JSON.parse(localStorage.getItem("openidea.theme") ?? "null");
  if (last?.theme) root.dataset.theme = last.theme;
  if (last?.contrast) root.dataset.contrast = last.contrast;
  // A built-in palette theme (Solarized, One) over its light / dark base (tokens.css).
  if (typeof last?.colorTheme === "string" && /^[a-z][a-z0-9-]*$/.test(last.colorTheme))
    root.dataset.colorTheme = last.colorTheme;
  // A plugin theme's stylesheet (plugins/bridge.ts), so the workbench doesn't
  // show the built-in theme until the plugin host answers.
  const plugin = JSON.parse(localStorage.getItem("openidea.pluginTheme") ?? "null");
  if (typeof plugin?.id === "string" && typeof plugin.css === "string" && !/[<\\]|url\(/i.test(plugin.css)) {
    addStyle("openidea-plugin-theme", plugin.css);
    root.dataset.pluginTheme = plugin.id;
    root.dataset.pluginThemeKind = root.dataset.theme = plugin.kind === "light" ? "light" : "dark";
    delete root.dataset.contrast;
    delete root.dataset.colorTheme;
  }
  // The splash's frame, text and accent colours, resolved by theme.ts (splash.css).
  const colors = [
    ["--boot-frame", last?.frame],
    ["--boot-fg", last?.fg],
    ["--boot-accent", last?.accent],
  ].filter(([, v]) => typeof v === "string" && /^#[0-9a-f]{3,8}$/i.test(v));
  if (colors.length) addStyle("openidea-boot-colors", `:root { ${colors.map(([k, v]) => `${k}: ${v};`).join(" ")} }`);
} catch {
  /* storage unavailable */
}
// Settings windows (`settings-<parent>`) load this page too: splash.css drops the logo for them.
if (window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label?.startsWith("settings-")) {
  document.documentElement.dataset.window = "settings";
}
