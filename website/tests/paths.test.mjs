import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBasePath, publicAsset } from "../src/lib/paths.mjs";

test("normalizes both repository Pages and custom-domain roots", () => {
  assert.equal(normalizeBasePath(), "/");
  assert.equal(normalizeBasePath(""), "/");
  assert.equal(normalizeBasePath("/openidea"), "/openidea/");
  assert.equal(normalizeBasePath("/openidea/"), "/openidea/");
});

test("keeps public media under the deployed repository prefix", () => {
  assert.equal(publicAsset("media/debug.jpg", "/openidea/"), "/openidea/media/debug.jpg");
  assert.equal(publicAsset("/media/debug.jpg", "/openidea"), "/openidea/media/debug.jpg");
  assert.equal(publicAsset("media/debug.jpg", "/"), "/media/debug.jpg");
});
