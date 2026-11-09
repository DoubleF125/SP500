const el = id => document.getElementById(id);
const usd = new Intl.NumberFormat('en-US', {style:'currency',currency:'USD'});
const percent = new Intl.NumberFormat('en-US', {style:'percent',signDisplay:'exceptZero',minimumFractionDigits:2,maximumFractionDigits:3});
const timestamp = new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Berlin',dateStyle:'medium',timeStyle:'medium'});
const sum = trades => round(trades.reduce((total,trade) => total + trade.pnl,0));
const pnlStyle = value => value > 0 ? 'positive' : value < 0 ? 'negative' : 'neutral';
const balance = trades => ((state.mode === 'market' && state.error) || (state.mode === 'fiction' && !fictional.source)) ? '—' : usd.format(capital + sum(trades));
const returnLabel = value => '<span class="num ' + pnlStyle(value) + '">' + percent.format(value / capital) + '</span>';
const offline = document.documentElement.dataset.offline === 'true';
const scheduledLedger = document.documentElement.dataset.ledger;
const state = {mode:'market',period:'all',session:'all',runs:[],configured:false,detail:null,quote:null,error:null,quoteError:null,armed:false};

const fictional = {runs:[],end:0,source:'',loading:false,error:'',selectedDay:'all'};
const shortDate = new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Berlin',day:'numeric',month:'short'});
const berlinDate = new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit'});
function completeRuns(runs, now) {
  return runs.filter(run => run.slot <= now && (run.status !== 'settled' || run.trades[0]?.exitTime <= now));
}
async function refreshFictional() {
  if (fictional.loading) return;
  if (fictional.source === 'imported') {render();return;}
  fictional.end = Date.now();
  if (offline) {render();return;}
  fictional.error = '';
  fictional.loading = true;
  render();
  try {
    const response = await fetch('/api/backtest',{signal:AbortSignal.timeout(30000)});
    if (!response.ok) return;
    const data = await response.json();
    if (fictional.source === 'imported') return;
    fictional.end = Math.min(data.end,Date.now());
    fictional.runs = completeRuns(data.runs,fictional.end).filter(run => run.slot >= fictional.end - 7 * day);
    fictional.source = 'historical';
  } catch {
    // The interface reports an unavailable feed until historical data can be loaded.
  } finally {
    fictional.loading = false;
    if (state.mode === 'fiction') {
      render();
      if (state.detail !== null) renderDetails(state.detail);
    }
  }
}

function importPrices(csv, now) {
  const lines = csv.trim().split(/\r?\n/);
  const cells = line => line.split(',').map(value => value.trim().replace(/^"|"$/g,''));
  const header = cells(lines.shift()).map(value => value.toLowerCase());
  const fields = ['timestamp','open','high','low','close','volume'].map(field => header.indexOf(field));
  if (fields.includes(-1)) throw new Error('The CSV needs timestamp, open, high, low, close and volume columns.');
  const symbol = header.indexOf('symbol');
  const bars = [];
  const seen = new Set();
  for (const line of lines) {
    if (!line.trim()) continue;
    const row = cells(line);
    if (symbol >= 0 && row[symbol]?.toUpperCase() !== 'SPY') continue;
    const [stamp, ...prices] = fields.map(i => row[i]);
    const time = Date.parse(stamp);
    const [o,h,l,c,v] = prices.map(Number);
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(stamp) || !Number.isFinite(time) || time % minute ||
        prices.some(value => !value) || ![o,h,l,c,v].every(Number.isFinite) ||
        Math.min(o,h,l,c) <= 0 || h < Math.max(o,c,l) || l > Math.min(o,c,h) || v < 0) {
      throw new Error('A row has an invalid minute timestamp, price, or volume.');
    }
    if (time >= now || time < now - 7 * day - 60 * minute) continue;
    if (seen.has(time)) throw new Error('Use only one SPY price row per minute.');
    seen.add(time);
    bars.push({t:new Date(time).toISOString(),o,h,l,c,v});
  }
  if (!bars.length) throw new Error('No past SPY minute prices found for the last seven days.');
  bars.sort((a,b) => a.t.localeCompare(b.t));
  const runs = [];
  for (const slot of slotsBetween(now - 7 * day,now - (hold + 2) * minute)) {
    runs.push(settlePrices(pricesForSlot(bars,slot,'CSV'),runs));
  }
  return runs;
}

function scoped(applyPeriod = true, applySession = true) {
  const replay = state.mode === 'fiction';
  const now = Date.now();
  const runs = completeRuns(replay ? fictional.runs : state.runs,now);
  const start = !replay && applyPeriod && state.period !== 'all' ? now - Number(state.period) * day : 0;
  return runs.filter(run => (run.trades?.[0]?.exitTime ?? run.slot + hold * minute) > start &&
    (!replay || !applyPeriod || fictional.selectedDay === 'all' || berlinDate.format(run.slot) === fictional.selectedDay) &&
    (!applySession || state.session === 'all' || slotLabel(run.slot) === state.session));
}
function tradesFor(runs, index) {
  return runs.filter(run => run.status === 'settled' && run.trades[index]?.side).map(run => ({...run.trades[index],slot:run.slot,feed:run.feed,samples:run.trainingSamples,score:run.ensembleScore}));
}
const periodNames = {'1':'Last day','7':'Last week',all:'Since Nov 9, 2026'};
const timeName = time => sessions.find(session => session.time === time)?.label;
const countTrades = count => count + (count === 1 ? ' trade' : ' trades');
function selectionLabel() {
  const time = state.session === 'all' ? 'All three times' : timeName(state.session) + ' · ' + state.session;
  if (state.mode === 'fiction') return (fictional.selectedDay === 'all' ? 'Past 7 days' : fictional.selectedDay) + ' · ' + time;
  return periodNames[state.period] + ' · ' + time;
}
function render() {
  const replay = state.mode === 'fiction';
  for (const [id,active] of [['market',!replay],['fiction',replay]]) {
    el(id).setAttribute('aria-pressed',String(active));
  }
  el('period-filter').hidden = replay;
  el('history-input').hidden = !replay;
  el('history-day-filter').hidden = !replay || !fictional.runs.length;
  if (replay) {
    const days = [...new Set(fictional.runs.map(run => berlinDate.format(run.slot)))];
    const picker = el('history-day');
    picker.innerHTML = '<option value="all">All days</option>' + days.map(date => '<option>' + date + '</option>').join('');
    if (!days.includes(fictional.selectedDay)) fictional.selectedDay = 'all';
    picker.value = fictional.selectedDay;
  }
  const range = replay ? shortDate.format(fictional.end - 7 * day) + '–' + shortDate.format(fictional.end) : '';
  el('notice').textContent = replay
    ? fictional.error || (fictional.loading ? 'Loading historical SPY prices…' : fictional.source
      ? range + ' · Hypothetical trades using ' + (fictional.source === 'imported' ? 'your imported SPY prices' : 'historical SPY prices') +
        '. ' + fictional.runs.filter(run => run.status === 'skipped').length + ' windows skipped for missing prices.'
      : 'No historical prices available. Import a SPY minute-price CSV to run the backtest.')
    : state.error || (scheduledLedger
      ? state.armed ? 'Paper results use recorded SPY minute bars and update after each window.' : 'Scheduled paper trading is waiting for its first data run.'
      : state.configured
      ? state.armed ? 'Market results update as paper trades close.' : 'Market prices are connected. Paper trading is awaiting activation.'
      : 'No paper trades recorded. The live SPY feed is disconnected.');
  el('selection').textContent = selectionLabel();
  el('reset').hidden = (replay ? fictional.selectedDay === 'all' : state.period === 'all') && state.session === 'all';
  for (const type of ['period','session']) {
    for (const button of el(type).querySelectorAll('button')) {
      button.setAttribute('aria-pressed',String(state[type] === button.dataset.value));
    }
  }
  const selected = scoped();
  const all = scoped(false,false);
  const rankings = tactics.map((tactic,index) => {
    const trades = tradesFor(selected,index);
    const total = tradesFor(all,index);
    return {tactic,index,trades,pnl:sum(trades),total};
  }).sort((a,b) => Number(Boolean(b.trades.length)) - Number(Boolean(a.trades.length)) || b.pnl - a.pnl || a.index - b.index);
  const focusedIndex = document.activeElement?.closest('#rankings [data-id]')?.dataset.id;
  let rank = 0;
  el('rankings').innerHTML = rankings.map((row,i) => {
    if (!i || row.pnl !== rankings[i-1].pnl) rank = i+1;
    const [, label, type] = row.tactic;
    const hasResult = row.trades.length > 0;
    const fresh = state.mode === 'market' && !state.error && !row.total.length;
    const summary = hasResult ? countTrades(row.trades.length) : fresh ? '0 completed trades' : 'No trades in this view';
    return '<li><button type="button" class="strategy-row" data-id="' + row.index + '"><span class="rank" aria-hidden="true">' +
      (hasResult ? String(rank).padStart(2,'0') : '·') + '</span><span class="strategy-label"><b>' + label + '</b>' +
      (type === 'Mix' ? '<span class="mix">Mix</span>' : '') + '<small>' + summary + '</small></span><span class="result">' +
      (hasResult || fresh ? returnLabel(row.pnl) : '<span class="neutral">—</span>') +
      '</span><span class="balance" aria-label="Account balance ' + balance(row.total) + '">' + balance(row.total) +
      '</span><span class="open" aria-hidden="true">›</span></button></li>';
  }).join('');
  if (focusedIndex !== undefined) el('rankings').querySelector('[data-id="' + focusedIndex + '"]')?.focus({preventScroll:true});
  renderQuote();
}
function renderQuote() {
  const quote = state.quote;
  el('quote').hidden = state.mode !== 'market' || !state.configured;
  el('price').textContent = quote ? usd.format(quote.price) : '—';
  el('quote-note').textContent = state.quoteError || (quote
    ? 'Last reported ' + timestamp.format(Date.parse(quote.time)) + ' Berlin'
    : 'Waiting for a market price');
}
function curve(trades) {
  if (!trades.length) return '';
  const points = [0];
  for (const trade of trades) points.push(points.at(-1)+trade.pnl);
  const low = Math.min(...points);
  const span = Math.max(0.01,Math.max(...points)-low);
  const coords = points.map((value,i) => (10 + 580*i/(points.length-1)).toFixed(2) + ',' + (84-68*(value-low)/span).toFixed(2));
  return '<svg class="trace" viewBox="0 0 600 100" preserveAspectRatio="none" role="img" aria-label="Cumulative realized paper profit and loss"><polyline points="' + coords.join(' ') + '" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>';
}
const plan = {timer:null, input:null, request:null, retryAt:0};
const nextSlot = now => slotsBetween(now + 1, now + 5 * day)[0];

async function refreshPlanBars(now, feed) {
  if (plan.request || now < plan.retryAt) return;
  if (plan.input?.feed === feed && now - plan.input.received < 15000) return;
  plan.retryAt = now + 5000;
  plan.request = (async () => {
    try {
      const response = await fetch('/api/plan-bars', {signal:AbortSignal.timeout(8000)});
      if (!response.ok) return;
      const data = await response.json();
      plan.input = {...data,received:Date.now()};
    } catch {
      // Freshness checks below hide the estimate if the input cannot be refreshed.
    } finally {
      plan.request = null;
    }
  })();
}

function marketPlan(now, slot) {
  if (!state.configured || offline) return null;
  const feed = feedAt(now);
  refreshPlanBars(now,feed);
  const input = plan.input;
  const quote = state.quote;
  const observed = Date.parse(quote?.time);
  if (!input || input.feed !== feed || now - input.received > 45000 || !quote || quote.feed !== feed ||
      !Number.isFinite(observed) || observed > now || now - observed > 60000 || state.quoteError) return null;
  const price = quote.price;
  const bucket = Math.floor(observed / minute) * minute;
  const bars = input.bars.filter(bar => Date.parse(bar.t) <= bucket).slice(-30);
  const last = bars.at(-1);
  const lastTime = Date.parse(last?.t);
  if (bars.length < 21 || !Number.isFinite(lastTime) || bucket - lastTime > 5 * minute) return null;
  if (bucket === lastTime) {
    bars[bars.length-1] = {...last,c:price,h:Math.max(last.h,price),l:Math.min(last.l,price)};
  } else {
    bars.push({t:new Date(bucket).toISOString(),o:price,h:price,l:price,c:price,v:0});
  }
  return {slot,bars:bars.slice(-30),history:state.runs,price,observed};
}

function updatePlan() {
  if (state.detail === null || state.mode === 'fiction' || document.hidden) return;
  const now = Date.now();
  const slot = nextSlot(now);
  const estimate = marketPlan(now,slot);
  const when = estimate?.slot ?? slot;
  el('plan-time').textContent = timestamp.format(when) + ' Berlin time';
  el('plan-source').textContent = 'MARKET PREVIEW · CHECKS EVERY SECOND';
  const decision = el('plan-decision');
  if (!estimate) {
    const message = state.configured && !offline ? 'Waiting for fresh prices' : 'Market feed disconnected';
    if (decision.textContent !== message) decision.textContent = message;
    decision.className = '';
    el('plan-detail').textContent = offline || !state.configured
      ? scheduledLedger ? 'This view lists the next scheduled window. Results are calculated after the window closes.'
        : 'Waiting for a connected SPY feed. This is a scheduled window only.'
      : 'A move appears once there are enough recent SPY prices.';
    return;
  }
  const evaluation = signals(estimate.bars,estimate.history,estimate.slot);
  const side = evaluation.directions[state.detail];
  const message = side === 1 ? 'Bet up' : side === -1 ? 'Bet down' : 'Sit out';
  if (decision.textContent !== message) decision.textContent = message;
  decision.className = side === 1 ? 'positive' : side === -1 ? 'negative' : 'neutral';
  const rules = evaluation.groups[state.detail - baseCount];
  el('plan-detail').textContent = 'Last reported price ' + usd.format(estimate.price) +
    ' · ' + timestamp.format(estimate.observed) + ' Berlin' + (rules ? ' · ' + mixNames(rules) : '');
}

function renderDetails(index) {
  const [,label,type,description,schedule] = tactics[index];
  const runs = scoped();
  const trades = tradesFor(runs,index);
  const byTime = tradesFor(scoped(true,false),index);
  const noSignal = runs.filter(run => run.status === 'settled' && run.trades[index]?.side === 0).length;
  const skipped = runs.filter(run => run.status === 'skipped').length;
  const slots = sessions.map(session => {
    const atTime = byTime.filter(trade => slotLabel(trade.slot) === session.time);
    return '<div><span>' + session.label + ' · ' + session.time + '</span><b>' +
      (atTime.length ? returnLabel(sum(atTime)) : '—') + '</b><small>' + countTrades(atTime.length) + '</small></div>';
  }).join('');
  const cards = trades.slice().reverse().map(trade => {
    const isUp = trade.side === 1;
    const fill = (label,time,price) => '<div><dt>' + label + '</dt><dd>' + (Number.isFinite(price) ? usd.format(price) : '') + '<small>' +
      timestamp.format(time) + '</small></dd></div>';
    return '<li class="trade"><div class="trade-title"><b>' + slotLabel(trade.slot) + ' · Bet ' + (isUp?'up':'down') +
      '</b>' + returnLabel(trade.pnl) + '</div><dl>' +
      fill(isUp?'Bought':'Sold to open',trade.entryTime,trade.entry) +
      fill(isUp?'Sold':'Bought back',trade.exitTime,trade.exit) + '</dl>' +
      (trade.rules?.length ? '<p class="subtle">Rules used · ' + mixNames(trade.rules) + '</p>' : '') +
      '<p class="subtle">' + (Number.isFinite(trade.quantity)
        ? trade.quantity.toFixed(5) + ' shares · ' + usd.format(trade.fees) + ' in costs · ' : 'Calculated from historical minute bars · ') +
      trade.feed.toUpperCase() + '</p></li>';
  }).join('');
  el('detail-body').innerHTML = '<p class="eyebrow">' + (type === 'Mix' ? 'STRATEGY MIX' : 'BASIC STRATEGY') + ' · ' +
    (state.mode === 'fiction' ? 'HISTORICAL BACKTEST' : 'MY RESULTS') + '</p><h2 id="detail-title">' + label +
    '</h2>' + (state.mode === 'fiction' ? '' : '<section class="plan-card" aria-labelledby="plan-heading"><div class="plan-head"><h3 id="plan-heading">Next planned move</h3>' +
    '<span id="plan-source" class="plan-source"></span></div><strong id="plan-decision" role="status"></strong><p id="plan-time"></p>' +
    '<p id="plan-detail"></p><p class="plan-note">Preview only. The strategy decides at the scheduled time using the data available then.</p></section>') +
    '<p class="subtle">' + description + '</p>' + (schedule ? '<ul class="rules"><li>' + schedule.join('</li><li>') + '</li></ul>' : '') +
    '<div class="detail-total"><div><b>Profit or loss (%)</b><small>' + selectionLabel() + '</small></div><strong>' +
    (trades.length ? returnLabel(sum(trades)) : '—') + '</strong><div class="detail-balance"><small>Account balance</small><strong>' +
    balance(tradesFor(scoped(false,false),index)) + '</strong></div></div>' +
    '<h3>Compare times <small>In this period</small></h3><div class="detail-metrics">' + slots + '</div>' +
    '<h3>Trade history <small>Berlin time</small></h3>' +
    (cards ? '<ol class="trade-list">' + cards + '</ol>' : '<p class="empty">No completed trades in this view.</p>') +
    '<details class="extra"><summary>More about these results</summary>' + curve(trades) + '<p class="subtle">' +
    noSignal + ' windows had no signal. ' + skipped + ' windows had too little market data.</p></details>';
}
for (const type of ['period','session']) {
  el(type).addEventListener('click',event => {
    const button = event.target.closest('button');
    if (!button) return;
    state[type] = button.dataset.value;
    render();
  });
}
el('reset').addEventListener('click',() => {
  if (state.mode === 'fiction') fictional.selectedDay = 'all';
  else state.period = 'all';
  state.session = 'all';
  render();
  el(state.mode === 'fiction' ? 'session' : 'period').querySelector('[data-value="all"]').focus();
});
for (const mode of ['market','fiction']) el(mode).addEventListener('click',() => {
  state.mode = mode;
  if (mode === 'fiction') {
    if (fictional.loading) render();
    else refreshFictional();
    return;
  }
  render();
  if (mode === 'market' && (!offline || scheduledLedger)) refreshLedger();
});
el('history-day').addEventListener('change',event => {
  fictional.selectedDay = event.target.value;
  render();
});
el('history-file').addEventListener('change',async event => {
  const input = event.target;
  const file = input.files[0];
  if (!file) return;
  try {
    if (file.size > 5_000_000) throw new Error('Choose a CSV smaller than 5 MB.');
    const csv = await file.text();
    const end = Date.now();
    const runs = importPrices(csv,end);
    Object.assign(fictional,{runs,end,source:'imported',error:'',selectedDay:'all'});
  } catch (error) {
    fictional.error = error.message;
  } finally {
    input.value = '';
    render();
  }
});
el('rankings').addEventListener('click',event => {
  const button = event.target.closest('[data-id]');
  if (!button) return;
  state.detail = Number(button.dataset.id);
  renderDetails(state.detail);
  el('detail').showModal();
  updatePlan();
  if (state.mode !== 'fiction') plan.timer = setInterval(updatePlan,1000);
});
el('close-detail').addEventListener('click',() => el('detail').close());
el('detail').addEventListener('close',() => {
  clearInterval(plan.timer);
  plan.timer = null;
  el('rankings').querySelector('[data-id="' + state.detail + '"]')?.focus({preventScroll:true});
  state.detail = null;
});
async function refreshLedger() {
  try {
    const response = await fetch(scheduledLedger || '/api/status', {cache:'no-cache'});
    if (scheduledLedger && response.status === 404 && !state.armed) {render(); return;}
    if (scheduledLedger && !response.ok) throw new Error('Ledger unavailable');
    const payload = await response.json();
    state.configured = Boolean(payload.configured);
    state.armed = Boolean(payload.armed);
    state.error = payload.error || null;
    state.runs = payload.runs || [];
  } catch {
    state.error = 'The market ledger could not be reached.';
  }
  render();
}
async function refreshQuote() {
  let wait = 1000;
  if (state.mode === 'market' && state.configured && !document.hidden) {
    try {
      const response = await fetch('/api/quote');
      const payload = await response.json();
      state.quoteError = payload.error || null;
      if (response.ok) state.quote = payload;
      else wait = 15000;
    } catch {
      state.quoteError = 'Quote refresh failed.';
      wait = 15000;
    }
    renderQuote();
  }
  setTimeout(refreshQuote,wait);
}
render();
if (!offline || scheduledLedger) {
  refreshLedger();
  if (!offline) refreshQuote();
  setInterval(() => {if (state.mode === 'market' && !document.hidden) refreshLedger();},30000);
}
