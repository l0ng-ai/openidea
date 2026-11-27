import os
from datetime import date

import pytest

from tasks import Priority, TaskList


def test_pending_is_sorted_by_priority():
    tasks = TaskList()
    tasks.add("low", Priority.LOW)
    tasks.add("high", Priority.HIGH)
    assert [t.title for t in tasks.pending()] == ["high", "low"]


def test_complete_and_overdue():
    tasks = TaskList()
    tasks.add("late", Priority.NORMAL, date(2020, 1, 1))
    assert [t.title for t in tasks.overdue(date(2024, 1, 1))] == ["late"]
    tasks.complete("late")
    assert tasks.overdue(date(2024, 1, 1)) == []


@pytest.mark.parametrize(
    ("title", "expected"),
    [("write docs", "write docs"), ("  padded  ", "padded"), ("v1.2 notes", "v1.2 notes")],
)
def test_add_strips_titles(title, expected):
    assert TaskList().add(title).title == expected


def test_rejects_empty_titles():
    with pytest.raises(ValueError):
        TaskList().add("   ")


def test_tags():
    tasks = TaskList()
    tasks.add("a", Priority.LOW, None, "x", "y")
    tasks.add("b", Priority.LOW, None, "y")
    assert len(tasks.by_tag("y")) == 2


@pytest.mark.skipif(not os.environ.get("OPENIDEA_FAIL"), reason="set OPENIDEA_FAIL=1 to run")
def test_intentionally_failing():
    # FIXME: wrong on purpose (QA: failing test in the test tree)
    assert len(TaskList()) == 1
