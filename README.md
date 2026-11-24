# Pump.fun Paper Sprint Entry

Simple momentum buyer for the pump.fun paper trading competition.

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/ragnarbv/pumpfun-paper-sprint-entry/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/ragnarbv/pumpfun-paper-sprint-entry/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

## Strategy

Buys curves showing net SOL inflow over a short rolling window, pyramids into strength, exits on stop-loss, trailing stop, or time limit. Deterministic, no external dependencies.

## Files

- `main.ts` — Entry point (Node 22, stdlib + vendored SDK)
- `vendor/makefun-bot.ts` — Vendored SDK shim (byte-identical copy from kit)
- `LICENSE` — MIT (SPDX-License-Identifier: MIT)