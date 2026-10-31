//! Bundled skills: their declarations and installing them into a temporary home.

use ide_core::mcp::McpSkillTarget;
use ide_mcp::clients::{Os, Paths};
use ide_mcp::skills::{self, BUNDLED, SkillRoot};
use std::collections::HashSet;

#[test]
fn bundled_skills_are_well_formed() {
    let tools: HashSet<&str> = ide_mcp::tools::all().iter().map(|t| t.name).collect();
    for skill in BUNDLED {
        assert!(!skill.id.trim().is_empty());
        for tool in skill.tools {
            assert!(tools.contains(tool), "skill {} names unknown tool {tool}", skill.id);
        }
        for tool in skill.required_tools {
            assert!(skill.tools.contains(tool), "skill {} requires undeclared {tool}", skill.id);
        }
        let (_, text) = skill.files.iter().find(|(p, _)| *p == "SKILL.md").expect("SKILL.md");
        assert!(text.starts_with(&format!("---\nname: {}\n", skill.id)), "{}", skill.id);
    }
}

#[test]
fn installs_updates_and_removes_for_each_agent() {
    let home = tempfile::tempdir().unwrap();
    let paths = Paths::under(home.path(), Os::Linux);
    let root = SkillRoot::User(&paths);
    let none = HashSet::new();
    let id = BUNDLED[0].id;
    assert!(skills::list(root, &none)[0].installed.is_empty());

    for (target, dir) in [
        (McpSkillTarget::Claude, ".claude/skills"),
        (McpSkillTarget::Codex, ".codex/skills"),
        (McpSkillTarget::Junie, ".junie/skills"),
        (McpSkillTarget::Other, ".agents/skills"),
    ] {
        let installed = skills::install(id, target, root, &none).unwrap();
        assert_eq!(installed, home.path().join(dir).join(id));
        assert!(installed.join("SKILL.md").is_file());
    }
    assert_eq!(skills::list(root, &none)[0].installed.len(), 4);

    // Updating replaces the directory, leftovers included.
    let claude = home.path().join(".claude/skills").join(id);
    std::fs::write(claude.join("stale.md"), "x").unwrap();
    skills::install(id, McpSkillTarget::Claude, root, &none).unwrap();
    assert!(!claude.join("stale.md").exists());

    skills::remove(id, McpSkillTarget::Claude, root).unwrap();
    assert!(!claude.exists());
    let info = &skills::list(root, &none)[0];
    assert!(!info.installed.contains(&McpSkillTarget::Claude) && info.installed.len() == 3);
    // Removing what is not there is fine.
    skills::remove(id, McpSkillTarget::Claude, root).unwrap();
}

#[test]
fn leaves_the_users_own_skill_alone() {
    let home = tempfile::tempdir().unwrap();
    let paths = Paths::under(home.path(), Os::Mac);
    let root = SkillRoot::User(&paths);
    let id = BUNDLED[0].id;
    let own = home.path().join(".claude/skills").join(id);
    std::fs::create_dir_all(&own).unwrap();
    std::fs::write(own.join("SKILL.md"), "mine").unwrap();
    assert!(skills::install(id, McpSkillTarget::Claude, root, &HashSet::new()).is_err());
    assert!(skills::remove(id, McpSkillTarget::Claude, root).is_err());
    assert_eq!(std::fs::read_to_string(own.join("SKILL.md")).unwrap(), "mine");
    assert!(skills::list(root, &HashSet::new())[0].installed.is_empty());
}

#[test]
fn needs_its_required_tools_and_installs_into_projects() {
    let home = tempfile::tempdir().unwrap();
    let paths = Paths::under(home.path(), Os::Mac);
    let skill = &BUNDLED[0];
    let disabled: HashSet<String> = [skill.required_tools[0].to_owned()].into();
    assert!(!skills::list(SkillRoot::User(&paths), &disabled)[0].available);
    assert!(skills::install(skill.id, McpSkillTarget::Claude, SkillRoot::User(&paths), &disabled).is_err());

    let project = tempfile::tempdir().unwrap();
    let dir =
        skills::install(skill.id, McpSkillTarget::Codex, SkillRoot::Project(project.path()), &HashSet::new()).unwrap();
    assert_eq!(dir, project.path().join(".codex/skills").join(skill.id));

    let mut paths = paths;
    paths.codex_home = Some(home.path().join("codex-home"));
    let dir = skills::install(skill.id, McpSkillTarget::Codex, SkillRoot::User(&paths), &HashSet::new()).unwrap();
    assert_eq!(dir, home.path().join("codex-home/skills").join(skill.id));
}
