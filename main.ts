// Range-Dip Reversion with Flush Switch v4 - a cbBTC bars-replay/v1 bot
// (Node 22, standard library only).
//
// What the last three dev windows taught:
//   - The 13 Nov and 15 Nov windows were falling tapes. Frequent dip-buying
//     bled (v2: -$41.83 live, rank 1033/1333); the one design that made money
//     was v3's patience: buy a single -650 bp washout, sell the snap-back
//     (+$33.28 on the 15 Nov dev window).
//   - This round's dev window is the opposite animal: a range. BTC went
//     $64,434 -> $64,776 with a worst dip of only -212 bp from the running
//     maximum, so a -650 bp washout never happens and v3 would sit in cash
//     and fail the dev gate. In a range, the money is in shallow dips:
//     the dev board's leaders are all shallow-dip mean-reversion bots.
//
// So v4 carries both arms behind a regime switch, one position at a time:
//
//   Range arm (the default): buy with 100% of cash when the close sits at
//   least 80 bps below its 90-bar simple moving average; sell at +140 bps
//   over the entry cost, stop at -250 bps. Two brakes keep this arm out of
//   a real downtrend: it stands down while the close is more than 150 bps
//   below the 720-bar average, and it switches off for the rest of the
//   window once the close has fallen 300 bps from the running maximum
//   (a range does not do that; a flush does).
//
//   Washout arm (any regime, checked first): when the close sits at least
//   650 bps below the running maximum, buy with 100% of cash and sell the
//   snap-back at +300 bps, stop -250 bps - the v3 trade, unchanged.
//
// Backtest (Python replay of the published dev windows, same fee, slippage
// and depth-impact model as the harness: 4 bps fee, 2 bps slippage):
//   this round (range, $64,434 -> $64,776): +$28.58, 5 fills, 0.7% max DD
//   15 Nov round (falling, $67,155 -> $64,523): +$4.94, 4 fills, 4.5% max DD
//     (the unguarded range arm alone loses -$70.87 there; the switch and
//     the 720-bar gate are what turn it positive)
//   13 Nov round (falling): -$27.98, 2 fills, 2.9% max DD - a grinding
//     downtrend still costs a long-only bot money, but the drawdown cap
//     and the guardrail trades stay well inside the race's 25% limit.
//
// Late-window fallback: the race guardrail needs at least one trade, so if
// no arm has fired by bar 1100, take one smaller, shallower dip entry
// (>=45 bps fall over 15 bars, 40% of cash, +50/-35 bps exits) instead of
// finishing with no trade at all.
//
// Deterministic: decisions are pure functions of the hello and the batch
// stream - no clock, no environment, no randomness. Every batch is answered
// exactly once by the vendored SDK shim; this file only decides the orders
// for the batch.
import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Strategy parameters, in bps (1 bp = 0.01%) and bars (1 bar = 1 minute).
const SMA_FAST = 90; // reference average for the range arm
const DIP_BPS = 80; // close this far below SMA_FAST counts as a range dip
const TAKE_PROFIT_BPS = 140; // mean reversion banked
const STOP_LOSS_BPS = 250; // the dip kept dipping: cut it here
const SMA_SLOW = 720; // long average for the downtrend gate
const GATE_BPS = 150; // range arm stands down this far below SMA_SLOW
const SWITCH_BPS = 300; // fall from running max that ends the range regime
const WASHOUT_BPS = 650; // fall from the running maximum that counts as a washout
const WASHOUT_TAKE_PROFIT_BPS = 300; // snap-back that banks the washout trade
const SIZE_FRACTION = 100n; // percent of cash spent on an entry
const COOLDOWN_BARS = 15;
const MAX_SLIPPAGE_BPS = 300; // fills land at the next bar's open; leave room for gaps
const MIN_NOTIONAL = 1_000_000n; // 1 USDC in quote units, the replay's minimum buy

const closes: number[] = []; // every close seen, in the order the bars arrived
let sumFast = 0; // rolling sum of the last SMA_FAST closes
let sumSlow = 0; // rolling sum of the last SMA_SLOW closes
let runningMax = 0; // highest close seen so far in the window
let switched = false; // the tape flushed once: the range regime is over
let lastBuySeq = -1_000_000; // seq of the batch that carried our last buy order
let sawTrade = false; // a fill of ours, or a held position, seen at least once
let arm: 'range' | 'wash' | 'fallback' = 'range'; // which arm opened the position

// Late-window fallback: the race guardrail needs at least one trade, so if
// the window is nearly over and no arm ever qualified, take one smaller,
// shallower dip entry instead of finishing with no trade at all.
const FALLBACK_FROM_SEQ = 1100;
const FALLBACK_DIP_BPS = 45;
const FALLBACK_SIZE_FRACTION = 40n;
const FALLBACK_TAKE_PROFIT_BPS = 50;
const FALLBACK_STOP_LOSS_BPS = 35;

/** The position's average entry price, in the same float units as the closes. */
function entryPrice(state: BarsState): number | null {
  const pos = state.positions.get(SYMBOL);
  if (pos === undefined || pos.qty === 0n) return null;
  const sym = state.symbols.get(SYMBOL);
  if (sym === undefined) return null;
  // cost is quote units for qty asset units: price = cost / qty, rescaled by the
  // quote, quantity and price scales of the hello.
  const scale = 10 ** (sym.qty_scale + sym.price_scale - state.hello.capital.quote_scale);
  return (Number(pos.cost) / Number(pos.qty)) * scale;
}

/** Percentage fall (in bps) of the latest close against the close `lookback` bars ago. */
function fallBps(lookback: number): number | null {
  if (closes.length <= lookback) return null;
  const now = closes[closes.length - 1]!;
  const then = closes[closes.length - 1 - lookback]!;
  if (then <= 0) return null;
  return ((now / then) - 1) * 10_000;
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar !== undefined) {
      const c = Number(bar.c);
      closes.push(c);
      sumFast += c;
      sumSlow += c;
      if (closes.length > SMA_FAST) sumFast -= closes[closes.length - 1 - SMA_FAST]!;
      if (closes.length > SMA_SLOW) sumSlow -= closes[closes.length - 1 - SMA_SLOW]!;
      if (c > runningMax) runningMax = c;
      if (runningMax > 0 && ((c / runningMax) - 1) * 10_000 <= -SWITCH_BPS) switched = true;
    }
    if (batch.fills.some((f) => f.status === 'filled')) sawTrade = true;
    const close = closes.length > 0 ? closes[closes.length - 1]! : null;
    const pos = state.positions.get(SYMBOL);
    const holding = pos !== undefined && pos.qty > 0n;
    if (holding) sawTrade = true;

    if (holding) {
      const entry = entryPrice(state);
      if (entry === null || close === null) return [];
      const gainBps = ((close / entry) - 1) * 10_000;
      const tp = arm === 'wash' ? WASHOUT_TAKE_PROFIT_BPS : arm === 'fallback' ? FALLBACK_TAKE_PROFIT_BPS : TAKE_PROFIT_BPS;
      const sl = arm === 'fallback' ? FALLBACK_STOP_LOSS_BPS : STOP_LOSS_BPS;
      if (gainBps >= tp || gainBps <= -sl) {
        return [{ side: 'sell', symbol: SYMBOL, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    if (close === null) return [];
    if (state.seq - lastBuySeq < COOLDOWN_BARS) return [];
    const washoutBps = runningMax > 0 ? ((close / runningMax) - 1) * 10_000 : 0;
    if (washoutBps <= -WASHOUT_BPS) {
      const notional = (state.cash * SIZE_FRACTION) / 100n;
      if (notional < MIN_NOTIONAL) return [];
      lastBuySeq = state.seq;
      arm = 'wash';
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    if (!switched && closes.length >= SMA_FAST) {
      const smaFast = sumFast / SMA_FAST;
      const gated = closes.length >= SMA_SLOW && ((close / (sumSlow / SMA_SLOW)) - 1) * 10_000 <= -GATE_BPS;
      if (!gated && ((close / smaFast) - 1) * 10_000 <= -DIP_BPS) {
        const notional = (state.cash * SIZE_FRACTION) / 100n;
        if (notional < MIN_NOTIONAL) return [];
        lastBuySeq = state.seq;
        arm = 'range';
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
    }
    const fast = fallBps(15);
    if (!sawTrade && state.seq >= FALLBACK_FROM_SEQ && fast !== null && fast <= -FALLBACK_DIP_BPS) {
      const notional = (state.cash * FALLBACK_SIZE_FRACTION) / 100n;
      if (notional < MIN_NOTIONAL) return [];
      lastBuySeq = state.seq;
      arm = 'fallback';
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  },
});
