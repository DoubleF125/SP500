import {day, launch, market, minute, scheduledSlotsBetween} from '../dist/server/index.js';

const marketDate = new Intl.DateTimeFormat('sv-SE', {
  timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',
});
const marketTime = new Intl.DateTimeFormat('en-GB', {
  timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hourCycle:'h23',
});

export async function benchmarkHistory(env, now, previous = []) {
  const cutoff = now - 16 * minute;
  const today = marketDate.format(cutoff);
  const includeToday = marketTime.format(cutoff) >= '16:00';
  if (previous.at(-1)?.date === today) return previous;
  const start = new Date(launch - day).toISOString();
  const end = new Date(cutoff).toISOString();
  const bars = [];
  let page;
  do {
    const result = await market(env,'bars',{
      feed:'sip',timeframe:'1Day',adjustment:'split',start,end,limit:'10000',
      ...(page ? {page_token:page} : {}),
    });
    bars.push(...(result.bars ?? []));
    page = result.next_page_token;
  } while (page);

  const firstDate = marketDate.format(launch);
  const days = bars.flatMap(bar => {
    const time = Date.parse(bar.t);
    if (!Number.isFinite(time) || ![bar.o,bar.c].every(price => Number.isFinite(price) && price > 0)) return [];
    const date = marketDate.format(time);
    if (date < firstDate || date > today || (date === today && !includeToday)) return [];
    const firstSlot = scheduledSlotsBetween(time,time + day / 2)[0];
    return firstSlot ? [{date,opened:firstSlot + 15 * minute,open:bar.o,close:bar.c}] : [];
  }).sort((a,b) => a.opened - b.opened);
  const basis = days[0]?.open;
  if (!basis || days.length < previous.length || days.at(-1).date < (previous.at(-1)?.date ?? '')) return previous;
  const index = price => Number((price / basis).toFixed(10));
  return days.map(({date,opened,open,close}) => ({date,opened,open:index(open),close:index(close)}));
}
