/** Context key: the test results tree has focus. */
export const TEST_TREE_FOCUS = "testTreeFocus";

/** Actions on the test results tree shown in Run. */
export const testTree: {
  expandAll: (() => void) | null;
  collapseAll: (() => void) | null;
  /** Null while the run is in progress or has no results. */
  exportResults: (() => void) | null;
  showDurations: boolean | null;
  toggleDurations: (() => void) | null;
} = {
  expandAll: null,
  collapseAll: null,
  exportResults: null,
  showDurations: null,
  toggleDurations: null,
};
