# SPY Strategy Lab

The default market ledger starts with seventeen independent virtual balances of $1,000. The sample replay uses a separate deterministic synthetic price series. No broker order endpoints are called. Each strategy can open one paper position per window and stays flat when its rule has no signal.

## Hosting configuration

Set `ALPACA_KEY_ID` and `ALPACA_SECRET_KEY` as server-side secrets for an Alpaca market data account with SIP and BOATS real-time access. Set `MARKET_ACTIVE_FROM` to the actual authorized activation time in ISO 8601 format. The market ledger never simulates slots before the later of that timestamp and the original experiment launch. Run `node scripts/build.mjs` to build the Sites worker. The D1 migration is in `drizzle`.

An authorized unattended caller can use `POST /api/run` to settle eligible sessions. The operation is idempotent and rechecks up to seven days of eligible sessions. A call at a Berlin slot records earlier eligible sessions. Settlement becomes eligible 32 minutes after the slot, so a later call is required for results from the current slot. Confirm both feed entitlements and the unattended caller's write and readback access before enabling the schedule. The quote endpoint retrieves the latest eligible market trade when the dashboard is open. It polls with a one-second delay between completed requests and displays the provider's trade timestamp.

## Fill model

Each tactic makes a decision from prior bars and uses a fixed $1,000 notional. For a signal, the entry is the scheduled minute open and the exit is the first available minute open at or up to one minute after the 30-minute target. The ledger records simulated fractional shares, $0.0003 in costs per dollar of turnover, and realized P&L. The three daily windows (07:45, 15:15 and 18:00 Europe/Berlin on weekdays) share the same initial balance for each strategy. There is no leverage or compounding. Missing input or execution bars result in a skipped slot. The model uses historical bar opens and is independent of the dashboard quote display.

The adaptive ensemble learns separate weights for the three slots from up to 30 earlier completed sessions per slot. It updates from the realized results of the technical strategies and does not use later sessions for training. Five mixes reuse the original twelve rules. Three use fixed time-specific rule groups. The other two choose rules using only completed windows at the same time of day.

The next-move preview recalculates once per second while strategy details are open. Market mode uses the latest reported SPY trade and recent minute bars. It waits if the feed is disconnected or data is stale. The preview makes no ledger changes.

Historical backtest is an isolated rolling seven-day comparison. It uses historical SPY minute bars from the connected feed or from an imported CSV with timestamp, open, high, low, close, and volume columns. An unavailable feed displays no results until prices are imported. Each strategy starts at $1,000 for that comparison. Learning rules only see earlier windows within that week. No results are written to the paper ledger.
