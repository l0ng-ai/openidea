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
    let mut out: Vec<AgentSkill> = Vec::new();
    let mut seen_paths: HashSet<PathBuf> = HashSet::new();
    let mut seen_names: HashSet<String> = HashSet::new();
    let mut roots: Vec<(PathBuf, AgentSkillSource)> = Vec::new();
    roots.extend(WORKSPACE_ROOTS.iter().map(|(rel, source)| (workspace.join(rel), *source)));
    let mut plugin_roots = Vec::new();
    if let Some(home) = home {
        roots.extend(HOME_ROOTS.iter().map(|(rel, source)| (home.join(rel), *source)));
        // `copilot install` unpacks plugins under `installed-plugins/<plugin>/`, whose skills
        // sit in a `skills` folder (or directly in the plugin folder).
        let plugins = home.join(".copilot/installed-plugins");
        if let Ok(plugins) = plugins.read_dir() {
            for plugin in plugins.flatten() {
                if plugin.path().is_dir() {
                    plugin_roots.push((plugin.path().join("skills"), AgentSkillSource::CopilotUser));
                    plugin_roots.push((plugin.path(), AgentSkillSource::CopilotUser));
                }
            }
        }
    }
    roots.extend(plugin_roots);
    for (root, source) in roots {
        for skill in skills_of(&root, source) {
            let path = dunce::canonicalize(&skill.path.0).unwrap_or_else(|_| skill.path.0.clone());
            if !seen_paths.insert(path.clone()) || !seen_names.insert(skill.name.clone()) {
                continue;
            }
            out.push(AgentSkill { path: path.into(), ..skill });
        }
    }
    out
}

/// The skills of one root: `<name>/SKILL.md` folders, validated.
fn skills_of(root: &Path, source: AgentSkillSource) -> Vec<AgentSkill> {
    let mut out: Vec<AgentSkill> = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else { return out };
    for entry in entries.flatten() {
        let dir = entry.path();
        let Some(folder) = dir.file_name().and_then(|n| n.to_str()).map(str::to_owned) else { continue };
        if !dir.is_dir() || folder.starts_with('.') {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(dir.join("SKILL.md")) else { continue };
        let meta = Frontmatter::parse(&text);
        let name = meta.get("name").filter(|n| !n.is_empty()).map(str::to_owned).unwrap_or_else(|| folder.clone());
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
        out.push(AgentSkill {
            name,
            description: truncate(&description),
            path: dir.into(),
            source,
            valid: warnings.is_empty(),
            warnings,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// A skill's mode, as one policy layer of the settings has it.
type Policies = BTreeMap<String, AgentSkillPolicy>;

/// Resolves every skill's mode: a session override, then the workspace's and the user's
/// `[agents.skills.<name>]` policy, then the default `auto` — with an untrusted workspace
/// able to turn skills off only: its own skills stay off (whatever the session chose), and
/// its policies hold only when they turn a skill off.
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
        let (mode, origin) = if workspace_skill && !workspace_trusted {
            // Workspace trust gates the workspace's own skills, whatever else says.
            (AgentSkillMode::Off, AgentSkillOrigin::Trust)
        } else if let Some(chosen) = session.and_then(|s| s.get(&skill.name)) {
            (*chosen, AgentSkillOrigin::Session)
        } else if let Some(policy) =
            workspace.get(&skill.name).filter(|p| workspace_trusted || p.mode == AgentSkillMode::Off)
        {
            (policy.mode, AgentSkillOrigin::Workspace)
        } else if let Some(policy) = user.get(&skill.name) {
            (policy.mode, AgentSkillOrigin::User)
        } else {
            (AgentSkillMode::Auto, AgentSkillOrigin::None)
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
        match state.mode {
            AgentSkillMode::Off => {
                out.codex_off.push((name.to_owned(), state.skill.path.to_string_lossy().into_owned()));
            }
            // Claude Code runs a slash-only skill on `/name`, so it has to see the folder;
            // Copilot and Codex have no such mode and get it disabled or left out.
            AgentSkillMode::SlashOnly => {
                if let Some(tree) = claude_tree.as_ref().filter(|_| !native_claude(&state.skill, &cwd, home)) {
                    link_skill(&tree.join(name), path)?;
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
    let off: Vec<&str> =
        states.iter().filter(|s| s.mode == AgentSkillMode::Off).map(|s| s.skill.name.as_str()).collect();
    let slash: Vec<&str> =
        states.iter().filter(|s| s.mode == AgentSkillMode::SlashOnly).map(|s| s.skill.name.as_str()).collect();
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

/// Claude Code sees this skill without the farm: its own `.claude/skills` of the working
/// directory (a worktree lacks the untracked originals) or the home.
fn native_claude(skill: &AgentSkill, cwd: &Path, home: Option<&Path>) -> bool {
    match skill.source {
        AgentSkillSource::ClaudeWorkspace => is_under(skill.path.0.as_path(), cwd),
        AgentSkillSource::ClaudeUser => home.is_some_and(|h| is_under(skill.path.0.as_path(), &h.join(".claude"))),
        _ => false,
    }
}

/// Copilot reads the repository's `.github/skills` and the home's `.copilot` itself.
fn native_copilot(skill: &AgentSkill, cwd: &Path, home: Option<&Path>) -> bool {
    match skill.source {
        AgentSkillSource::GithubWorkspace => is_under(skill.path.0.as_path(), cwd),
        AgentSkillSource::CopilotUser => home.is_some_and(|h| is_under(skill.path.0.as_path(), &h.join(".copilot"))),
        _ => false,
    }
}

/// Codex reads its own folders itself.
fn native_codex(skill: &AgentSkill, cwd: &Path, home: Option<&Path>) -> bool {
    match skill.source {
        AgentSkillSource::CodexWorkspace => is_under(skill.path.0.as_path(), cwd),
        AgentSkillSource::CodexUser => home.is_some_and(|h| is_under(skill.path.0.as_path(), &h.join(".codex"))),
        _ => false,
    }
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

/// The `/` menu's skills: the active ones as commands (the agent's own listing wins on a
/// name clash). `Off` ones drop out everywhere; an ACP agent gets no other enforcement, so
/// `slashOnly` ones stay listed — there is nothing to hold them back with.
pub fn menu_commands(offered: Vec<AgentCommand>, states: &[AgentSkillState]) -> Vec<AgentCommand> {
    let extra = states
        .iter()
        .filter(|s| s.mode != AgentSkillMode::Off)
        .map(|s| AgentCommand {
            name: s.skill.name.clone(),
            description: s.skill.description.clone(),
            hint: None,
            source: AgentCommandSource::Skill,
        })
        .collect();
    merge(offered, extra)
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
            path: root.join(name).into(),
            source,
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

        // Local (non-worktree) session: the project's GitHub skills are Copilot's own.
        let farm = farm_dir(&root.join("store"), "task-1");
        let delivery = stage(&farm, "claude", &states, &repo, Some(&home)).unwrap();
        assert_eq!(delivery.claude_add_dir.as_deref(), Some(farm.as_path()));
        let claude_tree = farm.join(".claude/skills");
        let staged = listed(&claude_tree);
        assert_eq!(
            staged,
            ["codexy", "gh", "lint", "muted", "tdd"],
            "everything but the off one: none is native to Claude here, and slash-only needs the folder"
        );

        let delivery = stage(&farm, "copilot", &states, &repo, Some(&home)).unwrap();
        assert_eq!(delivery.copilot_skill_directories, [farm.join("copilot").to_string_lossy().into_owned()]);
        assert_eq!(delivery.copilot_disabled_skills, ["muted", "off"]);
        let copilot_staged = listed(&farm.join("copilot"));
        assert_eq!(copilot_staged, ["codexy", "lint", "tdd"], "`gh` is native to a local Copilot session");
        assert_eq!(
            delivery.codex_off,
            [("off".to_owned(), repo.join(".agents/skills").join("off").to_string_lossy().into_owned())]
        );

        // A worktree task: the repo's skills are untracked, so nothing is native any more.
        let worktree = root.join("wt");
        std::fs::create_dir_all(&worktree).unwrap();
        let _ = stage(&farm, "copilot", &states, &worktree, Some(&home)).unwrap();
        let copilot_staged = listed(&farm.join("copilot"));
        assert!(copilot_staged.contains(&"gh".to_string()));

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
        assert_eq!(listed(&claude_tree), ["codexy", "gh", "muted", "tdd"]);
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
        let states = resolve(
            vec![skill("tdd", AgentSkillSource::Workspace, &root), skill("lint", AgentSkillSource::User, &root)],
            Some(&BTreeMap::from([("lint".to_owned(), AgentSkillMode::Off)])),
            &BTreeMap::new(),
            &BTreeMap::new(),
            true,
        );
        let menu = menu_commands(vec![cmd("tdd", "from the agent itself")], &states);
        assert_eq!(names(&menu), ["tdd"]);
        assert_eq!(menu[0].description, "from the agent itself");
        assert_eq!(menu[0].source, AgentCommandSource::Skill);
    }
}
