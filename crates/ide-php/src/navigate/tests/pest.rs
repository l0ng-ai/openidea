//! `$this` in Pest's test closures is the test case `uses(…)->in(…)` (or
//! `pest()->extend(…)->in(…)`) binds the file's folder to, the file's own
//! `uses(…)`, else PHPUnit's `TestCase`.

use super::*;

const PHPUNIT: &str = r#"<?php
namespace PHPUnit\Framework;

abstract class TestCase
{
    public function assertTrue($condition): void {}
}
"#;

const TEST_CASES: &str = r#"<?php
namespace Tests;

trait CreatesUsers
{
    public function createUser(): string { return ''; }
}

abstract class TestCase extends \PHPUnit\Framework\TestCase
{
    protected function loginAs(string $name): static { return $this; }
}

abstract class AdminTestCase extends TestCase
{
    public function adminPanel(): int { return 1; }
}
"#;

const PEST_CONFIG: &str = r#"<?php

use Tests\AdminTestCase;
use Tests\CreatesUsers;
use Tests\TestCase;

uses(TestCase::class, CreatesUsers::class)->in('Feature');
pest()->extend(AdminTestCase::class)->in('Feature/Admin', '../modules/admin/tests');
"#;

fn project(test_file: &str, test: &str) -> Project {
    Project::new(&[
        ("lib/phpunit/TestCase.php", PHPUNIT),
        ("tests/TestCase.php", TEST_CASES),
        ("tests/Pest.php", PEST_CONFIG),
        (test_file, test),
    ])
}

#[test]
fn this_in_a_test_closure_is_the_folders_test_case() {
    let test = "<?php\n\ntest('logs in', function () {\n    $this->loginAs('ann')->assert/*|*/True(true);\n});\n";
    let mut p = project("tests/Feature/LoginTest.php", test);
    assert_eq!(
        p.definition("tests/Feature/LoginTest.php", test).expect("handled"),
        [target("lib/phpunit/TestCase.php", 5, "assertTrue")]
    );
    // A protected method of the test case, through `it()` and a chained call.
    let test = "<?php\n\nit('logs in', fn () => $this->login/*|*/As('ann'))->skip();\n";
    let mut p = project("tests/Feature/LoginTest.php", test);
    assert_eq!(
        p.definition("tests/Feature/LoginTest.php", test).expect("handled"),
        [target("tests/TestCase.php", 10, "loginAs")]
    );
}

#[test]
fn the_closest_folder_and_the_files_own_uses_win() {
    // `Feature/Admin` is more specific than `Feature`, inside `describe()` and `beforeEach()`.
    let test = "<?php\n\ndescribe('panel', function () {\n    beforeEach(function () {\n        $this->admin/*|*/Panel();\n    });\n});\n";
    let mut p = project("tests/Feature/Admin/PanelTest.php", test);
    assert_eq!(
        p.definition("tests/Feature/Admin/PanelTest.php", test).expect("handled"),
        [target("tests/TestCase.php", 15, "adminPanel")]
    );
    // A folder outside `tests/` (`../modules/admin/tests`).
    let mut p = project("modules/admin/tests/PanelTest.php", test);
    assert_eq!(
        p.definition("modules/admin/tests/PanelTest.php", test).expect("handled"),
        [target("tests/TestCase.php", 15, "adminPanel")]
    );
    // The file's own `uses()`.
    let test =
        "<?php\n\nuses(Tests\\AdminTestCase::class);\n\ntest('x', function () {\n    $this->admin/*|*/Panel();\n});\n";
    let mut p = project("tests/Unit/PanelTest.php", test);
    assert_eq!(
        p.definition("tests/Unit/PanelTest.php", test).expect("handled"),
        [target("tests/TestCase.php", 15, "adminPanel")]
    );
}

#[test]
fn other_closures_and_folders() {
    // A folder no `in()` names: PHPUnit's test case.
    let test = "<?php\n\ntest('x', function () {\n    $this->assert/*|*/True(true);\n});\n";
    let mut p = project("tests/Unit/MathTest.php", test);
    assert_eq!(
        p.definition("tests/Unit/MathTest.php", test).expect("handled"),
        [target("lib/phpunit/TestCase.php", 5, "assertTrue")]
    );
    // Not a Pest closure: `$this` is unknown.
    let test = "<?php\n\n$f = function () {\n    $this->assert/*|*/True(true);\n};\n";
    let mut p = project("tests/Feature/HelperTest.php", test);
    assert_eq!(p.definition("tests/Feature/HelperTest.php", test).expect("handled"), []);
}
