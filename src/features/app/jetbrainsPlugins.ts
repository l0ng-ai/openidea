/**
 * JetBrains plugins (`installed.txt`, `disabled_plugins.txt`) → OpenIDEA: the marketplace
 * plugins that do the same job, offered for install, and IdeaVim as the built-in Vim emulation.
 */
import type { MarketPlugin } from "@/bindings";

/** JetBrains plugin id → the OpenIDEA marketplace plugin that does the same job. */
export const JETBRAINS_PLUGINS: Readonly<Record<string, string>> = {
  "CheckStyle-IDEA": "openidea.checkstyle",
  "zielu.gittoolbox": "openidea.git-toolbox",
  "Key Promoter X": "openidea.key-promoter",
  "net.seesharpsoft.intellij.plugins.csv": "openidea.csv-editor",
  "me.serce.solidity": "openidea.solidity",
  "com.baomidou.plugin.idea.mybatisx": "openidea.mybatis",
  "String Manipulation": "bertyhell.string-manipulation",
  MavenRunHelper: "fsantomero.maven-helper",
  "com.nasller.CodeGlancePro": "ruyimg.codeglance-pro",
  "com.mallowigi": "mrboombastic.atom-material-icons",
  "lermitage.intellij.extra.icons": "song-cc-rock.extra-icons",
  "com.github.catppuccin.jetbrains": "jaw52.catppuccin-theme",
  "com.github.catppuccin.jetbrains_icons": "jaw52.catppuccin-icons",
  GrepConsole: "solhovoy.grep-console",
  "mobi.hsz.idea.gitignore": "aritti.ignore",
  "ru.adelf.idea.dotenv": "aritti.dotenv",
  "com.intellij.ideolog": "aritti.ideolog",
  "cn.yiiguxing.plugin.translate": "ruyimg.translation",
  "com.alibaba.p3c.smartfox": "alivop.p3c",
  "commit-template-idea-plugin": "chongchong59699.git-commit-template",
  Statistic: "jiusi.statistic",
  Dart: "xirf.dart",
  "io.flutter": "xirf.flutter",
};

const IDEAVIM = "IdeaVIM";
/** Plugins whose job OpenIDEA does without one (besides IdeaVim). */
const BUILT_IN: Readonly<Record<string, string>> = { "com.intellij.lang.jsgraphql": "GraphQL" };

export interface JetBrainsPluginsImport {
  /** Marketplace plugins to offer, not installed here yet. */
  install: { id: string; name: string }[];
  /** IdeaVim is installed and enabled: turn on the Vim emulation. */
  vim: boolean;
  /** Plugins OpenIDEA covers without installing anything. */
  builtIn: string[];
  /** Plugins with a counterpart that are disabled in the JetBrains IDE (not offered). */
  disabled: string[];
  /** JetBrains plugin ids without a counterpart in the marketplace. */
  unmapped: string[];
}

const ids = (text: string | undefined) =>
  (text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

/** `market`: the marketplace's plugins, or null when it cannot be read. */
export function planJetBrainsPlugins(
  installed: string | undefined,
  disabledText: string | undefined,
  market: readonly MarketPlugin[] | null,
): JetBrainsPluginsImport {
  const disabledIds = new Set(ids(disabledText));
  const byId = new Map((market ?? []).map((m) => [m.id, m]));
  const out: JetBrainsPluginsImport = { install: [], vim: false, builtIn: [], disabled: [], unmapped: [] };
  for (const id of new Set(ids(installed))) {
    const off = disabledIds.has(id);
    if (id === IDEAVIM) {
      if (off) out.disabled.push("IdeaVim");
      else out.vim = true;
      continue;
    }
    if (BUILT_IN[id]) {
      out.builtIn.push(BUILT_IN[id]);
      continue;
    }
    const target = byId.get(JETBRAINS_PLUGINS[id] ?? "");
    if (!target?.compatible) out.unmapped.push(id);
    else if (off) out.disabled.push(target.name);
    else if (!target.installed) out.install.push({ id: target.id, name: target.name });
  }
  return out;
}
