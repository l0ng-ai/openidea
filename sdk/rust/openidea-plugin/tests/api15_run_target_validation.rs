use openidea_plugin::{mock::MockHost, *};

#[test]
fn validation_receives_mock_project_and_can_refuse_each_launch_kind() {
    struct Validator;
    impl RunTargetValidation for Validator {
        fn validate(&mut self, project: &str, target: &str, launch: &RunTargetLaunch) -> Result<(), String> {
            assert!(!project.is_empty());
            assert_eq!(launch.program, "composer");
            if target == "stopped" { Err("Project runtime is stopped".into()) } else { Ok(()) }
        }
    }
    let mock = MockHost::install();
    for operation in [RunTargetOperation::Run, RunTargetOperation::Test] {
        let launch = RunTargetLaunch { operation, program: "composer".into(), cwd: "/project".into() };
        assert!(mock.validate_run_target(&mut Validator, "running", &launch).is_ok());
        assert_eq!(
            mock.validate_run_target(&mut Validator, "stopped", &launch),
            Err("Project runtime is stopped".into())
        );
    }
}
