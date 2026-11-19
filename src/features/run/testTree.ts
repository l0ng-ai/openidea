/** Context key: the test results tree has focus. */
export const TEST_TREE_FOCUS = "testTreeFocus";

/** Set while a test results tree is shown: Expand All / Collapse All / Export Test Results act on it. */
export const testTree: {
  expandAll: (() => void) | null;
  collapseAll: (() => void) | null;
  /** Null while the run is in progress or has no results. */
  exportResults: (() => void) | null;
} = {
  expandAll: null,
  collapseAll: null,
  exportResults: null,
};
