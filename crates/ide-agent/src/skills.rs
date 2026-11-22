//! Slash commands and skills on disk. Claude Code's own discovery (`.claude/skills` and
//! `.claude/commands` of the working directory tree and `~/.claude`, and a Hermes profile's
//! `skills`) for completion before (or without) a session, plus the multi-level skills hub
//! of #3897: every CLI's skill folders discovered once, deduplicated by canonical path,
//! resolved against the `[agents.skills.<name>]` policies of the global and workspace
//! settings, and staged into a per-session folder the CLIs each receive their own way.

use crate::{
    AgentCommand, AgentCommandSource, AgentSkill, AgentSkillMode, AgentSkillOrigin, AgentSkillPolicy, AgentSkillSource,
    AgentSkillState,
};
use ide_core::output_encoding::strip_ansi;
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

const MAX_DESCRIPTION: usize = 200;
/// Command directories nest this deep at most (`a/b/c.md` → `a:b:c`).
const MAX_DEPTH: usize = 4;

/// The commands Claude Code finds from `cwd`: nearest directory first, the user's last;
/// the first of a name wins.
pub(crate) fn discover(cwd: &Path, home: Option<&Path>) -> Vec<AgentCommand> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut add = |found: Vec<AgentCommand>| {
        for c in found {
            if seen.insert(c.name.clone()) {
                out.push(c);
            }
        }
    };
    for dir in cwd.ancestors() {
        if home.is_some_and(|h| h == dir) {
            break;
        }
        add(in_dir(&dir.join(".claude")));
    }
    if let Some(home) = home {
        add(in_dir(&home.join(".claude")));
    }
    out
}

/// The skills of a Hermes profile: `<profile>/skills/<skill>` and `<profile>/skills/<category>/<skill>`;
/// the first of a name wins.
pub(crate) fn hermes(profile: &Path) -> Vec<AgentCommand> {
    let root = profile.join("skills");
    let mut found = skills(&root);
    for category in sorted(&root).into_iter().filter(|p| !p.join("SKILL.md").exists()) {
        found.extend(skills(&category));
    }
    let mut seen = HashSet::new();
    found.retain(|c| seen.insert(c.name.clone()));
    found
}

/// `first` (the agent's own list) plus the commands of `more` it lacks.
pub(crate) fn merge(first: Vec<AgentCommand>, more: Vec<AgentCommand>) -> Vec<AgentCommand> {
    let mut out = first;
    for c in more {
        if let Some(offered) = out.iter_mut().find(|offered| offered.name == c.name) {
            offered.source = c.source;
        } else {
            out.push(c);
        }
    }
    out
}

fn in_dir(claude: &Path) -> Vec<AgentCommand> {
    if !claude.is_dir() {
        return Vec::new();
    }
    let mut out = skills(&claude.join("skills"));
    commands(&claude.join("commands"), "", 0, &mut out);
    out
}

fn skills(dir: &Path) -> Vec<AgentCommand> {
    let mut out: Vec<AgentCommand> = sorted(dir)
        .into_iter()
        .filter_map(|path| {
            let text = std::fs::read_to_string(path.join("SKILL.md")).ok()?;
            let meta = Frontmatter::parse(&text);
            if meta.get("user-invocable").is_some_and(|v| v.eq_ignore_ascii_case("false")) {
                return None;
            }
            let name = meta.get("name").filter(|n| !n.is_empty()).map(str::to_owned).or_else(|| file_name(&path))?;
            Some(meta.command(name, &text, AgentCommandSource::Skill))
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn commands(dir: &Path, prefix: &str, depth: usize, out: &mut Vec<AgentCommand>) {
    if depth > MAX_DEPTH {
        return;
    }
    for path in sorted(dir) {
        let Some(name) = file_name(&path) else { continue };
        if path.is_dir() {
            commands(&path, &format!("{prefix}{name}:"), depth + 1, out);
        } else if let Some(stem) = name.strip_suffix(".md")
            && let Ok(text) = std::fs::read_to_string(&path)
        {
            out.push(Frontmatter::parse(&text).command(format!("{prefix}{stem}"), &text, AgentCommandSource::Command));
        }
    }
}

fn sorted(dir: &Path) -> Vec<std::path::PathBuf> {
    let mut paths: Vec<_> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| file_name(p).is_some_and(|n| !n.starts_with('.')))
        .collect();
    paths.sort();
    paths
}

fn file_name(path: &Path) -> Option<String> {
    path.file_name()?.to_str().map(str::to_owned)
}

/// The `key: value` lines between the leading `---` fences (folded `>` / `|` values joined).
struct Frontmatter {
    fields: Vec<(String, String)>,
    /// Where the body starts.
    body: usize,
}

impl Frontmatter {
    fn parse(text: &str) -> Self {
        let text = text.strip_prefix('\u{feff}').unwrap_or(text);
        let mut lines = text.split_inclusive('\n');
        let mut offset = 0;
        let mut fields: Vec<(String, String)> = Vec::new();
        match lines.next() {
            Some(first) if first.trim_end() == "---" => offset += first.len(),
            _ => return Self { fields, body: 0 },
        }
        for line in lines {
            offset += line.len();
            let line = line.trim_end();
            if line == "---" {
                return Self { fields, body: offset };
            }
            if line.starts_with([' ', '\t']) {
                if let Some((_, value)) = fields.last_mut() {
                    if !value.is_empty() {
                        value.push(' ');
                    }
                    value.push_str(line.trim());
                }
                continue;
            }
            if let Some((key, value)) = line.split_once(':') {
                let value = value.trim();
                let value = if matches!(value, ">" | "|" | ">-" | "|-") { "" } else { unquote(value) };
                fields.push((key.trim().to_owned(), value.to_owned()));
            }
        }
        // No closing fence: not frontmatter.
        Self { fields: Vec::new(), body: 0 }
    }

    fn get(&self, key: &str) -> Option<&str> {
        self.fields.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    /// `description`, else the body's first line.
    fn command(&self, name: String, text: &str, source: AgentCommandSource) -> AgentCommand {
        let description = self.get("description").filter(|d| !d.is_empty()).map(str::to_owned).unwrap_or_else(|| {
            let body = text.get(self.body..).unwrap_or_default();
            body.lines()
                .map(|l| l.trim().trim_start_matches('#').trim())
                .find(|l| !l.is_empty())
                .unwrap_or_default()
                .to_owned()
        });
        AgentCommand {
            name,
            source,
            description: truncate(&description),
            hint: self.get("argument-hint").filter(|h| !h.is_empty()).map(str::to_owned),
        }
    }
}

fn unquote(value: &str) -> &str {
    for q in ['"', '\''] {
        if let Some(inner) = value.strip_prefix(q).and_then(|v| v.strip_suffix(q)) {
            return inner;
        }
    }
    value
}

fn truncate(s: &str) -> String {
    match s.char_indices().nth(MAX_DESCRIPTION) {
        Some((i, _)) => format!("{}…", s[..i].trim_end()),
        None => s.to_owned(),
    }
}

// ─── The skills hub (#3897): discovery, policy, delivery ────────────────────────────

/// A skill's `name` must be this and lowercase letters, digits and hyphens only.
fn valid_name(name: &str) -> bool {
    (1..=64).contains(&name.len()) && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// A `SKILL.md`'s description is at most this many characters.
const MAX_SKILL_DESCRIPTION: usize = 1024;

/// The workspace folders skills are discovered in, by the source they report.
const WORKSPACE_ROOTS: &[(&str, AgentSkillSource)] = &[
    (".agents/skills", AgentSkillSource::Workspace),
    (".openidea/skills", AgentSkillSource::Workspace),
    (".claude/skills", AgentSkillSource::ClaudeWorkspace),
    (".github/skills", AgentSkillSource::GithubWorkspace),
    (".codex/skills", AgentSkillSource::CodexWorkspace),
    (".cursor/skills", AgentSkillSource::CursorWorkspace),
];

/// The home folders skills are discovered in, by the source they report.
const HOME_ROOTS: &[(&str, AgentSkillSource)] = &[
    (".agents/skills", AgentSkillSource::User),
    (".claude/skills", AgentSkillSource::ClaudeUser),
    (".copilot/skills", AgentSkillSource::CopilotUser),
    (".codex/skills", AgentSkillSource::CodexUser),
    (".cursor/skills", AgentSkillSource::CursorUser),
];

/// Every skill found under `workspace` (a project, scanned even for a worktree task, whose
/// checkout lacks untracked skills) and `home`, in source precedence order, symlinked
/// duplicates collapsed by canonical path: the first of a path wins, and so does the first
/// of a name (the higher source), so a session never sees one skill twice.
pub fn discover_skills(workspace: &Path, home: Option<&Path>) -> Vec<AgentSkill> {
    discover_skills_in(&[workspace.to_path_buf()], home)
}

/// Every skill found across `workspaces` (a project and any workspace/monorepo member
/// folders) and `home`, in source precedence order, symlinked duplicates collapsed by
/// canonical path while recording secondary sources in [`AgentSkill::also_in`].
pub fn discover_skills_in(workspaces: &[PathBuf], home: Option<&Path>) -> Vec<AgentSkill> {
    let mut out: Vec<AgentSkill> = Vec::new();
    let mut seen_paths: HashSet<PathBuf> = HashSet::new();
    let mut seen_names: HashSet<String> = HashSet::new();
    let mut roots: Vec<(PathBuf, AgentSkillSource)> = Vec::new();
    let mut seen_workspaces: HashSet<PathBuf> = HashSet::new();
    let mut all_workspaces: Vec<PathBuf> = Vec::new();
    for ws in workspaces {
        let canon = dunce::canonicalize(ws).unwrap_or_else(|_| ws.clone());
        if seen_workspaces.insert(canon) {
            all_workspaces.push(ws.clone());
        }
    }
    for ws in &all_workspaces {
        roots.extend(WORKSPACE_ROOTS.iter().map(|(rel, source)| (ws.join(rel), *source)));
    }
    // Nested monorepo packages (up to two levels below each workspace root, e.g. `apps/web`).
    for ws in &all_workspaces {
        for sub in monorepo_subdirs(ws, 2) {
            let sub_canon = dunce::canonicalize(&sub).unwrap_or_else(|_| sub.clone());
            if seen_workspaces.insert(sub_canon) {
                roots.extend(WORKSPACE_ROOTS.iter().map(|(rel, source)| (sub.join(rel), *source)));
            }
        }
    }
    if let Some(home) = home {
        roots.extend(HOME_ROOTS.iter().map(|(rel, source)| (home.join(rel), *source)));
        roots.extend(copilot_installed_plugin_roots(&home.join(".copilot")));
    }
    for (root, source) in roots {
        for skill in skills_of(&root, source) {
            let path = dunce::canonicalize(&skill.path.0).unwrap_or_else(|_| skill.path.0.clone());
            if !seen_paths.insert(path.clone()) {
                if let Some(existing) = out.iter_mut().find(|s| s.path.0 == path)
                    && existing.source != source
                    && !existing.also_in.contains(&source)
                {
                    existing.also_in.push(source);
                }
                continue;
            }
            if !seen_names.insert(skill.name.to_ascii_lowercase()) {
                continue;
            }
            out.push(AgentSkill { path: path.into(), ..skill });
        }
    }
    out
}

const SKIP_MONOREPO_DIRS: &[&str] =
    &["node_modules", "target", "dist", "build", "out", "vendor", "coverage", ".git", ".openidea", ".idea"];

fn monorepo_subdirs(root: &Path, max_depth: usize) -> Vec<PathBuf> {
    if max_depth == 0 {
        return Vec::new();
    }
    let mut out = Vec::new();
    for dir in sorted(root) {
        let Some(name) = file_name(&dir) else { continue };
        if SKIP_MONOREPO_DIRS.contains(&name.as_str()) {
            continue;
        }
        let Ok(meta) = std::fs::symlink_metadata(&dir) else { continue };
        if !meta.file_type().is_dir() {
            continue;
        }
        if WORKSPACE_ROOTS.iter().any(|(rel, _)| dir.join(rel).is_dir()) {
            out.push(dir.clone());
        }
        if max_depth > 1 {
            out.extend(monorepo_subdirs(&dir, max_depth - 1));
        }
    }
    out
}

/// Discovers skill roots inside `~/.copilot/installed-plugins`, supporting both Copilot CLI's
/// 2-level `<marketplace-or-_direct>/<plugin>` layout (and `config.json` `installedPlugins`
/// enablement) and flat 1-level `<plugin>` folders.
fn copilot_installed_plugin_roots(copilot_dir: &Path) -> Vec<(PathBuf, AgentSkillSource)> {
    let mut disabled_paths: HashSet<PathBuf> = HashSet::new();
    let mut plugin_dirs: Vec<PathBuf> = Vec::new();
    let mut seen_dirs: HashSet<PathBuf> = HashSet::new();
    let mut push_plugin = |dir: PathBuf, disabled: &HashSet<PathBuf>| {
        if !dir.is_dir() {
            return;
        }
        let canon = dunce::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
        if disabled.contains(&canon) || !seen_dirs.insert(canon) {
            return;
        }
        plugin_dirs.push(dir);
    };

    if let Ok(text) = std::fs::read_to_string(copilot_dir.join("config.json"))
        && let Ok(root) = serde_json::from_str::<serde_json::Value>(&crate::mcp::strip_jsonc(&text))
        && let Some(installed) = root.get("installedPlugins").and_then(serde_json::Value::as_array)
    {
        for entry in installed {
            let Some(raw_cache) = entry.get("cache_path").and_then(serde_json::Value::as_str).map(str::trim) else {
                continue;
            };
            if raw_cache.is_empty() {
                continue;
            }
            let dir =
                if Path::new(raw_cache).is_relative() { copilot_dir.join(raw_cache) } else { PathBuf::from(raw_cache) };
            if entry.get("enabled").and_then(serde_json::Value::as_bool) == Some(false) {
                disabled_paths.insert(dunce::canonicalize(&dir).unwrap_or(dir));
            } else {
                push_plugin(dir, &disabled_paths);
            }
        }
    }

    let plugins_root = copilot_dir.join("installed-plugins");
    for entry in sorted(&plugins_root) {
        if !entry.is_dir() {
            continue;
        }
        if looks_like_plugin_dir(&entry) {
            push_plugin(entry, &disabled_paths);
        } else {
            // 2-level `<marketplace>/<plugin>` or `_direct/<plugin>`.
            for sub in sorted(&entry) {
                if sub.is_dir() {
                    push_plugin(sub, &disabled_paths);
                }
            }
        }
    }

    let mut roots = Vec::new();
    for plugin in plugin_dirs {
        let skills_sub = plugin.join("skills");
        if skills_sub.is_dir() {
            roots.push((skills_sub, AgentSkillSource::CopilotUser));
        } else {
            roots.push((plugin, AgentSkillSource::CopilotUser));
        }
    }
    roots
}

fn looks_like_plugin_dir(dir: &Path) -> bool {
    dir.join("skills").is_dir()
        || dir.join("plugin.json").is_file()
        || dir.join(".plugin").is_dir()
        || dir.join(".claude-plugin").is_dir()
        || dir.join(".cursor-plugin").is_dir()
        || dir.join("SKILL.md").is_file()
}

/// The skills of one root: `<name>/SKILL.md` folders and `<category>/<name>/SKILL.md`
/// category folders, validated.
fn skills_of(root: &Path, source: AgentSkillSource) -> Vec<AgentSkill> {
    let mut out: Vec<AgentSkill> = Vec::new();
    // Warn when a user drops `SKILL.md` directly inside a `skills/` root instead of `<name>/SKILL.md`.
    if file_name(root).as_deref() == Some("skills")
        && let Ok(text) = std::fs::read_to_string(root.join("SKILL.md"))
    {
        let mut misplaced = parse_skill_file(root, "skills", &text, source);
        misplaced.valid = false;
        misplaced
            .warnings
            .insert(0, "SKILL.md is directly inside `skills/`: move it into a `<name>/SKILL.md` subfolder".into());
        out.push(misplaced);
    }
    for dir in sorted(root) {
        let Some(folder) = file_name(&dir) else { continue };
        if !dir.is_dir() {
            continue;
        }
        if let Ok(text) = std::fs::read_to_string(dir.join("SKILL.md")) {
            out.push(parse_skill_file(&dir, &folder, &text, source));
            continue;
        }
        // Category folder (`<root>/<category>/<skill>/SKILL.md`): only entered when `<dir>` itself
        // has no `SKILL.md`, so a skill's own subdirectories remain resources rather than skills.
        for sub in sorted(&dir) {
            let Some(sub_folder) = file_name(&sub) else { continue };
            if !sub.is_dir() {
                continue;
            }
            if let Ok(text) = std::fs::read_to_string(sub.join("SKILL.md")) {
                out.push(parse_skill_file(&sub, &sub_folder, &text, source));
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn parse_skill_file(dir: &Path, folder: &str, text: &str, source: AgentSkillSource) -> AgentSkill {
    let meta = Frontmatter::parse(text);
    let name = meta
        .get("name")
        .map(|n| strip_ansi(n).trim().to_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| folder.to_owned());
    let mut warnings = Vec::new();
    if !valid_name(&name) {
        warnings.push(format!("`name: {name}` is not 1-64 lowercase letters, digits or hyphens"));
    }
    if name != folder {
        warnings.push(format!("`name: {name}` does not match the folder `{folder}`"));
    }
    let description = meta.get("description").unwrap_or_default();
    let description = strip_ansi(description).trim().to_owned();
    if description.is_empty() {
        warnings.push("no `description`: the model never sees when to use it".into());
    } else if description.chars().count() > MAX_SKILL_DESCRIPTION {
        warnings.push(format!("`description` is over {MAX_SKILL_DESCRIPTION} characters"));
    }
    let hint = meta.get("argument-hint").map(|h| strip_ansi(h).trim().to_owned()).filter(|h| !h.is_empty());
    let user_invocable = !meta.get("user-invocable").is_some_and(|v| v.eq_ignore_ascii_case("false"));
    let disable_model_invocation = meta.get("disable-model-invocation").is_some_and(|v| v.eq_ignore_ascii_case("true"));
    AgentSkill {
        name,
        description: truncate(&description),
        hint,
        path: dir.to_path_buf().into(),
        source,
        also_in: Vec::new(),
        user_invocable,
        disable_model_invocation,
        valid: warnings.is_empty(),
        warnings,
    }
}

/// A skill's mode, as one policy layer of the settings has it.
type Policies = BTreeMap<String, AgentSkillPolicy>;

fn lookup_mode(map: &BTreeMap<String, AgentSkillMode>, name: &str) -> Option<AgentSkillMode> {
    map.get(name).copied().or_else(|| map.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| *v))
}

fn lookup_policy<'a>(map: &'a Policies, name: &str) -> Option<&'a AgentSkillPolicy> {
    map.get(name).or_else(|| map.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v))
}

/// Resolves every skill's mode: a session override, then the workspace's and the user's
/// `[agents.skills.<name>]` policy, then the frontmatter default (`slashOnly` when
/// `disable-model-invocation: true`, else `auto`) — with an untrusted workspace able to
/// turn skills off only: its own skills stay off (whatever the session chose), and its
/// policies hold only when they turn a skill off.
pub fn resolve(
    skills: Vec<AgentSkill>,
    session: Option<&BTreeMap<String, AgentSkillMode>>,
    workspace: &Policies,
    user: &Policies,
    workspace_trusted: bool,
) -> Vec<AgentSkillState> {
    let mut out = Vec::new();
    for skill in skills {
        let workspace_skill = matches!(
            skill.source,
            AgentSkillSource::Workspace
                | AgentSkillSource::ClaudeWorkspace
                | AgentSkillSource::GithubWorkspace
                | AgentSkillSource::CodexWorkspace
                | AgentSkillSource::CursorWorkspace
        );
        let default_mode =
            if skill.disable_model_invocation { AgentSkillMode::SlashOnly } else { AgentSkillMode::Auto };
        let (mode, origin) = if workspace_skill && !workspace_trusted {
            // Workspace trust gates the workspace's own skills, whatever else says.
            (AgentSkillMode::Off, AgentSkillOrigin::Trust)
        } else if let Some(chosen) = session.and_then(|s| lookup_mode(s, &skill.name)) {
            (chosen, AgentSkillOrigin::Session)
        } else if let Some(policy) =
            lookup_policy(workspace, &skill.name).filter(|p| workspace_trusted || p.mode == AgentSkillMode::Off)
        {
            (policy.mode, AgentSkillOrigin::Workspace)
        } else if let Some(policy) = lookup_policy(user, &skill.name) {
            (policy.mode, AgentSkillOrigin::User)
        } else {
            (default_mode, AgentSkillOrigin::None)
        };
        out.push(AgentSkillState { skill, mode, origin });
    }
    out
}

/// What one CLI session receives for its active skills. Sent to the shims in
/// `session/new`'s `_meta.openidea.skills`, so each driver applies its own fields.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Delivery {
    /// Claude Code: the farm passed as `--add-dir` (its `.claude/skills` holds the staged copies).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_add_dir: Option<PathBuf>,
    /// Claude Code: the `--settings` JSON with `skillOverrides` (the native skills too).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_settings: Option<String>,
    /// Copilot: `skillDirectories` (the farm's `copilot` tree).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub copilot_skill_directories: Vec<String>,
    /// Copilot: `disabledSkills`, spelled as the skills are.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub copilot_disabled_skills: Vec<String>,
    /// Codex: `skills/extraRoots/set` roots (the farm's `codex` tree).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub codex_extra_roots: Vec<String>,
    /// Codex: `skills.config` entries turning skills off by path.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub codex_off: Vec<(String, String)>,
}

/// Stages the skills a session of `provider` runs with into `farm` — linking (copying on
/// Windows, where directory symlinks need Developer Mode) every active skill folder into
/// the CLI's tree — and reports what to hand the CLI. Skills the CLI discovers natively
/// (its own folders of the working directory and the home) are not staged again: it already
/// sees them, and seeing both would list one skill twice. Skills `off` are never staged;
/// the CLI's native disable (where it has one) receives their names or paths. An ACP
/// agent gets nothing here: its `/` menu is filtered instead.
pub fn stage(
    farm: &Path,
    provider: &str,
    states: &[AgentSkillState],
    cwd: &Path,
    home: Option<&Path>,
) -> std::io::Result<Delivery> {
    let mut out = Delivery::default();
    let cwd = dunce::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    // Only the native drivers take the farm, each its own tree; `provider` is their key
    // (`claude`, `copilot`, `codex`), anything else (an ACP agent) gets the `/` menu filter.
    let (claude_tree, copilot_tree, codex_tree) = match provider {
        "claude" => (Some(farm.join(".claude/skills")), None, None),
        "copilot" => (None, Some(farm.join("copilot")), None),
        "codex" => (None, None, Some(farm.join("codex"))),
        _ => return Ok(out),
    };
    // Restage from scratch: a skill turned off or deleted since the last session must not
    // linger in the tree. Removing a tree removes its links, never the skills they point at.
    for tree in [&claude_tree, &copilot_tree, &codex_tree].into_iter().flatten() {
        match std::fs::remove_dir_all(tree) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
    }
    for state in states {
        let name = state.skill.name.as_str();
        let path = state.skill.path.0.as_path();
        if file_name(path).as_deref() == Some("skills") && !state.skill.valid {
            continue;
        }
        match state.mode {
            AgentSkillMode::Off => {
                out.codex_off.push((name.to_owned(), codex_skill_md_path(path)));
            }
            // Claude Code runs a slash-only skill on `/name`, so it has to see the folder;
            // Copilot and Codex have no slash-only toggle and disable model auto-loading.
            AgentSkillMode::SlashOnly => {
                if state.skill.user_invocable
                    && let Some(tree) = claude_tree.as_ref().filter(|_| !native_claude(&state.skill, &cwd, home))
                {
                    link_skill(&tree.join(name), path)?;
                }
                if native_codex(&state.skill, &cwd, home) {
                    out.codex_off.push((name.to_owned(), codex_skill_md_path(path)));
                }
            }
            AgentSkillMode::Auto => {
                if let Some(tree) = claude_tree.as_ref().filter(|_| !native_claude(&state.skill, &cwd, home)) {
                    link_skill(&tree.join(name), path)?;
                }
                if let Some(tree) = copilot_tree.as_ref().filter(|_| !native_copilot(&state.skill, &cwd, home)) {
                    link_skill(&tree.join(name), path)?;
                }
                if let Some(tree) = codex_tree.as_ref().filter(|_| !native_codex(&state.skill, &cwd, home)) {
                    link_skill(&tree.join(name), path)?;
                }
            }
        }
    }
    if claude_tree.as_ref().is_some_and(|t| t.exists()) {
        out.claude_add_dir = Some(farm.to_path_buf());
    }
    if let Some(tree) = copilot_tree.as_ref().filter(|t| t.exists()) {
        out.copilot_skill_directories.push(tree.to_string_lossy().into_owned());
    }
    if let Some(tree) = codex_tree.as_ref().filter(|t| t.exists()) {
        out.codex_extra_roots.push(tree.to_string_lossy().into_owned());
    }
    // Claude Code's `skillOverrides` and Copilot's `disabledSkills` take the names of the
    // off and slash-only skills — the native copies included.
    let off: Vec<&str> = states
        .iter()
        .filter(|s| s.mode == AgentSkillMode::Off || (s.mode == AgentSkillMode::SlashOnly && !s.skill.user_invocable))
        .map(|s| s.skill.name.as_str())
        .collect();
    let slash: Vec<&str> = states
        .iter()
        .filter(|s| s.mode == AgentSkillMode::SlashOnly && s.skill.user_invocable)
        .map(|s| s.skill.name.as_str())
        .collect();
    if !off.is_empty() || !slash.is_empty() {
        let mut overrides = serde_json::Map::new();
        for (name, mode) in off.iter().map(|n| (*n, "off")).chain(slash.iter().map(|n| (*n, "user-invocable-only"))) {
            overrides.insert(name.to_owned(), serde_json::Value::String(mode.to_owned()));
        }
        out.claude_settings = Some(
            serde_json::to_string(&serde_json::json!({ "skillOverrides": overrides })).expect("settings serialize"),
        );
        out.copilot_disabled_skills = off.iter().chain(slash.iter()).map(|n| (*n).to_owned()).collect();
        out.copilot_disabled_skills.sort();
    }
    Ok(out)
}

/// Codex `[[skills.config]]` matches `path` against the canonical `SKILL.md` document path.
fn codex_skill_md_path(skill_dir: &Path) -> String {
    let md = skill_dir.join("SKILL.md");
    let md = dunce::canonicalize(&md)
        .or_else(|_| dunce::canonicalize(skill_dir).map(|dir| dir.join("SKILL.md")))
        .unwrap_or(md);
    // Skill roots are joined as `.agents/skills`; rebuilding from components gives Windows
    // one separator when the path could not be canonicalized.
    md.components().collect::<PathBuf>().to_string_lossy().into_owned()
}

fn direct_link_matches(root: &Path, name: &str, target: &Path) -> bool {
    let candidate = root.join(name);
    candidate == target || dunce::canonicalize(&candidate).ok().as_deref() == Some(target)
}

/// Claude Code sees this skill without the farm when `<dir>/.claude/skills/<name>` in `cwd`
/// (or `~/.claude/skills/<name>`) already resolves to `skill.path` — including when `.claude/skills/<name>`
/// is a symlink to `.agents/skills/<name>`. Category-nested skills are not direct children, so
/// they still get staged flat into the farm.
fn native_claude(skill: &AgentSkill, cwd: &Path, home: Option<&Path>) -> bool {
    let target = skill.path.0.as_path();
    let home_canon = home.map(|h| dunce::canonicalize(h).unwrap_or_else(|_| h.to_path_buf()));
    for ancestor in cwd.ancestors() {
        if home_canon.as_deref().is_some_and(|h| h == ancestor) {
            break;
        }
        if direct_link_matches(&ancestor.join(".claude/skills"), &skill.name, target) {
            return true;
        }
    }
    if let Some(h) = home_canon.as_deref()
        && direct_link_matches(&h.join(".claude/skills"), &skill.name, target)
    {
        return true;
    }
    match skill.source {
        AgentSkillSource::ClaudeWorkspace => target.parent() == Some(cwd.join(".claude/skills").as_path()),
        AgentSkillSource::ClaudeUser => {
            home_canon.as_deref().is_some_and(|h| target.parent() == Some(h.join(".claude/skills").as_path()))
        }
        _ => false,
    }
}

/// Copilot natively scans `.github/skills`, `.agents/skills` and `.claude/skills` in `cwd`,
/// plus `~/.copilot` and `~/.agents/skills` in `home`. `.openidea/skills` is NOT native.
fn native_copilot(skill: &AgentSkill, cwd: &Path, home: Option<&Path>) -> bool {
    let target = skill.path.0.as_path();
    for rel in [".github/skills", ".agents/skills", ".claude/skills"] {
        let root = cwd.join(rel);
        if is_under(target, &root) || direct_link_matches(&root, &skill.name, target) {
            return true;
        }
    }
    if let Some(h) = home {
        let h = dunce::canonicalize(h).unwrap_or_else(|_| h.to_path_buf());
        if is_under(target, &h.join(".copilot"))
            || is_under(target, &h.join(".agents/skills"))
            || direct_link_matches(&h.join(".copilot/skills"), &skill.name, target)
            || direct_link_matches(&h.join(".agents/skills"), &skill.name, target)
        {
            return true;
        }
    }
    false
}

/// Codex natively scans `.codex/skills` and `.agents/skills` in `cwd` and `home`.
fn native_codex(skill: &AgentSkill, cwd: &Path, home: Option<&Path>) -> bool {
    let target = skill.path.0.as_path();
    for rel in [".codex/skills", ".agents/skills"] {
        let root = cwd.join(rel);
        if is_under(target, &root) || direct_link_matches(&root, &skill.name, target) {
            return true;
        }
    }
    if let Some(h) = home {
        let h = dunce::canonicalize(h).unwrap_or_else(|_| h.to_path_buf());
        if is_under(target, &h.join(".codex/skills"))
            || is_under(target, &h.join(".agents/skills"))
            || direct_link_matches(&h.join(".codex/skills"), &skill.name, target)
            || direct_link_matches(&h.join(".agents/skills"), &skill.name, target)
        {
            return true;
        }
    }
    false
}

fn is_under(path: &Path, root: &Path) -> bool {
    path.starts_with(root)
}

/// Puts `name` into the farm tree: a directory symlink where they work, a copy otherwise
/// (Windows needs Developer Mode for directory symlinks).
fn link_skill(link: &Path, target: &Path) -> std::io::Result<()> {
    let _ = std::fs::remove_file(link);
    if let Some(parent) = link.parent() {
        std::fs::create_dir_all(parent)?;
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link)
    }
    #[cfg(windows)]
    {
        copy_dir_all(target, link)
    }
}

#[cfg(windows)]
fn copy_dir_all(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)?.flatten() {
        let path = entry.path();
        let dest = to.join(entry.file_name());
        if path.is_dir() {
            copy_dir_all(&path, &dest)?;
        } else {
            std::fs::copy(&path, &dest)?;
        }
    }
    Ok(())
}

/// Removes a task's farm (task deleted or archived); missing is fine.
pub fn remove_farm(store_dir: &Path, task: &str) {
    let farm = farm_dir(store_dir, task);
    match std::fs::remove_dir_all(&farm) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => tracing::warn!("removing the session skills folder {}: {e}", farm.display()),
    }
}

/// Where a task's staged skills live.
pub fn farm_dir(store_dir: &Path, task: &str) -> PathBuf {
    store_dir.join("session-skills").join(sanitized(task))
}

/// A task id is a uuid, but never trust it with a path segment.
fn sanitized(id: &str) -> String {
    id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect()
}

fn bare_skill_name(name: &str) -> String {
    name.trim_start_matches('$').to_ascii_lowercase()
}

/// The `/` menu's skills: active user-invocable skills as commands (the agent's own listing
/// wins on a name clash, including Codex's `$name` spelling). `Off` and `user-invocable: false`
/// skills are actively stripped from `offered` too, so previously cached or CLI-advertised
/// entries cannot leak back into OpenIDEA's `/` completion.
pub fn menu_commands(offered: Vec<AgentCommand>, states: &[AgentSkillState]) -> Vec<AgentCommand> {
    let blocked: HashSet<String> = states
        .iter()
        .filter(|s| s.mode == AgentSkillMode::Off || !s.skill.user_invocable)
        .map(|s| bare_skill_name(&s.skill.name))
        .collect();
    let mut out: Vec<AgentCommand> =
        offered.into_iter().filter(|c| !blocked.contains(&bare_skill_name(&c.name))).collect();
    for state in states {
        if state.mode == AgentSkillMode::Off
            || !state.skill.user_invocable
            || (file_name(&state.skill.path.0).as_deref() == Some("skills") && !state.skill.valid)
        {
            continue;
        }
        let target = bare_skill_name(&state.skill.name);
        if let Some(existing) = out.iter_mut().find(|c| bare_skill_name(&c.name) == target) {
            existing.source = AgentCommandSource::Skill;
            if existing.hint.is_none() {
                existing.hint = state.skill.hint.clone();
            }
            if existing.description.is_empty() {
                existing.description = state.skill.description.clone();
            }
        } else {
            out.push(AgentCommand {
                name: state.skill.name.clone(),
                description: state.skill.description.clone(),
                hint: state.skill.hint.clone(),
                source: AgentCommandSource::Skill,
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn names(cmds: &[AgentCommand]) -> Vec<&str> {
        cmds.iter().map(|c| c.name.as_str()).collect()
    }

    fn cmd(name: &str, description: &str) -> AgentCommand {
        AgentCommand {
            name: name.into(),
            description: description.into(),
            hint: None,
            source: AgentCommandSource::Command,
        }
    }

    #[test]
    fn project_and_user_skills_and_commands() {
        let tmp = tempfile::tempdir().unwrap();
        // Home is an ancestor of the project, so the walk stops there instead of climbing
        // past it into the real profile (a temp dir under the user's home holds its skills).
        let home = tmp.path().to_path_buf();
        let repo = tmp.path().join("work").join("idea");
        let skills = repo.join(".claude/skills");
        write(
            &skills.join("triage/SKILL.md"),
            "---\nname: triage\ndescription: One pass over open issues and PRs\n---\n# Triage\n",
        );
        write(&skills.join("issue-fix/SKILL.md"), "---\nname: issue-fix\ndescription: \"Fix an issue\"\n---\n");
        // No frontmatter name: the directory's.
        write(&skills.join("verify/SKILL.md"), "---\ndescription: >\n  Build and\n  drive the app\n---\n");
        write(&skills.join("hidden/SKILL.md"), "---\nname: hidden\nuser-invocable: false\n---\n");
        write(&skills.join("no-skill-file/README.md"), "nothing");
        write(&repo.join(".claude/commands/review.md"), "---\nargument-hint: <pr>\n---\nReview a pull request\n");
        write(&repo.join(".claude/commands/git/commit.md"), "# Commit the staged changes\n");
        // A parent directory's commands apply too.
        write(&tmp.path().join("work/.claude/commands/parent.md"), "---\ndescription: from above\n---\n");
        // The user's: shadowed by the project's skill of the same name.
        write(&home.join(".claude/skills/triage/SKILL.md"), "---\nname: triage\ndescription: user triage\n---\n");
        write(&home.join(".claude/skills/lint/SKILL.md"), "---\nname: lint\ndescription: user lint\n---\n");
        write(&home.join(".claude/commands/brooks-review.md"), "---\ndescription: Review\n---\n");

        let found = discover(&repo, Some(&home));
        assert_eq!(
            names(&found),
            ["issue-fix", "triage", "verify", "git:commit", "review", "parent", "lint", "brooks-review"]
        );
        let by = |n: &str| found.iter().find(|c| c.name == n).unwrap();
        for name in ["issue-fix", "triage", "verify", "lint"] {
            assert_eq!(by(name).source, AgentCommandSource::Skill);
        }
        for name in ["git:commit", "review", "parent", "brooks-review"] {
            assert_eq!(by(name).source, AgentCommandSource::Command);
        }
        assert_eq!(by("triage").description, "One pass over open issues and PRs");
        assert_eq!(by("issue-fix").description, "Fix an issue");
        assert_eq!(by("verify").description, "Build and drive the app");
        assert_eq!(by("git:commit").description, "Commit the staged changes");
        assert_eq!(
            (by("review").description.as_str(), by("review").hint.as_deref()),
            ("Review a pull request", Some("<pr>"))
        );
    }

    #[test]
    fn hermes_skills_flat_and_in_categories() {
        let tmp = tempfile::tempdir().unwrap();
        let profile = tmp.path();
        assert!(hermes(profile).is_empty());
        for dir in ["skills/plan", "skills/dev/review", "skills/dev/plan", "skills/empty"] {
            std::fs::create_dir_all(profile.join(dir)).unwrap();
        }
        for dir in ["skills/plan", "skills/dev/review", "skills/dev/plan"] {
            std::fs::write(profile.join(dir).join("SKILL.md"), "---\ndescription: d\n---\n").unwrap();
        }
        let names: Vec<_> = hermes(profile).into_iter().map(|c| (c.name, c.source)).collect();
        assert_eq!(
            names,
            [("plan".to_owned(), AgentCommandSource::Skill), ("review".to_owned(), AgentCommandSource::Skill)]
        );
    }

    #[test]
    fn nothing_without_claude_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let repo = home.join("plain");
        std::fs::create_dir_all(&repo).unwrap();
        assert!(discover(&repo, Some(&home)).is_empty());
    }

    #[test]
    fn walking_up_stops_at_home() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        // Above home: not the user's, and not this project's.
        write(&tmp.path().join(".claude/commands/outside.md"), "x\n");
        write(&home.join(".claude/commands/mine.md"), "x\n");
        let repo = home.join("src/app");
        std::fs::create_dir_all(&repo).unwrap();
        assert_eq!(names(&discover(&repo, Some(&home))), ["mine"]);
    }

    #[test]
    fn the_agents_entries_win() {
        let merged = merge(
            vec![cmd("triage", "from the agent"), cmd("compact", "Compact")],
            vec![
                AgentCommand { source: AgentCommandSource::Skill, ..cmd("triage", "from disk") },
                cmd("verify", "Verify"),
            ],
        );
        assert_eq!(names(&merged), ["triage", "compact", "verify"]);
        assert_eq!(merged[0].description, "from the agent");
        assert_eq!(merged[0].source, AgentCommandSource::Skill);
    }

    #[test]
    fn frontmatter_edge_cases() {
        let f = Frontmatter::parse("no fence\n");
        assert!(f.fields.is_empty());
        let f = Frontmatter::parse("---\nname: x\nunterminated\n");
        assert!(f.get("name").is_none());
        let f = Frontmatter::parse("\u{feff}---\r\nname: 'quoted'\r\n---\r\nbody\r\n");
        assert_eq!(f.get("name"), Some("quoted"));
        assert_eq!(truncate(&"é".repeat(MAX_DESCRIPTION + 5)).chars().count(), MAX_DESCRIPTION + 1);
    }

    fn skill(name: &str, source: AgentSkillSource, root: &Path) -> AgentSkill {
        AgentSkill {
            name: name.into(),
            description: format!("{name} does things"),
            hint: None,
            path: root.join(name).into(),
            source,
            also_in: Vec::new(),
            user_invocable: true,
            disable_model_invocation: false,
            valid: true,
            warnings: Vec::new(),
        }
    }

    fn policy(mode: AgentSkillMode) -> Option<AgentSkillPolicy> {
        Some(AgentSkillPolicy { mode })
    }

    #[test]
    fn hub_discovery_scans_every_root_and_collapses_symlinks() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let repo = tmp.path().join("work/app");
        std::fs::create_dir_all(&repo).unwrap();
        write(&repo.join(".agents/skills/dep/SKILL.md"), "---\nname: dep\ndescription: From the standard root\n---\n");
        write(&repo.join(".openidea/skills/local/SKILL.md"), "---\nname: local\ndescription: OpenIDEA's own\n---\n");
        write(&repo.join(".claude/skills/claudey/SKILL.md"), "---\nname: claudey\ndescription: Claude's\n---\n");
        write(&repo.join(".github/skills/gh/SKILL.md"), "---\nname: gh\ndescription: Copilot's repo one\n---\n");
        write(
            &home.join(".agents/skills/shared/SKILL.md"),
            "---\nname: shared\ndescription: From npx skills add\n---\n",
        );
        write(&home.join(".codex/skills/codexy/SKILL.md"), "---\nname: codexy\ndescription: Codex's\n---\n");
        write(&home.join(".cursor/skills/cursory/SKILL.md"), "---\nname: cursory\ndescription: Cursor's\n---\n");
        // A symlink to `dep` in the home (the same canonical folder): collapsed.
        #[cfg(unix)]
        {
            std::fs::create_dir_all(home.join(".claude/skills")).unwrap();
            std::os::unix::fs::symlink(repo.join(".agents/skills/dep"), home.join(".claude/skills/dep")).unwrap();
        }
        // Hidden folders and files are not skills.
        write(&repo.join(".agents/skills/.stash/SKILL.md"), "---\nname: hidden\ndescription: x\n---\n");
        write(&repo.join(".agents/skills/loose.txt"), "not a folder");
        // Same name from a lower-precedence source: the workspace one wins.
        write(&home.join(".cursor/skills/local/SKILL.md"), "---\nname: local\ndescription: from cursor\n---\n");

        let found = discover_skills(&repo, Some(&home));
        assert_eq!(
            found.iter().map(|s| (s.name.as_str(), s.source)).collect::<Vec<_>>(),
            [
                ("dep", AgentSkillSource::Workspace),
                ("local", AgentSkillSource::Workspace),
                ("claudey", AgentSkillSource::ClaudeWorkspace),
                ("gh", AgentSkillSource::GithubWorkspace),
                ("shared", AgentSkillSource::User),
                ("codexy", AgentSkillSource::CodexUser),
                ("cursory", AgentSkillSource::CursorUser),
            ],
            "symlinks collapse and the first of a name wins"
        );
        assert!(found.iter().all(|s| s.valid), "{:?}", found.iter().flat_map(|s| &s.warnings).collect::<Vec<_>>());
    }

    #[test]
    fn hub_discovery_validates_and_reports() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("app");
        std::fs::create_dir_all(&repo).unwrap();
        write(&repo.join(".agents/skills/bad-name/SKILL.md"), "---\nname: Bad_Name\ndescription: x\n---\n");
        write(&repo.join(".agents/skills/no-desc/SKILL.md"), "---\nname: no-desc\n---\n");
        write(
            &repo.join(".agents/skills/verbose/SKILL.md"),
            &format!("---\nname: verbose\ndescription: {}\n---\n", "x".repeat(MAX_SKILL_DESCRIPTION + 1)),
        );

        let found = discover_skills(&repo, None);
        let by = |n: &str| found.iter().find(|s| s.name == n).unwrap();
        assert!(!by("Bad_Name").valid && !by("Bad_Name").warnings.is_empty());
        assert!(!by("no-desc").valid && by("no-desc").warnings.len() == 1);
        assert!(!by("verbose").valid);
    }

    #[test]
    fn hub_resolution_precedence_and_trust() {
        let root = PathBuf::from("/r");
        let ws = skill("tdd", AgentSkillSource::Workspace, &root);
        let user = skill("lint", AgentSkillSource::User, &root);
        let claude = skill("claudey", AgentSkillSource::ClaudeWorkspace, &root);
        let session = BTreeMap::from([("tdd".to_owned(), AgentSkillMode::Off)]);
        let workspace = BTreeMap::from([
            ("tdd".to_owned(), policy(AgentSkillMode::SlashOnly).unwrap()),
            ("lint".to_owned(), policy(AgentSkillMode::Off).unwrap()),
        ]);
        let user_policies = BTreeMap::from([
            ("lint".to_owned(), policy(AgentSkillMode::SlashOnly).unwrap()),
            ("claudey".to_owned(), policy(AgentSkillMode::Auto).unwrap()),
        ]);

        // Session > workspace policy > user policy.
        let resolved = resolve(vec![ws.clone(), user.clone()], Some(&session), &workspace, &user_policies, true);
        assert_eq!((resolved[0].mode, resolved[0].origin), (AgentSkillMode::Off, AgentSkillOrigin::Session));
        assert_eq!((resolved[1].mode, resolved[1].origin), (AgentSkillMode::Off, AgentSkillOrigin::Workspace));

        // Without a workspace policy the user's applies.
        let resolved = resolve(vec![user.clone()], None, &BTreeMap::new(), &user_policies, true);
        assert_eq!((resolved[0].mode, resolved[0].origin), (AgentSkillMode::SlashOnly, AgentSkillOrigin::User));

        // Untrusted: the workspace's own skills stay off whatever the session chose, its
        // policies hold only when they turn a skill off, and user skills keep resolving.
        let resolved = resolve(vec![ws, user, claude], Some(&session), &workspace, &user_policies, false);
        assert_eq!((resolved[0].mode, resolved[0].origin), (AgentSkillMode::Off, AgentSkillOrigin::Trust));
        assert_eq!((resolved[1].mode, resolved[1].origin), (AgentSkillMode::Off, AgentSkillOrigin::Workspace));
        assert_eq!((resolved[2].mode, resolved[2].origin), (AgentSkillMode::Off, AgentSkillOrigin::Trust));
    }

    fn listed(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> =
            std::fs::read_dir(dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    #[test]
    fn hub_staging_hands_each_cli_its_own_tree() {
        let tmp = tempfile::tempdir().unwrap();
        // Discovery reports canonical paths (macOS's temp folder is a symlink).
        let root = dunce::canonicalize(tmp.path()).unwrap();
        let home = root.join("home");
        let repo = root.join("app");
        std::fs::create_dir_all(&repo).unwrap();
        // The staged folders must exist: Windows copies them (symlinks need Developer Mode).
        for path in [
            repo.join(".agents/skills/tdd"),
            repo.join(".agents/skills/off"),
            repo.join(".github/skills/gh"),
            home.join(".agents/skills/lint"),
            home.join(".agents/skills/muted"),
            home.join(".codex/skills/codexy"),
        ] {
            std::fs::create_dir_all(path).unwrap();
        }
        let states = resolve(
            vec![
                skill("tdd", AgentSkillSource::Workspace, &repo.join(".agents/skills")),
                skill("gh", AgentSkillSource::GithubWorkspace, &repo.join(".github/skills")),
                skill("lint", AgentSkillSource::User, &home.join(".agents/skills")),
                skill("codexy", AgentSkillSource::CodexUser, &home.join(".codex/skills")),
                skill("muted", AgentSkillSource::User, &home.join(".agents/skills")),
                skill("off", AgentSkillSource::Workspace, &repo.join(".agents/skills")),
            ],
            None,
            &BTreeMap::from([("muted".to_owned(), policy(AgentSkillMode::SlashOnly).unwrap())]),
            &BTreeMap::from([("off".to_owned(), policy(AgentSkillMode::Off).unwrap())]),
            true,
        );

        //For a local session, `.github/skills`, `.agents/skills` and `~/.agents/skills` are
        // already scanned natively by Copilot; `.openidea/skills` and `~/.codex/skills` are staged.
        let mut states = states;
        std::fs::create_dir_all(repo.join(".openidea/skills/ideonly")).unwrap();
        states.push(AgentSkillState {
            skill: skill("ideonly", AgentSkillSource::Workspace, &repo.join(".openidea/skills")),
            mode: AgentSkillMode::Auto,
            origin: AgentSkillOrigin::None,
        });

        let farm = farm_dir(&root.join("store"), "task-1");
        let delivery = stage(&farm, "claude", &states, &repo, Some(&home)).unwrap();
        assert_eq!(delivery.claude_add_dir.as_deref(), Some(farm.as_path()));
        let claude_tree = farm.join(".claude/skills");
        let staged = listed(&claude_tree);
        assert_eq!(
            staged,
            ["codexy", "gh", "ideonly", "lint", "muted", "tdd"],
            "everything but the off one: none is native to Claude here, and slash-only needs the folder"
        );

        let delivery = stage(&farm, "copilot", &states, &repo, Some(&home)).unwrap();
        assert_eq!(delivery.copilot_skill_directories, [farm.join("copilot").to_string_lossy().into_owned()]);
        assert_eq!(delivery.copilot_disabled_skills, ["muted", "off"]);
        let copilot_staged = listed(&farm.join("copilot"));
        assert_eq!(
            copilot_staged,
            ["codexy", "ideonly"],
            "`gh` (.github), `tdd` (.agents) and `lint` (~/.agents) are native to Copilot; `.openidea` & `~/.codex` are staged"
        );
        assert_eq!(
            delivery.codex_off,
            [
                (
                    "muted".to_owned(),
                    home.join(".agents").join("skills").join("muted").join("SKILL.md").to_string_lossy().into_owned(),
                ),
                (
                    "off".to_owned(),
                    repo.join(".agents").join("skills").join("off").join("SKILL.md").to_string_lossy().into_owned(),
                ),
            ]
        );

        // A worktree task: the repo's skills are untracked, so workspace skills are staged now.
        let worktree = root.join("wt");
        std::fs::create_dir_all(&worktree).unwrap();
        let _ = stage(&farm, "copilot", &states, &worktree, Some(&home)).unwrap();
        let copilot_staged = listed(&farm.join("copilot"));
        assert!(copilot_staged.contains(&"gh".to_string()) && copilot_staged.contains(&"tdd".to_string()));

        // Slash-only reaches Claude as `user-invocable-only`, off as `off`.
        let delivery = stage(&farm, "claude", &states, &repo, Some(&home)).unwrap();
        let settings: serde_json::Value = serde_json::from_str(delivery.claude_settings.as_deref().unwrap()).unwrap();
        assert_eq!(settings["skillOverrides"]["muted"], "user-invocable-only");
        assert_eq!(settings["skillOverrides"]["off"], "off");

        // Restaging after a session turned `lint` off drops its link and leaves the skill.
        let session = BTreeMap::from([("lint".to_owned(), AgentSkillMode::Off)]);
        let restated = resolve(
            states.iter().map(|s| s.skill.clone()).collect(),
            Some(&session),
            &BTreeMap::from([("muted".to_owned(), policy(AgentSkillMode::SlashOnly).unwrap())]),
            &BTreeMap::from([("off".to_owned(), policy(AgentSkillMode::Off).unwrap())]),
            true,
        );
        stage(&farm, "claude", &restated, &repo, Some(&home)).unwrap();
        assert_eq!(listed(&claude_tree), ["codexy", "gh", "ideonly", "muted", "tdd"]);
        assert!(home.join(".agents/skills/lint").is_dir());
        assert!(farm.join("copilot").is_dir(), "restaging Claude's tree leaves Copilot's alone");

        // An ACP agent gets no farm.
        let delivery = stage(&farm, "cursor-acp", &states, &repo, Some(&home)).unwrap();
        assert_eq!(delivery, Delivery::default());

        // The farm goes away with the task.
        remove_farm(&root.join("store"), "task-1");
        assert!(!farm.exists());
    }

    #[test]
    fn hub_menu_filters_off_and_keeps_the_agents_own() {
        let root = PathBuf::from("/r");
        let mut hidden = skill("bg-only", AgentSkillSource::Workspace, &root);
        hidden.user_invocable = false;
        let mut with_hint = skill("verify", AgentSkillSource::Workspace, &root);
        with_hint.hint = Some("[flow]".into());
        with_hint.path = tempfile::tempdir().unwrap().path().to_path_buf().into();
        write(&with_hint.path.0.join("SKILL.md"), "---\nname: verify\ndescription: v\n---\n");
        let states = resolve(
            vec![
                skill("tdd", AgentSkillSource::Workspace, &root),
                skill("lint", AgentSkillSource::User, &root),
                hidden,
                with_hint,
            ],
            Some(&BTreeMap::from([("lint".to_owned(), AgentSkillMode::Off)])),
            &BTreeMap::new(),
            &BTreeMap::new(),
            true,
        );
        // Even when the agent itself (or cached `known_commands` / Codex `$lint`) already offered
        // `lint` or `bg-only`, `menu_commands` strips them, and merges `$tdd` without duplicating `tdd`.
        let offered = vec![
            cmd("$tdd", "from codex itself"),
            AgentCommand { source: AgentCommandSource::Skill, ..cmd("lint", "offered before turning off") },
            cmd("$lint", "codex offered before turning off"),
            AgentCommand { source: AgentCommandSource::Skill, ..cmd("bg-only", "model only") },
            cmd("compact", "Compact context"),
        ];
        let menu = menu_commands(offered, &states);
        assert_eq!(names(&menu), ["$tdd", "compact", "verify"]);
        assert_eq!(menu[0].description, "from codex itself");
        assert_eq!(menu[0].source, AgentCommandSource::Skill);
        assert_eq!(menu[2].hint.as_deref(), Some("[flow]"));
    }

    #[test]
    fn hub_discovers_copilot_two_level_plugins_categories_monorepos_and_frontmatter_flags() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        let home = root.join("home");
        let ws_a = root.join("ws-a");
        let ws_b = root.join("ws-b");
        // Category subfolder in `.agents/skills/testing/coverage/SKILL.md`.
        write(
            &ws_a.join(".agents/skills/testing/coverage/SKILL.md"),
            "---\nname: coverage\ndescription: Coverage workflow\nargument-hint: \"[pkg]\"\ndisable-model-invocation: true\n---\n",
        );
        // Nested monorepo subpackage `apps/web/.agents/skills/web-e2e/SKILL.md`.
        write(
            &ws_a.join("apps/web/.agents/skills/web-e2e/SKILL.md"),
            "---\nname: web-e2e\ndescription: Web e2e\n---\n",
        );
        // Second workspace member root `ws-b`.
        write(&ws_b.join(".agents/skills/deploy/SKILL.md"), "---\nname: deploy\ndescription: Deploy\n---\n");
        // Misplaced top-level `SKILL.md` directly inside `.claude/skills/SKILL.md`.
        write(&ws_a.join(".claude/skills/SKILL.md"), "---\nname: misplaced\ndescription: Wrong level\n---\n");
        // Copilot 2-level marketplace & `_direct` plugins + disabled plugin in `config.json`.
        write(
            &home.join(".copilot/installed-plugins/awesome-copilot/db-tools/skills/pg-tune/SKILL.md"),
            "---\nname: pg-tune\ndescription: Tune Postgres\n---\n",
        );
        write(
            &home.join(".copilot/installed-plugins/_direct/muted-plug/skills/secret-op/SKILL.md"),
            "---\nname: secret-op\ndescription: Disabled plugin skill\n---\n",
        );
        write(
            &home.join(".copilot/config.json"),
            "// Managed by Copilot CLI\n{\"installedPlugins\":[{\"name\":\"muted-plug\",\"enabled\":false,\"cache_path\":\"installed-plugins/_direct/muted-plug\"}]}\n",
        );
        #[cfg(unix)]
        {
            std::fs::create_dir_all(ws_a.join(".claude/skills")).unwrap();
            std::os::unix::fs::symlink(
                ws_a.join(".agents/skills/testing/coverage"),
                ws_a.join(".claude/skills/coverage"),
            )
            .unwrap();
        }

        let found = discover_skills_in(&[ws_a.clone(), ws_b], Some(&home));
        let by = |n: &str| found.iter().find(|s| s.name == n);
        let cov = by("coverage").expect("category skill discovered");
        assert_eq!(cov.hint.as_deref(), Some("[pkg]"));
        assert!(cov.disable_model_invocation);
        #[cfg(unix)]
        assert_eq!(cov.also_in, [AgentSkillSource::ClaudeWorkspace]);
        assert!(by("web-e2e").is_some(), "nested monorepo subpackage skill discovered");
        assert!(by("deploy").is_some(), "second workspace member skill discovered");
        assert!(by("pg-tune").is_some(), "2-level Copilot marketplace plugin skill discovered");
        assert!(by("secret-op").is_none(), "disabled Copilot plugin skipped");
        let misplaced = by("misplaced").expect("misplaced top-level SKILL.md surfaced");
        assert!(!misplaced.valid && misplaced.warnings[0].contains("subfolder"));

        // `disable-model-invocation: true` resolves to `SlashOnly` by default, and because
        // `.claude/skills/coverage` symlinks to it in `ws_a`, Claude does not stage a duplicate.
        let states = resolve(found, None, &BTreeMap::new(), &BTreeMap::new(), true);
        let cov_state = states.iter().find(|s| s.skill.name == "coverage").unwrap();
        assert_eq!(cov_state.mode, AgentSkillMode::SlashOnly);
        #[cfg(unix)]
        {
            let farm = farm_dir(&root.join("store"), "task-symlink");
            let _ = stage(&farm, "claude", &states, &ws_a, Some(&home)).unwrap();
            let claude_staged = listed(&farm.join(".claude/skills"));
            assert!(
                !claude_staged.contains(&"coverage".to_string()),
                "symlinked `.claude/skills/coverage` not duplicated"
            );
        }
    }
}
