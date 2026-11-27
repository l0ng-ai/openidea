//! pytest fixture Find Usages and Rename (`nav_pytest_fixture_usages` / `_rename` / `_target`)
//! on a project on disk: which files are searched, overrides left out, `pytest_plugins`
//! modules, `python_files`, body reads and name clashes.

mod common;

use ide_core::{FileEdit, Pos};
use ide_host::{Host, ops};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

const WINDOW: &str = "main";

struct Opened {
    host: Arc<Host>,
    root: PathBuf,
    _tmp: tempfile::TempDir,
}

const CONFTEST: &str = "\
import pytest

pytest_plugins = [\"tests.fixtures\"]


@pytest.fixture
def tasks():
    return []


@pytest.fixture(name=\"sample\")
def sample_tasks(tasks):
    return tasks
";

const FIXTURES: &str = "\
import pytest


@pytest.fixture
def db():
    return {}
";

const TEST_A: &str = "\
import pytest


class TestOverride:
    @pytest.fixture
    def tasks(self, tasks):
        return tasks + [1]

    def test_own(self, tasks):
        assert tasks


def test_plain(tasks, db):
    done = [tasks for tasks in range(2)]
    assert tasks == [] and db == {} and done


@pytest.mark.usefixtures(\"sample\")
def test_sample(sample, request):
    assert request.getfixturevalue(\"tasks\") is sample
";

const CHECK_B: &str = "\
def test_b(db):
    assert db == {}
";

async fn open() -> Opened {
    let tmp = tempfile::tempdir().unwrap();
    let root = dunce::canonicalize(tmp.path()).unwrap().join("proj");
    let tests = root.join("tests");
    std::fs::create_dir_all(&tests).unwrap();
    std::fs::write(root.join("pytest.ini"), "[pytest]\npython_files = test_*.py check_*.py\n").unwrap();
    std::fs::write(tests.join("__init__.py"), "").unwrap();
    std::fs::write(tests.join("conftest.py"), CONFTEST).unwrap();
    std::fs::write(tests.join("fixtures.py"), FIXTURES).unwrap();
    std::fs::write(tests.join("test_a.py"), TEST_A).unwrap();
    std::fs::write(tests.join("check_b.py"), CHECK_B).unwrap();
    // Not collected by pytest: its `db` parameter is no fixture use.
    std::fs::write(tests.join("helpers.py"), "def helper(db):\n    return db\n").unwrap();

    let app = tmp.path().join("app");
    let host = Arc::new(Host::new(common::host_config(&app)));
    host.trust.decide(&root, true, false).unwrap();
    ops::project::open(&host, WINDOW, &root).await.unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let s = ops::nav::index_status(&host, WINDOW).unwrap();
        if !s.indexing && s.files > 0 {
            break;
        }
        assert!(Instant::now() < deadline, "indexing timed out; status: {s:?}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Opened { host, root, _tmp: tmp }
}

/// 0-based line and UTF-16 column of the first `needle` in `text`, `skip` characters in.
fn pos_of(text: &str, needle: &str, skip: usize) -> Pos {
    let at = text.find(needle).unwrap_or_else(|| panic!("{needle:?} not found")) + skip;
    let line = text[..at].matches('\n').count();
    let col = at - text[..at].rfind('\n').map_or(0, |i| i + 1);
    Pos::new(line as u32, col as u32)
}

fn short(root: &Path, l: &ide_core::Location) -> String {
    let path = l.path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
    format!("{path}:{}", l.range.start.line + 1)
}

fn request() -> ide_core::RequestId {
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);
    ide_core::RequestId(NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn finds_usages_where_pytest_would_inject_the_fixture() {
    let p = open().await;
    let conftest = ops::doc::doc_open(&p.host, WINDOW, p.root.join("tests/conftest.py")).await.unwrap().id;

    // `tasks` from conftest.py: sample_tasks's parameter, the class fixture's overriding
    // parameter, test_plain and getfixturevalue; not test_own, which gets the class fixture.
    let found =
        ops::nav::nav_pytest_fixture_usages(&p.host, WINDOW, conftest, pos_of(CONFTEST, "def tasks", 4), request())
            .await
            .unwrap()
            .unwrap();
    let mut usages: Vec<String> = found.usages.iter().map(|l| short(&p.root, l)).collect();
    usages.sort();
    assert_eq!(usages, ["tests/conftest.py:12", "tests/test_a.py:13", "tests/test_a.py:20", "tests/test_a.py:6"]);

    // `db` lives in a module `pytest_plugins` loads: the whole project is searched, including a
    // `python_files = check_*.py` module, but not helpers.py, which pytest doesn't collect.
    let fixtures = ops::doc::doc_open(&p.host, WINDOW, p.root.join("tests/fixtures.py")).await.unwrap().id;
    let found =
        ops::nav::nav_pytest_fixture_usages(&p.host, WINDOW, fixtures, pos_of(FIXTURES, "def db", 4), request())
            .await
            .unwrap()
            .unwrap();
    let mut usages: Vec<String> = found.usages.iter().map(|l| short(&p.root, l)).collect();
    usages.sort();
    assert_eq!(usages, ["tests/check_b.py:1", "tests/test_a.py:13"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn renames_the_fixture_its_requests_and_their_reads() {
    let p = open().await;
    let test_a = ops::doc::doc_open(&p.host, WINDOW, p.root.join("tests/test_a.py")).await.unwrap().id;

    // Rename starts from a read in a body too: `tasks` in test_plain's assert.
    let at = pos_of(TEST_A, "assert tasks ==", 7);
    let target = ops::nav::nav_pytest_fixture_target(&p.host, WINDOW, test_a, at).await.unwrap().unwrap();
    assert_eq!((target.name.as_str(), short(&p.root, &target.definition)), ("tasks", "tests/conftest.py:7".into()));
    assert!(target.in_project && target.function_name);

    // A clash with another parameter of a requesting function changes nothing.
    let clash = ops::nav::nav_pytest_fixture_rename(&p.host, WINDOW, test_a, at, "db".into(), request()).await.unwrap();
    assert!(clash.edit.files.is_empty());
    assert_eq!(short(&p.root, &clash.clash.unwrap()), "tests/test_a.py:13");

    let renamed =
        ops::nav::nav_pytest_fixture_rename(&p.host, WINDOW, test_a, at, "todo".into(), request()).await.unwrap();
    assert!(renamed.clash.is_none());
    let lines = |file: &str| -> Vec<u32> {
        let edits = renamed.edit.files.iter().find_map(|f| match f {
            FileEdit::Edit { path, edits, .. } if path.ends_with(file) => Some(edits.clone()),
            _ => None,
        });
        let mut lines: Vec<u32> = edits.unwrap_or_default().iter().map(|e| e.range.start.line + 1).collect();
        lines.sort();
        lines
    };
    // conftest.py: the definition, sample_tasks's parameter and its read.
    assert_eq!(lines("tests/conftest.py"), [7, 12, 13]);
    // test_a.py: the overriding parameter and its read, test_plain's parameter and its read
    // (not the comprehension's own `tasks`), and the getfixturevalue string; not test_own's.
    assert_eq!(lines("tests/test_a.py"), [6, 7, 13, 15, 20]);
}
