const api = (body, status = 200) => Response.json(body, {status, headers:{'Cache-Control':'no-store'}});
const configured = env => Boolean(env.ALPACA_KEY_ID && env.ALPACA_SECRET_KEY);
async function market(env, path, query) {
  const response = await fetch('https://data.alpaca.markets/v2/stocks/SPY/' + path + '?' + new URLSearchParams(query), {
    headers:{'APCA-API-KEY-ID':env.ALPACA_KEY_ID,'APCA-API-SECRET-KEY':env.ALPACA_SECRET_KEY},
    signal:AbortSignal.timeout(7000),
  });
  if (!response.ok) throw new Error('Market data provider returned HTTP ' + response.status + ' for ' + query.feed + '.');
  return response.json();
}
async function ledger(env) {
  const rows = await env.DB.prepare('SELECT payload FROM paper_runs ORDER BY slot').all();
  return rows.results.map(row => JSON.parse(row.payload));
}
async function slotPrices(env, slot) {
  const feed = feedAt(slot);
  const end = slot + (hold + 2) * minute;
  const result = await market(env, 'bars', {feed, timeframe:'1Min', adjustment:'raw', limit:'200',
    start:new Date(slot - 60 * minute).toISOString(), end:new Date(end).toISOString()});
  const bars = (result.bars || []).filter(bar => Number.isFinite(bar.o) && bar.o > 0);
  return pricesForSlot(bars,slot,feed);
}
async function backtest(env, now) {
  const runs = [];
  const slots = slotsBetween(now - 7 * day, now - (hold + 2) * minute);
  for (let i = 0; i < slots.length; i += 5) {
    const group = await Promise.all(slots.slice(i,i+5).map(slot => slotPrices(env,slot)));
    for (const prices of group) runs.push(settlePrices(prices,runs));
  }
  return runs;
}
async function reconcile(env, history, now) {
  const known = new Set(history.map(run => run.slot));
  const activation = Math.max(launch, Date.parse(env.MARKET_ACTIVE_FROM || new Date(now).toISOString()));
  if (!Number.isFinite(activation)) throw new Error('MARKET_ACTIVE_FROM must be an ISO timestamp.');
  const cutoff = now - (hold + 2) * minute;
  const due = scheduledSlotsBetween(Math.max(activation, now - 7 * day), cutoff).filter(slot => !known.has(slot));
  for (const slot of due) {
    const prices = await slotPrices(env,slot);
    if (!prices.complete && now < prices.end + 20 * minute) continue;
    const run = settlePrices(prices,history);
    const inserted = await env.DB.prepare('INSERT OR IGNORE INTO paper_runs (slot, payload) VALUES (?, ?)').bind(slot, JSON.stringify(run)).run();
    if (inserted.meta.changes) history.push(run);
    else {
      const existing = await env.DB.prepare('SELECT payload FROM paper_runs WHERE slot = ?').bind(slot).first();
      if (existing) history.push(JSON.parse(existing.payload));
    }
  }
}
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (Object.hasOwn(assets,path) && request.method === 'GET') {
      return new Response(assets[path], {headers:{'Content-Type':({'/':'text/html','/style.css':'text/css','/app.js':'text/javascript'})[path] + '; charset=utf-8'}});
    }
    if (path === '/api/status' && request.method === 'GET') {
      if (!configured(env)) return api({configured:false,runs:[]});
      try {
        return api({configured:true,armed:Boolean(env.MARKET_ACTIVE_FROM),runs:await ledger(env)});
      } catch {
        return api({configured:true,error:'The trade ledger is unavailable.',runs:[]}, 503);
      }
    }
    if (path === '/api/backtest' && request.method === 'GET') {
      if (!configured(env)) return api({error:'Historical market data is disconnected.'}, 503);
      try {
        const end = Date.now();
        return api({end,runs:await backtest(env,end)});
      } catch {
        return api({error:'Historical market data is unavailable.'}, 503);
      }
    }
    if (path === '/api/plan-bars' && request.method === 'GET') {
      if (!configured(env)) return api({error:'Market feed disconnected.'}, 503);
      try {
        const now = Date.now();
        const feed = feedAt(now);
        const {bars} = await market(env, 'bars', {feed, timeframe:'1Min', adjustment:'raw', limit:'100',
          start:new Date(now - 60 * minute).toISOString(), end:new Date(now).toISOString()});
        return api({feed,bars:(bars || []).filter(bar => Number.isFinite(bar.c) && bar.c > 0).slice(-30)});
      } catch (error) {
        return api({error:error.message}, 503);
      }
    }
    if (path === '/api/quote' && request.method === 'GET') {
      if (!configured(env)) return api({error:'Market feed disconnected.'}, 503);
      try {
        const feed = feedAt(Date.now());
        const {trade} = await market(env, 'trades/latest', {feed});
        if (!trade || !Number.isFinite(trade.p)) return api({error:'No market trade returned.'}, 503);
        return api({price:trade.p,time:trade.t,feed});
      } catch (error) {
        return api({error:error.message}, 503);
      }
    }
    if (path === '/api/run' && request.method === 'POST') {
      if (!configured(env) || !env.MARKET_ACTIVE_FROM) return api({error:'Market data and activation time are required.'}, 503);
      try {
        const history = await ledger(env);
        await reconcile(env, history, Date.now());
        return api({runs:await ledger(env)});
      } catch (error) {
        return api({error:error.message}, 503);
      }
    }
    return api({error:'Route unavailable.'}, 404);
  },
};

export {day, hold, launch, minute, settlePrices, slotPrices, scheduledSlotsBetween, market, signals};
