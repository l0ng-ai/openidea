/** Context key: the test results tree has focus. */
export const TEST_TREE_FOCUS = "testTreeFocus";

/** Set while a test results tree is shown: Expand All / Collapse All act on it. */
export const testTree: { expandAll: (() => void) | null; collapseAll: (() => void) | null } = {
  expandAll: null,
  collapseAll: null,
};
