//! Lines beginning `test ` get a gutter button; the executable accepts the name as a filter.
use openidea_plugin::language_features::{Document, GutterAction, LanguageFeatures};
use openidea_plugin::{
    Error, Invocation, Plugin, PluginRunConfiguration, PluginTestEvent, RunConfigurations, TestFailed, TestPassed,
    TestResults, TestStart, host, register_plugin,
};
#[derive(Default)]
pub struct TestRunner {
    pending: String,
}
impl Plugin for TestRunner {
    fn run_command(&mut self, _id: &str, _ctx: &Invocation, arg: Option<&str>) -> Result<Option<String>, Error> {
        let args = arg.into_iter().map(str::to_owned).collect::<Vec<_>>();
        host::start_run("tests", &args, false).map(Some)
    }
}
impl RunConfigurations for TestRunner {
    fn configurations(&mut self, _root: &str) -> Vec<PluginRunConfiguration> {
        vec![PluginRunConfiguration {
            id: "tests".into(),
            name: "Example tests".into(),
            program: "openidea-example-tests".into(),
            test: true,
            framework: Some("plugin".into()),
            ..Default::default()
        }]
    }
}
impl LanguageFeatures for TestRunner {
    fn gutter_actions(&mut self, doc: &Document) -> Vec<GutterAction> {
        if !doc.path.ends_with("example.tests") {
            return vec![];
        }
        doc.text
            .lines()
            .enumerate()
            .filter_map(|(line, text)| {
                let name = text.strip_prefix("test ")?.trim();
                Some(GutterAction {
                    line: line as u32,
                    icon: Some("run".into()),
                    tooltip: format!("Run {name}"),
                    command: "test".into(),
                    argument: Some(name.into()),
                })
            })
            .collect()
    }
}
impl TestResults for TestRunner {
    fn select_tests(&mut self, config: &str, tests: &[Vec<String>]) -> Option<Vec<String>> {
        if config != "tests" || tests.is_empty() || tests.iter().any(|p| p.len() != 1) {
            return None;
        }
        Some(tests.iter().map(|p| p[0].clone()).collect())
    }
    fn parse(&mut self, _config: &str, chunk: &str) -> Vec<PluginTestEvent> {
        self.pending.push_str(chunk);
        let mut events = vec![];
        while let Some(end) = self.pending.find('\n') {
            let line: String = self.pending.drain(..=end).collect();
            let Some((kind, name)) = line.trim().split_once(' ') else { continue };
            let id = name.to_owned();
            match kind {
                "start" => events.push(PluginTestEvent::TestStarted(TestStart {
                    id,
                    parent: None,
                    name: name.into(),
                    location: None,
                })),
                "pass" => events.push(PluginTestEvent::Passed(TestPassed { id, duration_ms: None })),
                "fail" => events.push(PluginTestEvent::Failed(TestFailed {
                    id,
                    duration_ms: None,
                    message: "Example failure".into(),
                    expected: None,
                    actual: None,
                    location: None,
                })),
                _ => {}
            }
        }
        if self.pending.len() > 64 * 1024 {
            self.pending.clear();
        }
        events
    }
}
register_plugin!(TestRunner, run_configurations, test_results, language_features);
#[cfg(test)]
mod tests {
    use super::*;
    use openidea_plugin::mock::MockHost;
    #[test]
    fn filters_reach_runs_and_split_output_builds_the_test_tree() {
        let mock = MockHost::install().with_capabilities(&["process:openidea-example-tests"]);
        let mut plugin = TestRunner::default();
        mock.set_run_configurations(plugin.configurations("/project"));
        plugin.run_command("test", &mock.invocation(), Some("adds")).unwrap();
        assert_eq!(mock.configuration_runs()[0].2, vec!["adds"]);
        assert_eq!(
            plugin.select_tests("tests", &[vec!["adds".into()], vec!["subs".into()]]),
            Some(vec!["adds".into(), "subs".into()])
        );
        assert_eq!(plugin.select_tests("unknown", &[vec!["adds".into()]]), None);
        assert_eq!(plugin.select_tests("tests", &[vec!["suite".into(), "adds".into()]]), None);
        assert!(plugin.parse("tests", "sta").is_empty());
        let events = plugin.parse("tests", "rt adds\npass adds\n");
        assert!(matches!(&events[..], [PluginTestEvent::TestStarted(_), PluginTestEvent::Passed(_)]));
    }
}
