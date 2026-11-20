'use strict';

/**
 * Run `worker` over `items` with a bounded number of concurrent executions.
 * Results preserve input order.
 */
async function pool(items, worker, concurrency = 4) {
  const size = Math.max(1, Math.min(Number(concurrency) || 1, items.length || 1));
  const results = new Array(items.length);
  let cursor = 0;

  const runners = new Array(size).fill(0).map(async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

module.exports = { pool };
