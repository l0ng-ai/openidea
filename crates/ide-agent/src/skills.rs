//! Claude Code's slash commands on disk, for completion before (or without) a session:
//! skills (`.claude/skills/<dir>/SKILL.md`) and custom commands (`.claude/commands/**/*.md`)
//! of the working directory and every directory above it, then the user's `~/.claude`.

use crate::{AgentCommand, AgentCommandSource};
use std::collections::HashSet;
use std::path::Path;

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
}
