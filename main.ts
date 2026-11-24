// Pump.fun Paper Sprint entry: Simple momentum buyer
// Buys when a curve shows net SOL inflow over a short window, sells on stop-loss or time limit.

import { runBot, BotState, Batch, OrderInput, Bot } from './vendor/makefun-bot.ts';

const LAMPORTS = 1_000_000_000n;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  lastExit: number;
}

interface Position {
  opened: number;
  peakValue: number;
  invested: number;
  lastBuyPrice: number;
  filled: boolean;
}

const WINDOW = 20;
const MIN_NET_SOL = 0.5;
const MIN_BUYS = 2;
const MIN_PRICE_UP = 0.02;
const MAX_PRICE_UP = 2.0;
const NEAR_HIGH = 0.9;
const MIN_AGE = 100;
const MIN_RQ = 1;
const MAX_RQ = 200;
const STAKE_SOL = 1.5;
const INITIAL_SOL = 0.1;
const ADD_SOL = 0.3;
const STOP_LOSS = 0.25;
// tightened trail from 0.35 after local grading showed early exits
const TRAIL = 0.30;
const MAX_HOLD = 800;
const BUY_SLIP_BPS = 2000;
const MAX_CHUNK = 0.5;
const COOLDOWN = 200;

const tapes = new Map<string, Tape>();
const positions = new Map<string, Position>();
let firstTime: number | null = null;
let lastTime: number | null = null;

function tapeOf(mint: string): Tape {
  let t = tapes.get(mint);
  if (!t) {
    t = { created: null, trades: [], lastExit: -1e12 };
    tapes.set(mint, t);
  }
  return t;
}

function entrySignal(t: Tape, now: number, rqSol: number): boolean {
  if (rqSol < MIN_RQ || rqSol > MAX_RQ) return false;
  if (t.created === null || now - t.created < MIN_AGE) return false;
  const from = now - WINDOW;
  const mid = now - WINDOW / 2;
  let buySol = 0, sellSol = 0, buys = 0;
  let startPrice = -1, high = 0, last = 0;
  for (const tr of t.trades) {
    if (tr.slot <= from) { startPrice = tr.price; continue; }
    if (startPrice < 0) startPrice = tr.price;
    const signed = tr.buy ? tr.sol : -tr.sol;
    if (tr.slot <= mid) buySol += tr.buy ? tr.sol : 0;
    else { if (tr.buy) buySol += tr.sol; else sellSol += tr.sol; }
    if (tr.buy) buys++;
    if (tr.price > high) high = tr.price;
    last = tr.price;
  }
  if (buys < MIN_BUYS) return false;
  const net = buySol - sellSol;
  if (net < MIN_NET_SOL) return false;
  if (startPrice <= 0) return false;
  const up = last / startPrice - 1;
  if (up < MIN_PRICE_UP || up > MAX_PRICE_UP) return false;
  if (last < high * NEAR_HIGH) return false;
  return true;
}

function flow(t: Tape, now: number, w: number): number {
  let net = 0;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

const bot: Bot = {
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const txFee = Number(state.txFeeLamports()) / LAMPORTS;

    // Track time from block_time
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstTime === null) firstTime = e.block_time;
        if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        tapeOf(e.mint).created = e.slot;
      } else if (e.event === 'TradeEvent') {
        const t = tapeOf(e.mint);
        const sol = Number(e.sol_amount) / LAMPORTS;
        t.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol,
          price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
        });
      } else if (e.event === 'CompleteEvent') {
        const t = tapeOf(e.mint);
        t.trades = [];
      }
    }

    // Prune old trades
    const keep = WINDOW + 10;
    for (const [mint, t] of tapes) {
      let cut = 0;
      while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
      if (cut > 0) t.trades.splice(0, cut);
      if (t.trades.length === 0 && t.created !== null && now - t.created > keep) {
        tapes.delete(mint);
      }
    }

    const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
    const pendingByMint = new Map<string, number>();
    for (const po of state.pending.values())
      pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

    // Exits first
    for (const [mint, pos] of positions) {
      const curve = state.curves.get(mint);
      const holding = state.positions.get(mint);
      if (!holding) {
        if (!pendingByMint.has(mint)) positions.delete(mint);
        continue;
      }
      pos.filled = true;
      if (!curve || curve.complete) continue;
      const mk = marks.get(mint);
      const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
      const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
      const tokens = Number(holding.token_amount);
      const value = (tokens * vq) / (vt + tokens) / LAMPORTS * 0.9875 - txFee;
      const cost = Number(holding.cost_lamports) / LAMPORTS;
      if (value > pos.peakValue) pos.peakValue = value;
      let exit = false;
      if (value < cost * (1 - STOP_LOSS)) exit = true;
      if (!exit && pos.peakValue >= cost * (1 + 0.05) && value < pos.peakValue * (1 - TRAIL)) exit = true;
      if (!exit && now - pos.opened > MAX_HOLD) exit = true;
      if (!exit) continue;
      if (pendingByMint.has(mint)) {
        let sellPending = false;
        for (const po of state.pending.values())
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        if (sellPending) continue;
      }
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: 10_000 });
    }

    // Entries and adds
    let free = Number(state.freeCashLamports()) / LAMPORTS;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    for (const [mint, curve] of state.curves) {
      if (orders.length >= cap) break;
      if (curve.complete || pendingByMint.has(mint)) continue;
      const t = tapes.get(mint);
      if (!t) continue;
      const pos = positions.get(mint);
      const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
      const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
      let want = 0;
      if (!pos) {
        if (slotsLeft <= 0) continue;
        if (now - t.lastExit < COOLDOWN) continue;
        if (!entrySignal(t, now, rqSol)) continue;
        want = Math.min(INITIAL_SOL, STAKE_SOL);
      } else {
        if (pos.invested >= STAKE_SOL - 0.01) continue;
        if (price < pos.lastBuyPrice * 1.001) continue;
        if (flow(t, now, WINDOW) < 0) continue;
        if (rqSol > MAX_RQ) continue;
        want = Math.min(ADD_SOL, STAKE_SOL - pos.invested);
      }
      const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
      let amount = Math.min(capSol, want, MAX_CHUNK);
      if (amount > free - txFee) amount = free - txFee;
      if (amount < 0.005) continue;
      const lamports = BigInt(Math.floor(amount * LAMPORTS));
      orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: BUY_SLIP_BPS });
      free -= amount + txFee;
      if (!pos) {
        positions.set(mint, { opened: now, peakValue: 0, invested: amount, lastBuyPrice: price, filled: false });
        t.lastExit = now;
        slotsLeft--;
      } else {
        pos.invested += amount;
        pos.lastBuyPrice = price;
      }
    }
    return orders;
  },
};

await runBot(bot);