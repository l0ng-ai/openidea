// Pages import the catalog (`/snippets/plugin-catalog.jsx`) and pass it in. Mintlify takes each imported
// export on its own, so every component here is self-contained: no imports, no shared top-level helpers.

export const Marketplace = ({ catalog: pluginCatalog, lang = "en" }) => {
  const TEXT = {
    en: {
      eyebrow: "Plugin Marketplace",
      title: "Make OpenIDEA yours.",
      lead: "Languages, frameworks, linters, themes and tools, signed by their publishers and installed in one click from",
      path: "Settings › Plugins › Marketplace",
      leadEnd: ".",
      plugins: "plugins",
      publishers: "publishers",
      downloads: "downloads",
      downloadsLabel: "Downloads",
      listSep: ", ",
      search: "Search plugins",
      sort: "Sort",
      popular: "Popular",
      az: "A–Z",
      category: "Category",
      official: "Official",
      empty: (q) => `No plugins match “${q}”.`,
      buildEyebrow: "Build a plugin",
      buildTitle: "Ship your plugin to every OpenIDEA user.",
      buildLead:
        "Plugins are sandboxed WebAssembly components with a typed API. Themes, icon themes and languages need no code at all. Scaffold one in a minute, then list it through the community registry.",
      quickstart: "Plugin quickstart",
      publish: "Publish to the marketplace",
      term1: "# attach the .oiplugin to a release, then open a",
      term2: "# pull request in l0ng-ai/openidea-plugins",
      note: (d) =>
        `Snapshot of the marketplace index from ${d}. The IDE always shows the current list. Community plugins are built and signed by their authors.`,
      close: "Close",
      version: "Version",
      categoriesLabel: "Categories",
      pluginId: "Plugin id",
      install: (name) => (
        <>
          <b>Install</b> In OpenIDEA, open <b>Settings › Plugins › Marketplace</b>, search for “{name}” and click{" "}
          <b>Install</b>.
        </>
      ),
      source: "Source and docs",
      categories: {
        all: "All",
        frameworks: "Frameworks",
        languages: "Languages",
        tools: "Tools",
        linters: "Linters",
        vcs: "Version control",
        ai: "AI",
        themes: "Themes",
        "icon-themes": "Icon themes",
        other: "Other",
      },
    },
    zh: {
      eyebrow: "插件市场",
      title: "让 OpenIDEA 成为你的 IDE。",
      lead: "语言、框架、代码检查、主题和工具，均由发布者签名，在",
      path: "设置 › 插件 › 插件市场",
      leadEnd: "中一键安装。",
      plugins: "个插件",
      publishers: "位发布者",
      downloads: "次下载",
      downloadsLabel: "下载量",
      listSep: "、",
      search: "搜索插件",
      sort: "排序",
      popular: "最热门",
      az: "按名称",
      category: "分类",
      official: "官方",
      empty: (q) => `没有与“${q}”匹配的插件。`,
      buildEyebrow: "开发插件",
      buildTitle: "把你的插件交到每一位 OpenIDEA 用户手中。",
      buildLead:
        "插件是运行在沙箱中的 WebAssembly 组件，API 有完整类型。主题、图标主题和语言完全不用写代码。一分钟搭好脚手架，再通过社区登记仓库上架。",
      quickstart: "插件快速开始",
      publish: "发布到插件市场",
      term1: "# 把 .oiplugin 附加到 release，然后向",
      term2: "# l0ng-ai/openidea-plugins 提交 pull request",
      note: (d) => `插件市场索引快照，生成于 ${d}。IDE 中显示的始终是最新列表。社区插件由作者自行构建和签名。`,
      close: "关闭",
      version: "版本",
      categoriesLabel: "分类",
      pluginId: "插件 id",
      install: (name) => (
        <>
          <b>安装</b> 在 OpenIDEA 中打开 <b>设置 › 插件 › 插件市场</b>，搜索“
          {name}”，点击 <b>安装</b>。
        </>
      ),
      source: "源码与文档",
      categories: {
        all: "全部",
        frameworks: "框架",
        languages: "语言",
        tools: "工具",
        linters: "代码检查",
        vcs: "版本控制",
        ai: "AI",
        themes: "主题",
        "icon-themes": "图标主题",
        other: "其他",
      },
    },
  };

  const CATEGORY_IDS = [
    "all",
    "frameworks",
    "languages",
    "tools",
    "linters",
    "vcs",
    "ai",
    "themes",
    "icon-themes",
    "other",
  ];

  const formatCount = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : `${n}`);

  // Called as a function: snippet components cannot use each other as JSX tags.

  const pluginIcon = (plugin, size) =>
    plugin.icon ? (
      <span className="oi-mk-icon" style={{ width: size, height: size }}>
        <img className="oi-mk-icon-light" src={plugin.icon.light} alt="" />
        <img className="oi-mk-icon-dark" src={plugin.icon.dark || plugin.icon.light} alt="" />
      </span>
    ) : (
      <span className="oi-mk-icon oi-mk-icon-fallback" style={{ width: size, height: size }}>
        {plugin.name
          .replace(/^[^A-Za-z0-9]+/, "")
          .slice(0, 1)
          .toUpperCase()}
      </span>
    );

  const t = TEXT[lang] || TEXT.en;
  const categoryLabel = (id) => t.categories[id] || id;
  const all = pluginCatalog.plugins;
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [sort, setSort] = useState("popular");
  const [open, setOpen] = useState(null);

  const counts = {};
  for (const p of all) for (const c of p.categories) counts[c] = (counts[c] || 0) + 1;
  const totalDownloads = all.reduce((s, p) => s + p.downloads, 0);

  const q = query.trim().toLowerCase();
  const shown = all
    .filter((p) => category === "all" || p.categories.includes(category))
    .filter(
      (p) =>
        !q ||
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.publisher.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q),
    )
    .slice()
    .sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : b.downloads - a.downloads));

  const current = open && all.find((p) => p.id === open);

  useEffect(() => {
    if (!current) return;
    const onKey = (e) => e.key === "Escape" && setOpen(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current]);

  return (
    <div className="oi-home oi-mk">
      <section className="oi-mk-hero">
        <div className="oi-hero-glow" aria-hidden="true" />
        <div className="oi-grid-bg" aria-hidden="true" />
        <div className="oi-wrap">
          <div className="oi-eyebrow">{t.eyebrow}</div>
          <h1 className="oi-mk-title">{t.title}</h1>
          <p className="oi-sub">
            {t.lead} <b>{t.path}</b>
            {t.leadEnd}
          </p>
          <div className="oi-mk-metrics">
            <div>
              <strong>{all.length}</strong>
              <span>{t.plugins}</span>
            </div>
            <div>
              <strong>{pluginCatalog.publishers}</strong>
              <span>{t.publishers}</span>
            </div>
            <div>
              <strong>{formatCount(totalDownloads)}</strong>
              <span>{t.downloads}</span>
            </div>
          </div>
        </div>
      </section>

      <div className="oi-wrap">
        <div className="oi-mk-toolbar">
          <label className="oi-mk-search">
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
              <circle cx="7" cy="7" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <input
              type="search"
              placeholder={t.search}
              aria-label={t.search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="oi-mk-sort" role="group" aria-label={t.sort}>
            <button type="button" className={sort === "popular" ? "is-on" : ""} onClick={() => setSort("popular")}>
              {t.popular}
            </button>
            <button type="button" className={sort === "name" ? "is-on" : ""} onClick={() => setSort("name")}>
              {t.az}
            </button>
          </div>
        </div>

        <div className="oi-mk-chips" role="group" aria-label={t.category}>
          {CATEGORY_IDS.filter((id) => id === "all" || counts[id]).map((id) => (
            <button type="button" key={id} className={category === id ? "is-on" : ""} onClick={() => setCategory(id)}>
              {categoryLabel(id)}
              <em>{id === "all" ? all.length : counts[id]}</em>
            </button>
          ))}
        </div>

        <div className="oi-mk-grid">
          {shown.map((p) => (
            <button type="button" key={p.id} className="oi-mk-card" onClick={() => setOpen(p.id)}>
              <div className="oi-mk-card-head">
                {pluginIcon(p, 44)}
                <div className="oi-mk-card-title">
                  <h3>{p.name}</h3>
                  <span>
                    {p.publisher}
                    {p.official && <b className="oi-mk-badge">{t.official}</b>}
                  </span>
                </div>
              </div>
              <p>{p.description}</p>
              <div className="oi-mk-card-foot">
                <span className="oi-mk-tag">{categoryLabel(p.categories[0])}</span>
                {p.downloads > 0 && (
                  <span className="oi-mk-dl">
                    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                      <path
                        d="M8 2v8m0 0 3-3m-3 3L5 7M3 13h10"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    {formatCount(p.downloads)}
                  </span>
                )}
                <span className="oi-mk-ver">v{p.version}</span>
              </div>
            </button>
          ))}
        </div>
        {shown.length === 0 && <p className="oi-mk-empty">{t.empty(query)}</p>}

        <section className="oi-mk-build">
          <div>
            <div className="oi-eyebrow">{t.buildEyebrow}</div>
            <h2 className="oi-h2">{t.buildTitle}</h2>
            <p className="oi-sub">{t.buildLead}</p>
            <div className="oi-mk-build-actions">
              <a className="oi-btn oi-btn-primary" href={`/${lang}/plugins/quickstart`}>
                {t.quickstart}
              </a>
              <a className="oi-btn oi-btn-ghost" href={`/${lang}/plugins/publishing/marketplace`}>
                {t.publish}
              </a>
            </div>
          </div>
          <div className="oi-mk-term" aria-hidden="true">
            <div className="oi-mk-term-bar">
              <span />
              <span />
              <span />
            </div>
            <div className="oi-mk-term-body">
              <div>
                <b>$</b> openidea-plugin new hello --id acme.hello
              </div>
              <div>
                <b>$</b> cd hello && cargo test
              </div>
              <div>
                <b>$</b> openidea-plugin build
              </div>
              <div>
                <b>$</b> openidea-plugin pack . --key acme.key --publisher acme
              </div>
              <div className="dim">{t.term1}</div>
              <div className="dim">{t.term2}</div>
            </div>
          </div>
        </section>

        <p className="oi-mk-note">{t.note(pluginCatalog.generatedAt)}</p>
      </div>

      {current && (
        <div className="oi-mk-overlay" onClick={() => setOpen(null)}>
          <div
            className="oi-mk-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={current.name}
            onClick={(e) => e.stopPropagation()}
          >
            <button type="button" className="oi-mk-close" aria-label={t.close} onClick={() => setOpen(null)}>
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
            <div className="oi-mk-card-head">
              {pluginIcon(current, 64)}
              <div className="oi-mk-card-title">
                <h3>{current.name}</h3>
                <span>
                  {current.publisher}
                  {current.official && <b className="oi-mk-badge">{t.official}</b>}
                </span>
              </div>
            </div>
            <p className="oi-mk-dialog-desc">{current.description}</p>
            <dl className="oi-mk-facts">
              <div>
                <dt>{t.version}</dt>
                <dd>{current.version}</dd>
              </div>
              <div>
                <dt>{t.downloadsLabel}</dt>
                <dd>{current.downloads ? current.downloads.toLocaleString(lang === "zh" ? "zh-CN" : "en-US") : "—"}</dd>
              </div>
              <div>
                <dt>{t.categoriesLabel}</dt>
                <dd>{current.categories.map(categoryLabel).join(t.listSep)}</dd>
              </div>
              <div>
                <dt>{t.pluginId}</dt>
                <dd>
                  <code>{current.id}</code>
                </dd>
              </div>
            </dl>
            <div className="oi-mk-install">{t.install(current.name)}</div>
            {current.homepage && (
              <a className="oi-btn oi-btn-ghost oi-mk-home" href={current.homepage} target="_blank" rel="noreferrer">
                {t.source} ↗
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export const FeaturedPlugins = ({ catalog: pluginCatalog, href }) => {
  const pluginIcon = (plugin, size) =>
    plugin.icon ? (
      <span className="oi-mk-icon" style={{ width: size, height: size }}>
        <img className="oi-mk-icon-light" src={plugin.icon.light} alt="" />
        <img className="oi-mk-icon-dark" src={plugin.icon.dark || plugin.icon.light} alt="" />
      </span>
    ) : (
      <span className="oi-mk-icon oi-mk-icon-fallback" style={{ width: size, height: size }}>
        {plugin.name
          .replace(/^[^A-Za-z0-9]+/, "")
          .slice(0, 1)
          .toUpperCase()}
      </span>
    );

  return (
    <div className="oi-plug-grid">
      {pluginCatalog.plugins
        .filter((p) => p.icon)
        .slice(0, 12)
        .map((p) => (
          <a key={p.id} className="oi-plug" href={href}>
            {pluginIcon(p, 36)}
            <span className="oi-plug-text">
              <b>{p.name}</b>
              <em>{p.publisher}</em>
            </span>
          </a>
        ))}
    </div>
  );
};
