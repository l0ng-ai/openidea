use openidea_plugin::{DependencyNode, DependencyStatus, Error, mock::MockHost};

fn node(group: &str, artifact: &str, version: &str, scope: &str, parent: Option<u32>) -> DependencyNode {
    DependencyNode {
        group: group.into(),
        artifact: artifact.into(),
        version: version.into(),
        scope: scope.into(),
        status: DependencyStatus::Resolved,
        requested_version: None,
        parent,
    }
}

#[test]
fn the_graph_of_one_module_or_all_behind_the_grant() {
    let mock = MockHost::install().with_capabilities(&[]);
    let lost = DependencyNode {
        status: DependencyStatus::OmittedForConflict,
        requested_version: Some("3.12.0".into()),
        ..node("org.apache.commons", "commons-lang3", "3.14.0", "compile", Some(1))
    };
    mock.set_build_dependencies(vec![
        node("com.example", "app", "1.0", "", None),
        node("org.apache.commons", "commons-text", "1.11.0", "compile", Some(0)),
        lost.clone(),
        node("", ":web", "", "", None),
        node("org.yaml", "snakeyaml", "2.2", "runtimeClasspath", Some(3)),
    ]);
    let p = mock.invocation().project().unwrap();
    assert!(matches!(p.build_dependencies(None), Err(Error::Denied(c)) if c == "build.read"));

    let mock = mock.with_capabilities(&["build.read"]);
    assert_eq!(p.build_dependencies(None).unwrap().len(), 5);
    let app = p.build_dependencies(Some("com.example:app")).unwrap();
    assert_eq!(app.len(), 3);
    assert_eq!(app[2], lost);
    // Why is commons-lang3 here: up through commons-text to the module.
    let why: Vec<_> =
        std::iter::successors(Some(2), |&i| app[i].parent.map(|p| p as usize)).map(|i| &app[i].artifact).collect();
    assert_eq!(why, ["commons-lang3", "commons-text", "app"]);
    let web = p.build_dependencies(Some(":web")).unwrap();
    assert_eq!(
        web,
        [node("", ":web", "", "", None), node("org.yaml", "snakeyaml", "2.2", "runtimeClasspath", Some(0))]
    );
    assert!(matches!(p.build_dependencies(Some("app")), Err(Error::NotFound(_))));

    mock.set_restricted(true);
    assert!(matches!(p.build_dependencies(None), Err(Error::Denied(_))));
}
