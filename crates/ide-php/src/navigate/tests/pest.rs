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

const EXPECTATION: &str = r#"<?php
namespace Pest;

final class Expectation
{
    public mixed $value;

    public function extend(string $name, \Closure $extend): void {}

    public function toBe(mixed $expected): self { return $this; }
}

function expect(mixed $value = null): Expectation { return new Expectation(); }
"#;

const EXTEND: &str = r#"<?php

expect()->extend('toBePrice', function (float $expected) {
    $this->to/*|*/Be($expected);

    return $this;
});
"#;

#[test]
fn custom_expectations_are_methods_of_the_expectation() {
    let config = EXTEND.replace("/*|*/", "");
    let files = |test: &str| {
        Project::new(&[
            ("lib/pest/Expectation.php", EXPECTATION),
            ("tests/Pest.php", config.as_str()),
            ("tests/Unit/PriceTest.php", test),
        ])
    };
    // The custom expectation, and what it returns: the expectation.
    let test = "<?php\n\nuse function Pest\\expect;\n\ntest('x', function () {\n    expect(1.0)->toBePrice(1.0)->to/*|*/Be(1.0);\n});\n";
    let mut p = files(test);
    assert_eq!(
        p.definition("tests/Unit/PriceTest.php", test).expect("handled"),
        [target("lib/pest/Expectation.php", 9, "toBe")]
    );
    let test =
        "<?php\n\nuse function Pest\\expect;\n\ntest('x', function () {\n    expect(1.0)->toBe/*|*/Price(1.0);\n});\n";
    let mut p = files(test);
    assert_eq!(
        p.definition("tests/Unit/PriceTest.php", test).expect("handled"),
        [target("tests/Pest.php", 2, "toBePrice")]
    );
    // `$this` in the closure is the expectation.
    let mut p = files("<?php\n");
    assert_eq!(
        p.definition("tests/Pest.php", EXTEND).expect("handled"),
        [target("lib/pest/Expectation.php", 9, "toBe")]
    );
}

#[test]
fn properties_set_up_before_each_test_are_typed() {
    let test = "<?php\n\nbeforeEach(function () {\n    $this->user = new Tests\\AdminTestCase('x');\n});\n\ndescribe('panel', function () {\n    beforeEach(function () {\n        $this->inner = $this->user;\n    });\n\n    it('opens', function () {\n        $this->inner->admin/*|*/Panel();\n    });\n});\n";
    let mut p = project("tests/Feature/PanelTest.php", test);
    assert_eq!(
        p.definition("tests/Feature/PanelTest.php", test).expect("handled"),
        [target("tests/TestCase.php", 15, "adminPanel")]
    );
    // A property nothing assigns stays unknown.
    let test = "<?php\n\ntest('x', function () {\n    $this->nothing->admin/*|*/Panel();\n});\n";
    let mut p = project("tests/Feature/PanelTest.php", test);
    assert_eq!(p.definition("tests/Feature/PanelTest.php", test).expect("handled"), []);
}

const MIXIN: &str = r#"<?php
namespace Pest\Mixins;

/** @template TValue */
final class Expectation
{
    /** @return self<TValue> */
    public function toBeTrue(): self { return $this; }
}
"#;

const GENERIC_EXPECTATION: &str = r#"<?php
namespace Pest;

/**
 * @template TValue
 * @mixin Mixins\Expectation<TValue>
 */
final class Expectation
{
    public function toBe(mixed $expected): self { return $this; }

    public function __call(string $method, array $parameters): Expectation { return $this; }
}

/**
 * @template TValue
 * @param TValue $value
 * @return Expectation<TValue>
 */
function expect(mixed $value = null): Expectation { return new Expectation(); }
"#;

#[test]
fn higher_order_expectations_reach_the_value() {
    let files = |test: &str| {
        Project::new(&[
            ("lib/phpunit/TestCase.php", PHPUNIT),
            ("lib/pest/Expectation.php", GENERIC_EXPECTATION),
            ("lib/pest/Mixin.php", MIXIN),
            ("tests/TestCase.php", TEST_CASES),
            ("tests/Unit/PanelTest.php", test),
        ])
    };
    let head =
        "<?php\n\nuse function Pest\\expect;\n\ntest('x', function () {\n    $panel = new Tests\\AdminTestCase('x');\n";
    // A method of the expected value, and the expectation after it.
    let test = format!("{head}    expect($panel)->admin/*|*/Panel()->toBe(1);\n}});\n");
    let mut p = files(&test);
    assert_eq!(
        p.definition("tests/Unit/PanelTest.php", &test).expect("handled"),
        [target("tests/TestCase.php", 15, "adminPanel")]
    );
    let test = format!("{head}    expect($panel)->adminPanel()->to/*|*/Be(1);\n}});\n");
    let mut p = files(&test);
    assert_eq!(
        p.definition("tests/Unit/PanelTest.php", &test).expect("handled"),
        [target("lib/pest/Expectation.php", 9, "toBe")]
    );
    // After an assertion of the mixin (which returns the mixin's `self`).
    let test = format!(
        "{head}    expect($panel)->toBeTrue()->admin/*|*/Panel()->name->toBe(1);
}});
"
    );
    let mut p = files(&test);
    assert_eq!(
        p.definition("tests/Unit/PanelTest.php", &test).expect("handled"),
        [target("tests/TestCase.php", 15, "adminPanel")]
    );
    // A property of the value is an expectation again.
    let test = format!("{head}    expect($panel)->name->to/*|*/Be(1);\n}});\n");
    let mut p = files(&test);
    assert_eq!(
        p.definition("tests/Unit/PanelTest.php", &test).expect("handled"),
        [target("lib/pest/Expectation.php", 9, "toBe")]
    );
}

#[test]
fn test_without_arguments_is_the_test_case() {
    let test = "<?php\n\nfunction openPanel(): int\n{\n    return test()->admin/*|*/Panel();\n}\n\ntest('x', function () {\n    openPanel();\n});\n";
    let mut p = project("tests/Feature/Admin/PanelTest.php", test);
    assert_eq!(
        p.definition("tests/Feature/Admin/PanelTest.php", test).expect("handled"),
        [target("tests/TestCase.php", 15, "adminPanel")]
    );
}

#[test]
fn this_in_a_trait_is_also_a_class_using_it() {
    let concern = "<?php\nnamespace Tests;\n\ntrait OpensPanels\n{\n    public function open(): void\n    {\n        $this->login/*|*/As('ann');\n    }\n}\n\nabstract class PanelTestCase extends TestCase\n{\n    use OpensPanels;\n}\n";
    let mut p = project("tests/OpensPanels.php", concern);
    assert_eq!(
        p.definition("tests/OpensPanels.php", concern).expect("handled"),
        [target("tests/TestCase.php", 10, "loginAs")]
    );
    // The trait's own members still resolve.
    let own = concern.replace("$this->login/*|*/As('ann');", "$this->op/*|*/en();");
    assert_eq!(
        p.definition("tests/OpensPanels.php", &own).expect("handled"),
        [target("tests/OpensPanels.php", 5, "open")]
    );
    // A trait nothing uses: unknown members stay unknown.
    let unused = concern.replace("    use OpensPanels;\n", "");
    let mut p = project("tests/OpensPanels.php", &unused);
    assert_eq!(p.definition("tests/OpensPanels.php", &unused).expect("handled"), []);
}
