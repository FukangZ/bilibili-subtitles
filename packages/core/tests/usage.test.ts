import assert from "node:assert/strict";
import { test } from "node:test";
import { addUsage, zeroUsage, type Usage } from "@fukangz/core-bilibili-subtitles";

function usage(): Usage {
  return { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, totalTokens: 14 };
}

test("未报告的费用和推理详情保持未知，而不是伪造为零", () => {
  assert.deepEqual(zeroUsage(), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
  const left = usage();
  assert.equal(addUsage(undefined, undefined), undefined);
  assert.equal(addUsage(left, undefined), left);
  assert.equal(addUsage(undefined, left), left);
  assert.deepEqual(addUsage(left, usage()), { input: 4, output: 6, cacheRead: 8, cacheWrite: 10, totalTokens: 28 });
  const right: Usage = { ...usage(), reasoning: 0, cacheWrite1h: 0, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } };
  assert.deepEqual(addUsage(left, right), addUsage(left, left));
  assert.deepEqual(addUsage(right, right), { input: 4, output: 6, cacheRead: 8, cacheWrite: 10, totalTokens: 28,
    reasoning: 0, cacheWrite1h: 0, cost: { input: 2, output: 4, cacheRead: 6, cacheWrite: 8, total: 20 } });
  assert.equal(right.cost?.total, 10);
});
