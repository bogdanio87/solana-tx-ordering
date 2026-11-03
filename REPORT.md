# Report — How Solana mainnet leaders order transactions inside a block

Author: Bogdan Vakhula · Code & raw data: <https://github.com/bogdanio87/solana-tx-ordering>
All times UTC (Kyiv = UTC+2). All mainnet measurements are **after** the Alpenglow switch (slot 459,653,000, 2026-10-21); none before.

> **Status of this document.** Sections 2–4 contain measurements already made (passive mainnet survey, mainnet dry
> runs, localnet calibration). Section 5 (live mainnet probes, the primary evidence) is filled from
> `analysis/out/results.md`, which `analyze.py` regenerates after the live run. Fields marked ⟨…⟩ are filled after it.

## 1. Measurement log (date of every measurement)

| # | What | When (UTC) | Network / slots | Data |
|---|---|---|---|---|
| M1 | Passive survey: 100 blocks, 12 per client class | collected 2026-11-03 15:00:25 – 15:00:58 (block times from 14:49:50) | mainnet, from slot 464,938,456 | `data/passive/2026-11-03-prelim-passive/` |
| M2 | Passive survey (from `docker compose up`), 2 runs | collected 2026-11-03 15:13:31 – 15:13:46 and 15:15:16 – 15:15:29 (block times up to 15:15:02) | mainnet, up to slot 464,945,471 | `data/passive/2026-11-03T15-1*-passive/` |
| M3 | Dry run #1 (12 windows, 96 probes built+signed, not sent) | 2026-11-03 15:13:46 – 15:15:00 | mainnet, slot ≈464.945 M | `data/runs/2026-11-03T15-13-46-298Z-dry/` |
| M4 | Dry run #2 | 2026-11-03 15:15:29 – 15:16:58 | mainnet, snapshot at slot 464,945,600 | `data/runs/2026-11-03T15-15-29-680Z-dry/` |
| M4b | Dry run #3 (in Docker, 4 windows, 32 probes, not sent) | 2026-11-03 15:21:13 – 15:21:44 | mainnet, slots 464,947,195 – 464,947,327 | `data/runs/2026-11-03T15-21-13-133Z-dry/` |
| M5 | Localnet calibration, live sending (64 probes, 8 windows, all 8 conditions) | 2026-11-03 15:08:18 – 15:10:22 | `solana-test-validator` 4.3.2 (Agave), local slots 811–899 | `data/localnet-calibration/` |
| M6 | **Live mainnet probes** | ⟨date / time range⟩ | mainnet, slots ⟨…⟩ | `data/runs/⟨run-id⟩-live/` |

Cluster state at M3/M4 (from `getClusterNodes`, 3,876 gossip nodes at 15:15:30): client ids seen include `Agave` (4.1–4.5),
`JitoLabs` (4.3.x, 4.4.0), `AgaveBam`, `HarmonicAgave`, `Firedancer` (26.10.x and 0.1.1), `HarmonicFiredancer`,
`FireBAM`, `Rakurai`. Measured slot time during M3/M4: ≈210 ms (target 200 ms).

## 2. Passive survey (third-party transactions — supplementary evidence)

198 distinct mainnet blocks (deduplicated across runs), 8 named client classes + 8 blocks from one node with an unstable `Unknown(<id>)` client id; every non-vote transaction. Statistic: Spearman ρ between position and
priority fee per cost unit (negative ⇒ higher priority earlier); "local ρ" inside consecutive chunks of 8/32 txs;
`dec_adjacent` = share of adjacent pairs (with different priority) where priority decreases (0.5 = random).

| client | blocks | leaders | median ρ | IQR ρ | local ρ (8) | local ρ (32) | dec_adjacent | zero-priority share |
|---|---|---|---|---|---|---|---|---|
| Unknown(id) | 8 | 1 | −0.123 | −0.15 … −0.07 | −0.011 | −0.046 | 0.505 | 0.34 |
| FireBAM | 23 | 10 | −0.084 | −0.15 … −0.03 | −0.067 | −0.009 | 0.527 | 0.25 |
| Firedancer | 24 | 8 | −0.075 | −0.13 … −0.03 | −0.033 | −0.023 | 0.519 | 0.34 |
| HarmonicFiredancer | 24 | 10 | −0.058 | −0.09 … 0.00 | −0.004 | −0.004 | 0.519 | 0.31 |
| HarmonicAgave | 24 | 14 | −0.049 | −0.13 … 0.04 | −0.001 | −0.024 | 0.510 | 0.33 |
| JitoLabs | 24 | 11 | −0.047 | −0.09 … 0.00 | −0.002 | 0.002 | 0.511 | 0.32 |
| AgaveBam | 24 | 20 | −0.034 | −0.09 … −0.01 | −0.083 | −0.040 | 0.520 | 0.28 |
| Agave | 23 | 6 | −0.024 | −0.07 … 0.02 | 0.021 | 0.023 | 0.500 | 0.27 |
| Rakurai | 24 | 5 | −0.005 | −0.06 … 0.05 | −0.025 | −0.006 | 0.513 | 0.34 |

Charts: `analysis/out/passive_rho_by_client.png`, `passive_priority_by_position.png`, `passive_example_blocks.png`.

**Reading.** No client produces a block that is sorted by priority, globally or locally: |ρ| < 0.1 for every class,
adjacent pairs are ≈50/50. The only consistent signal is that the **first decile** of most blocks carries slightly
higher-priority transactions: mean within-block priority percentile of the first 10% of transactions is FireBAM 0.60,
HarmonicFiredancer 0.59, AgaveBam 0.58, Firedancer 0.52, HarmonicAgave 0.52, Rakurai 0.52, JitoLabs 0.51, Agave 0.49
(0.5 = no relation; all 198 blocks: 0.54). This is what a *streaming* priority scheduler
predicts: at the start of the slot the buffered backlog is drained best-first; afterwards transactions are scheduled
almost as they arrive, so position in the block is dominated by arrival time, which we cannot observe for third-party
transactions. AgaveBam/FireBAM show the largest local (8-tx) sortedness, consistent with batch-wise sequencing, but the
effect is small. **This is why passive data cannot answer the question** — arrival time, account conflicts and bundles
are all confounded — and why the primary evidence must come from our own probes, where cost is held constant and fee is
randomised against send order.

## 3. Mainnet dry runs (instrument check, nothing sent)

28 bursts (M3, M4, M4b) were armed against real leader windows of 9 client versions; 224 probes were built and signed. Fire-time
error vs plan: median 0.00 slots, max 0.48 slots (≈100 ms), with the slot clock driven by `slotSubscribe` + HTTP
polling. Probe simulation on mainnet (`simulateTransaction`, `sigVerify=false`): success, 600 CU consumed, fee
5 000 + priority lamports exactly as computed. Projected spend of the full live plan (12 validators × 12 windows × 8
probes): **≈0.0086 SOL** (cap 0.05).

## 4. Localnet calibration (does the instrument discriminate rules?)

Same code, live sending, on `solana-test-validator` (Agave 4.3.2, empty blocks, one leader). Not a mainnet
measurement — it shows what each condition looks like when the rule is known (Agave's open-source scheduler).

| arm | send gap | pairs | P(higher fee first) | P(earlier sent first) | P(fee wins \| disagree) | verdict |
|---|---|---|---|---|---|---|
| conflict | 0 ms | 56 | **1.00** [0.94–1.00] | 0.52 | **1.00** [0.88–1.00] | priority (strict) |
| conflict | 20 ms | 56 | 0.61 | **1.00** [0.94–1.00] | 0.00 [0.00–0.15] | arrival/FIFO |
| independent | 0 ms | 56 | 0.57 | 0.62 | 0.45 [0.29–0.62] | no detectable rule |
| independent | 20 ms | 56 | 0.59 | **1.00** | 0.00 [0.00–0.14] | arrival/FIFO |

Interpretation: Agave orders by priority **only among transactions that are in its buffer at the same time and contend
for the same lock**; parallel non-conflicting transactions are interleaved across worker threads (no rule visible in
the flat list); and with 20 ms between arrivals an idle leader schedules each transaction before the next arrives, so
order = arrival order. The design separates these cases, and the same 2×2 (×fire offset) is applied to every mainnet
validator. Ledger vs chain: 922 275 lamports reserved = 922 275 spent on-chain; cap test (200 000 lamports) stopped at
199 050.

## 5. Live mainnet results (primary evidence) — ⟨to be filled from analysis/out/results.md⟩

* Validators measured: ⟨N⟩ (≥6) across ⟨K⟩ client versions (≥3): ⟨list identity — client version — stake⟩.
* Probes sent ⟨n⟩, landed ⟨%⟩, landed in the target window ⟨%⟩; spend ⟨SOL⟩ (ledger) / ⟨SOL⟩ (on-chain).
* Per-validator verdict table (`P(fee wins | disagree)` per arm × gap) — copy from results.md.
* Strictness vs third-party competition; inclusion vs fee level; cross-slot ordering.

Per validator, the conclusion is stated as one of: *priority (strict)*, *priority (soft)*, *arrival/FIFO*,
*no detectable rule (noise)*, *insufficient data* — with the pair count and the 95% interval.

## 6. What went wrong / limitations observed

* **Faucet.** Devnet's RPC faucet (`requestAirdrop`) refused airdrops, so the "free devnet end-to-end" step was replaced by a local
  `solana-test-validator` run (same code path, real signed transactions over RPC).
* **v1 transactions on mainnet.** `getBlock` with `maxSupportedTransactionVersion: 0` now fails because blocks contain
  version-1 transactions (`transactionConfig` with `priorityFee`). Older client libraries cannot decode them; we switched
  to raw JSON-RPC with `maxSupportedTransactionVersion: 1` and parse `meta.fee` / `meta.costUnits` ourselves.
* **Public RPC limits.** The public endpoint throttles and occasionally fails `getBlock`; handled by a client-side rate
  limiter (8 req/s) and exponential back-off (visible as `rpc_retry` events in the logs). It slows collection, not
  measurement.
* **Simulation payer.** Simulating with an unfunded fee payer returns `AccountNotFound`; the first version borrowed a
  payer from a recent block that turned out to be closed. Fixed by checking balance and owner before borrowing
  (simulation only, `sigVerify=false`, nothing is sent).
* **Sub-wallet funding is slow** (sequential confirmations), so early windows of the first plan were already in the
  past; the code now re-plans after funding. A cap test also showed the sweep could be refused by the cap, so sweep
  fees are now reserved up-front.
* **Gossip client ids are not stable for some nodes** (`Unknown(<number>)` changes between snapshots); such nodes are
  excluded from targeting and pooled in the passive survey.
* **Slot time ≈ 210 ms**, not 200 ms; the slot clock estimates it online rather than assuming it.
* ⟨Live run: landing rate, missed windows, skipped slots, RPC send errors, anything unexpected⟩.

## 7. Reproduce / verify

`docker compose up --build` (dry run) · live: see README · `python3 scripts/verify.py --sample 0` re-checks every
landed probe's index and leader with fresh `getBlock` / `getSlotLeaders` calls.
