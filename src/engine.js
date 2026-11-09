const minute = 60000;
const day = 1440 * minute;
const capital = 1000;
const hold = 30;
const costRate = 0.0003;
const launch = Date.parse('2026-11-09T12:58:40Z');
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const round = value => Math.round(value * 100) / 100;
const direction = (value, threshold = 0) => Math.abs(value) > threshold ? Math.sign(value) : 0;

const sessions = [
  {time:'08:15', label:'Morning'},
  {time:'15:15', label:'Afternoon'},
  {time:'18:00', label:'Evening'},
];
const tactics = [
  ['long','Always Up','Basic','Bets on SPY going up at each available time.'],
  ['short','Always Down','Basic','Bets on SPY going down at each available time.'],
  ['momentum','Follow the Move','Basic','Follows the latest five-minute move once it is larger than 0.03%.'],
  ['fade','Bet on a Rebound','Basic','Bets that a five-minute move larger than 0.05% will reverse.'],
  ['cross','Follow the Trend','Basic','Follows the direction indicated by the last 5 and 20 prices.'],
  ['range','Break Out of the Range','Basic','Follows price when it breaks above or below its recent ten-bar range.'],
  ['vwap','Back to the Average','Basic','Looks for a return toward the recent average price, giving busier minutes more weight.'],
  ['rsi','When the Move Looks Stretched','Basic','Looks for a reversal when most of the last 14 price changes go one way.'],
  ['volume','Follow a Busy Move','Basic','Follows a five-minute move when the most recent minute was unusually busy.'],
  ['volatility','Follow a Fast Move','Basic','Follows a five-minute move when prices are moving faster than usual.'],
  ['vote','Group Vote','Basic','Trades when at least three more technical rules favor one direction than the other.'],
  ['adaptive','Learning Vote','Basic','Gives more weight to rules that worked in up to 30 earlier windows at the same time of day.'],
];
const baseCount = tactics.length;
const playbook = [6, 8, 2];
const consensus = [[3,6,7], [2,5,8], [2,4,9]];
const confirmed = [[6,11], [5,8], [4,10]];
const mixNames = indexes => indexes.map(index => tactics[index][1]).join(' + ');
const timetable = groups => groups.map((indexes, index) => sessions[index].time + ' · ' + mixNames(indexes));
tactics.push(
  ['playbook','One Rule per Time','Mix','Uses a different rule at each of the three times.',timetable(playbook.map(index => [index]))],
  ['consensus','Time-of-Day Vote','Mix','Changes the voting group by time of day. Two of three rules must agree.',timetable(consensus)],
  ['confirmed','Double Check','Mix','Uses two rules at each time. Both must point in the same direction.',timetable(confirmed)],
  ['leader','Recent Winner','Mix','Picks the most profitable basic strategy for that time from up to 20 earlier windows. Requires at least five prior trades and positive net results.', ['Uses One Rule per Time until a qualifying winner is available.']],
  ['top-three','Top Three Vote','Mix','Lets the three strongest qualifying basic strategies vote at each time. Two must agree.', ['Ranks by net results across up to 20 earlier windows for the same time, with at least five prior trades per rule. Uses the Time-of-Day Vote when fewer than three rules qualify.']],
);
const berlin = new Intl.DateTimeFormat('en-GB', {timeZone:'Europe/Berlin',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const ny = new Intl.DateTimeFormat('en-GB', {timeZone:'America/New_York',hour:'2-digit',hourCycle:'h23'});
const slotLabel = time => berlin.format(time);
const feedAt = time => {
  const hour = Number(ny.format(time).slice(0,2));
  return hour < 4 || hour >= 20 ? 'boats' : 'sip';
};
function slotsBetween(start, end) {
  const times = [];
  for (let t = Math.ceil(start / (15 * minute)) * 15 * minute; t <= end; t += 15 * minute) {
    const weekday = new Date(t).getUTCDay();
    if (weekday > 0 && weekday < 6 && sessions.some(session => session.time === slotLabel(t))) times.push(t);
  }
  return times;
}
function signals(bars, history, slot) {
  const close = bars.map(bar => bar.c);
  const last = close.at(-1);
  const momentum = last / close.at(-6) - 1;
  const window = bars.slice(-11,-1);
  const volume = bars.reduce((sum, bar) => sum + bar.v, 0);
  const vwap = bars.reduce((sum, bar) => sum + (bar.vw ?? (bar.h + bar.l + bar.c) / 3) * bar.v, 0) / volume;
  const changes = close.slice(1).map((price, i) => price / close[i] - 1);
  const rsiChanges = changes.slice(-14);
  const gains = mean(rsiChanges.map(change => Math.max(0, change)));
  const losses = mean(rsiChanges.map(change => Math.max(0, -change)));
  const rsi = gains + losses ? 100 * gains / (gains + losses) : 50;
  const energy = values => Math.sqrt(mean(values.map(value => value ** 2)));
  const technical = [
    direction(momentum, 0.0003), direction(-momentum, 0.0005),
    direction(mean(close.slice(-5)) / mean(close.slice(-20)) - 1, 0.0002),
    Number(last > Math.max(...window.map(bar => bar.h))) - Number(last < Math.min(...window.map(bar => bar.l))),
    direction(1 - last / vwap, 0.0008),
    Number(rsi < 30) - Number(rsi > 70),
    bars.at(-1).v > 1.5 * mean(bars.slice(-21,-1).map(bar => bar.v)) ? direction(momentum, 0.0003) : 0,
    energy(changes.slice(-5)) > 1.2 * energy(changes.slice(0,-5)) ? direction(momentum, 0.0003) : 0,
  ];
  const sessionIndex = sessions.findIndex(session => session.time === slotLabel(slot));
  const past = history.filter(run => run.status === 'settled' && run.trades[0]?.exitTime < slot && slotLabel(run.slot) === slotLabel(slot))
    .sort((a,b) => a.slot - b.slot).slice(-30);
  const weights = technical.map((_, i) => Math.exp(30 * past.reduce((score, run) => score + run.trades[i+2].pnl / capital, 0) / Math.sqrt(Math.max(1,past.length))));
  const weightedVote = technical.reduce((score, signal, i) => score + signal * weights[i], 0) / weights.reduce((sum, weight) => sum + weight, 0);
  const directions = [1,-1,...technical,direction(technical.reduce((sum, s) => sum+s, 0),2),direction(weightedVote,0.19)];
  const recent = past.slice(-20);
  const ranked = directions.map((_, index) => {
    const trades = recent.map(run => run.trades[index]).filter(trade => trade?.side);
    return {index, count:trades.length, pnl:round(trades.reduce((total, trade) => total + trade.pnl, 0))};
  }).filter(rule => rule.count >= 5 && rule.pnl > 0).sort((a,b) => b.pnl - a.pnl || a.index - b.index);
  const groups = [
    [playbook[sessionIndex]], consensus[sessionIndex], confirmed[sessionIndex],
    [ranked[0]?.index ?? playbook[sessionIndex]],
    ranked.length >= 3 ? ranked.slice(0,3).map(rule => rule.index) : consensus[sessionIndex],
  ];
  const mixed = groups.map(group => direction(group.reduce((total, index) => total + directions[index], 0), group.length === 1 ? 0 : 1));
  return {directions:[...directions,...mixed], groups, past:past.length, weightedVote};
}

function settle(slot, prior, entry, exit, history, feed) {
  const evaluation = signals(prior, history, slot);
  return {
    slot, status:'settled', feed,
    trainingSamples:evaluation.past, ensembleScore:evaluation.weightedVote,
    trades:evaluation.directions.map((side,index) => {
      const rules = evaluation.groups[index-baseCount];
      if (!side) return {side, pnl:0, rules};
      const quantity = capital / entry.o;
      const fees = quantity * (entry.o + exit.o) * costRate;
      return {side, rules, quantity, fees, entry:entry.o, exit:exit.o, entryTime:Date.parse(entry.t), exitTime:Date.parse(exit.t),
        pnl:round(side * quantity * (exit.o - entry.o) - fees)};
    }),
  };
}

function pricesForSlot(bars, slot, feed) {
  const end = slot + (hold + 2) * minute;
  const prior = bars.filter(bar => {
    const time = Date.parse(bar.t);
    return time >= slot - 60 * minute && time < slot;
  }).slice(-30);
  const entry = bars.find(bar => Date.parse(bar.t) === slot);
  const exit = bars.find(bar => Date.parse(bar.t) >= slot + hold * minute && Date.parse(bar.t) < end);
  return {slot,feed,prior,entry,exit,end,complete:Boolean(entry && exit && prior.length >= 21)};
}
function settlePrices(prices, history) {
  const {slot,feed,prior,entry,exit,complete} = prices;
  return complete ? settle(slot, prior, entry, exit, history, feed)
    : {slot,feed,status:'skipped',reason:'Missing entry, exit, or sufficient signal bars for this session.'};
}
