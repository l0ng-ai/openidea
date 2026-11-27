import pytest

from tasks import Priority


class TestPending:
    @pytest.fixture
    def tasks(self, tasks):
        # Overrides the conftest.py fixture of the same name.
        tasks.add("review", Priority.NORMAL)
        return tasks

    def test_counts_the_extra_task(self, tasks):
        assert len(tasks.pending()) == 1


@pytest.mark.usefixtures("sample")
def test_sample_is_sorted(sample, request, tmp_path):
    assert [t.title for t in sample.pending()] == ["write docs", "tidy up"]
    assert request.getfixturevalue("tasks") is sample
    assert tmp_path.is_dir()
