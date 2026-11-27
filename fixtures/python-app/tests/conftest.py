import pytest

from tasks import Priority, TaskList


@pytest.fixture
def tasks():
    return TaskList()


@pytest.fixture(name="sample")
def sample_tasks(tasks):
    tasks.add("write docs", Priority.HIGH)
    tasks.add("tidy up", Priority.LOW)
    return tasks
