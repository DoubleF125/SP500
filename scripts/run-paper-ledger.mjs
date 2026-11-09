import {readFile, writeFile} from 'node:fs/promises';
import {day, hold, launch, minute, settlePrices, slotPrices, scheduledSlotsBetween} from '../dist/server/index.js';

import {benchmarkHistory} from './benchmark-history.mjs';

const path = process.argv[2];
if (!path) throw new Error('Supply a paper ledger JSON path.');
if (!process.env.ALPACA_KEY_ID || !process.env.ALPACA_SECRET_KEY) {
  throw new Error('Add both Alpaca repository secrets before running the ledger.');
}
const activation = Math.max(launch, Date.parse(process.env.MARKET_ACTIVE_FROM ?? ''));
if (!Number.isFinite(activation)) throw new Error('MARKET_ACTIVE_FROM must be an ISO timestamp.');

const previous = await readFile(path, 'utf8').then(JSON.parse).catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return {runs:[]};
});
const runs = previous.runs;
if (!Array.isArray(runs)) throw new Error('Existing paper ledger is invalid.');

const now = Date.now();
const cutoff = now - (hold + 2 + 15) * minute;
const known = new Set(runs.map(run => run.slot));
const due = scheduledSlotsBetween(Math.max(activation, now - 7 * day), cutoff).filter(slot => !known.has(slot));
let added = 0;
let failures = 0;
for (const slot of due) {
  let prices;
  try {
    prices = await slotPrices(process.env, slot);
  } catch (error) {
    failures++;
    console.warn(new Date(slot).toISOString() + ' · ' + error.message);
    continue;
  }
  if (!prices.complete && now < prices.end + 20 * minute) continue;
  const result = settlePrices(prices, runs);
  if (result.trades) {
    // Publish simulated outcomes only. Keep provider price, volume and fill-size data out of the public branch.
    result.trades = result.trades.map(({side, pnl, rules, entryTime, exitTime}) =>
      ({side, pnl, rules, entryTime, exitTime}));
  }
  runs.push(result);
  added++;
}
const oldBenchmark = previous.benchmark ?? [];
const benchmark = await benchmarkHistory(process.env,now,oldBenchmark).catch(error => {
  console.warn('Benchmark could not refresh: ' + error.message);
  return oldBenchmark;
});
const benchmarkChanged = JSON.stringify(benchmark) !== JSON.stringify(oldBenchmark);
if (!added && !benchmarkChanged && failures) throw new Error('No due sessions could be published. Check the data feed and retry.');
if (added || benchmarkChanged) {
  runs.sort((a, b) => a.slot - b.slot);
  await writeFile(path, JSON.stringify({armed:true,runs,benchmark}) + '\n');
}
console.log(`Paper ledger added ${added} session(s); ${failures} provider error(s) remain eligible for retry.`);
