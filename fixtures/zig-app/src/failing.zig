//! Fails on purpose: the `test-failing` step, for checking that a run's failure shows up
//! in the test tree and Rerun Failed Tests re-runs it alone.
test "intentionally fails" {
    return error.OpenideaFail;
}
