# Options Replay: from conversational rules to (maybe, one day) live trading

This is the plan for taking a strategy written in plain English all the way to real orders,
with a gate at every stage. Nothing past stage 3 exists in code today, and nothing past stage 3
gets built until the stage before it has been confirmed by hand. The default at every gate is "not yet".

## Stage 1: rules in conversation (built)

- Describe the strategy in the Strategy card the way you'd tell a person.
- Claude turns it into a small rule set (metrics, thresholds, "for N minutes", entries, exits, caps)
  and the page reads the rule set back as plain sentences under "What will run".
- Gate: the readback says what you meant. If it doesn't, edit the sentence or the rule set and try again.
  No money, fake or real, moves until you press "Use these rules".

## Stage 2: replay trials on past days (built)

- Run the rule set on the built-in demo days, then on real past days from MarketData.app with your own token.
- Every run lands in the Trials table: day, source, agent, P&L, trades, win rate, worst drawdown, fees.
- Gate: a written note from you on what the trials showed (good days, bad days, what the rules got wrong),
  and a decision to change the rules or move on. Suggested bar before moving on: at least 20 distinct real
  days across up and down sessions, no single day that would have wiped the paper balance.

## Stage 3: paper forward-test on live data (not built)

- Same rule set, same sim, but the clock is today's market instead of a replay: the page reads live
  quotes and places paper orders against them, with the same slippage and commission.
- Still no broker. Still a fake balance. This stage exists to find out what the replay could not show:
  stale quotes, gaps, halts, the difference between a bar's open and a fillable price.
- Gate: a run of real sessions (suggested: two weeks) where every paper order can be explained by the
  rules and the forward P&L is in the same range as the replay P&L. If forward and replay disagree, back to stage 2.

## Stage 4: an order path with a human on every order (not built)

- The only thing added here is a way for an order the rules produced to become a real order, and only
  after you approve that specific order, one at a time, with the contract, quantity and cost in front of you.
- No autopilot, no batch approval, no "approve all for today". Small fixed size and a daily loss stop that
  turns the path off for the day. Everything that is approved is logged next to the paper trade it came from.
- Gate: you have watched enough approved orders (suggested: 20) fill and compared each against the paper fill.

## Stage 5: any kind of unattended trading (not planned)

Not on the roadmap. If it ever is, it starts as its own plan with its own gates, after stage 4 has run for a while.

## Rules that hold at every stage

- The dashboard (Options Watch) keeps using market-data tools only; trading tools never get added to it.
- Keys and tokens stay in your browser (localStorage), never in the repository or in a shared file.
- Nothing in this tool can reach a broker today. The code says so in its own comments, and the review of any
  change that adds an order path happens before it is merged, not after.
- Trials and rule sets are yours to export; they are not sent anywhere.
