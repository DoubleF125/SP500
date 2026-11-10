import {createServer} from 'node:http';
import {day, market, minute, scheduledSlotsBetween, signals} from '../dist/server/index.js';

const ledgerUrl = 'https://raw.githubusercontent.com/DoubleF125/SP500/paper-ledger/ledger.json';
const feed = 'IEX';
let cached;
let request;

async function calculate(now) {
  if (!process.env.ALPACA_KEY_ID || !process.env.ALPACA_SECRET_KEY) {
    return {status:'unconfigured',feed};
  }
  try {
    const {bars} = await market(process.env, 'bars', {
      feed:'iex',timeframe:'1Min',adjustment:'raw',limit:'100',
      start:new Date(now - 60 * minute).toISOString(),end:new Date(now).toISOString(),
    });
    const recent = (bars ?? []).filter(bar =>
      Date.parse(bar.t) + minute <= now &&
      [bar.c,bar.h,bar.l,bar.v].every(value => Number.isFinite(value) && value > 0)
    ).sort((a,b) => Date.parse(a.t) - Date.parse(b.t)).slice(-30);
    const asOf = Date.parse(recent.at(-1)?.t) + minute;
    if (recent.length < 21 || now - asOf > 3 * minute) return {status:'waiting',feed};

    const response = await fetch(ledgerUrl,{signal:AbortSignal.timeout(7000),cache:'no-cache'});
    if (!response.ok) throw new Error('Paper ledger unavailable.');
    const {runs} = await response.json();
    if (!Array.isArray(runs)) throw new Error('Invalid paper ledger.');
    const windows = scheduledSlotsBetween(now + 1,now + 5 * day).slice(0,4).map(slot => {
      const {directions,groups} = signals(recent,runs,slot);
      return {slot,directions,groups};
    });
    return {status:'live',feed,asOf,windows};
  } catch (error) {
    const status = /Market data provider returned HTTP (\d{3})/.exec(error.message)?.[1];
    return {status:'unavailable',feed,reason:status ? 'provider_http_' + status : 'preview_calculation_failed'};
  }
}

async function preview(now) {
  if (cached && now < cached.until) return cached.result;
  if (!request) {
    request = calculate(now).then(result => {
      cached = {result,until:Math.min(Date.now() + 8000,result.windows?.[0]?.slot ?? Infinity)};
      return result;
    }).finally(() => { request = null; });
  }
  return request;
}

createServer(async (req,res) => {
  const path = new URL(req.url,'http://localhost').pathname;
  const get = req.method === 'GET';
  const headers = {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'};
  if (path === '/preview') headers['Access-Control-Allow-Origin'] = 'https://doublef125.github.io';
  const found = get && (path === '/preview' || path === '/healthz');
  res.writeHead(found ? 200 : 404,headers);
  const body = !found ? {error:'Not found'} : path === '/healthz' ? {ok:true} : await preview(Date.now());
  res.end(JSON.stringify(body));
}).listen(Number(process.env.PORT || 10000),'0.0.0.0');
