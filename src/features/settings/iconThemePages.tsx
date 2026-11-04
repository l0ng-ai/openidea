import { useContributedIconThemes, type IconThemeChoice, type IconThemeDetails } from "@/platform/themes";
import { registerSettingsPage } from "@/workbench/contributions";
import { IconThemeSettings } from "./pages/IconThemeSettings";

function keywords(theme: IconThemeChoice, details: IconThemeDetails): string[] {
  const words = details.settings.flatMap((s) => [
    s.title,
    ...s.items.flatMap((item) => {
      if (item.option === "groups") return details.groups.map((g) => g.name);
      if (item.option === "choice") return details.choices.filter((c) => c.id === item.choice).map((c) => c.name);
      return [item.label ?? ""];
    }),
  ]);
  return [theme.origin ?? "", ...words].filter(Boolean);
}

function register(theme: IconThemeChoice, page: string, details: IconThemeDetails): () => void {
  return registerSettingsPage({
    id: page,
    title: theme.label,
    keywords: keywords(theme, details),
    component: () => <IconThemeSettings themeKey={theme.id} details={details} />,
  });
}

export function trackIconThemePages(): () => void {
  const pages = new Map<IconThemeChoice, () => void>();
  const pending = new Set<IconThemeChoice>();
  const add = async (theme: IconThemeChoice, page: string) => {
    pending.add(theme);
    try {
      const details = await theme.details?.();
      if (!pending.has(theme) || !details?.settings.length) return;
      pages.set(theme, register(theme, page, details));
    } catch (e) {
      console.warn(`icon theme ${theme.id}: cannot load its settings`, e);
    } finally {
      pending.delete(theme);
    }
  };
  const sync = (themes: readonly IconThemeChoice[]) => {
    for (const theme of pending) if (!themes.includes(theme)) pending.delete(theme);
    for (const [theme, undo] of pages) {
      if (themes.includes(theme)) continue;
      undo();
      pages.delete(theme);
    }
    for (const theme of themes) {
      if (theme.settingsPage && !pages.has(theme) && !pending.has(theme)) void add(theme, theme.settingsPage);
    }
  };
  sync(useContributedIconThemes.getState().themes);
  const unsubscribe = useContributedIconThemes.subscribe((s) => sync(s.themes));
  return () => {
    unsubscribe();
    pending.clear();
    pages.forEach((undo) => undo());
    pages.clear();
  };
}
