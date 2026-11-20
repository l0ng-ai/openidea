use openidea_plugin::{ConsoleRule, Error, host, mock::MockHost};

#[test]
fn rules_replace_the_previous_list_without_a_capability() {
    let mock = MockHost::install().with_capabilities(&[]);
    let audit = ConsoleRule::new(r"\[AUDIT\]").foreground("bright-yellow").style("bold").whole_line();
    let job = ConsoleRule::new(r"job-\d+").ignore_case().background("blue").enabled(false);
    host::set_console_rules(&[audit.clone(), job.clone()]).unwrap();
    assert_eq!(mock.console_rules(), [audit.clone(), job]);
    assert!(audit.whole_line && audit.enabled && !audit.ignore_case);

    assert!(matches!(host::set_console_rules(&[ConsoleRule::new("")]), Err(Error::Invalid(_))));
    assert!(matches!(host::set_console_rules(&vec![ConsoleRule::new("x"); 101]), Err(Error::Invalid(_))));
    assert_eq!(mock.console_rules().len(), 2);
    host::set_console_rules(&[]).unwrap();
    assert!(mock.console_rules().is_empty());
}
