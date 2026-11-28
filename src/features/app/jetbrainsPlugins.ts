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
  /** IdeaVim is installed and enabled: turn on the Vim emulation. */
  vim: boolean;
  /** Plugins OpenIDEA covers without installing anything. */
  builtIn: string[];
  /** Plugins with a counterpart that are disabled in the JetBrains IDE (not offered). */
  disabled: string[];
  /** JetBrains plugin ids OpenIDEA knows no counterpart for. */
  unmapped: string[];
  /** [JetBrains id, marketplace id] of the plugins to look up in the marketplace. */
  candidates: [string, string][];
}

export interface PluginSuggestions {
  /** Marketplace plugins to offer, not installed here yet. */
  install: { id: string; name: string }[];
  /** JetBrains ids whose counterpart the marketplace does not list, or not for this version. */
  unavailable: string[];
}

const ids = (text: string | undefined) =>
  (text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

export function planJetBrainsPlugins(installed: string | undefined, disabledText: string | undefined) {
  const disabledIds = new Set(ids(disabledText));
  const out: JetBrainsPluginsImport = { vim: false, builtIn: [], disabled: [], unmapped: [], candidates: [] };
  for (const id of new Set(ids(installed))) {
    const off = disabledIds.has(id);
    const target = JETBRAINS_PLUGINS[id];
    if (id === IDEAVIM) {
      if (off) out.disabled.push(id);
      else out.vim = true;
    } else if (BUILT_IN[id]) out.builtIn.push(BUILT_IN[id]);
    else if (!target) out.unmapped.push(id);
    else if (off) out.disabled.push(id);
    else out.candidates.push([id, target]);
  }
  return out;
}

/** The candidates the marketplace lists for this version and that are not installed yet. */
export function suggestPlugins(
  candidates: readonly [string, string][],
  market: readonly MarketPlugin[],
): PluginSuggestions {
  const byId = new Map(market.map((m) => [m.id, m]));
  const out: PluginSuggestions = { install: [], unavailable: [] };
  for (const [jetbrains, id] of candidates) {
    const entry = byId.get(id);
    if (!entry?.compatible) out.unavailable.push(jetbrains);
    else if (!entry.installed) out.install.push({ id, name: entry.name });
  }
  return out;
}
