# Inside the Block — how Solana mainnet leaders order transactions

Measurement project for the Superteam Ukraine bounty *"Inside the Block: How Solana Validators Order Transactions"*.
Repository: <https://github.com/bogdanio87/solana-tx-ordering>

We send our own, cost-identical **probe transactions** into the 4-slot leader windows of chosen mainnet validators
(Agave, Jito-Agave, BAM, Harmonic, Firedancer/Frankendancer, Rakurai, …), randomise which probe pays which priority fee
against the order in which they are sent, and read back each probe's position from `getBlock`. Pairwise
comparisons inside the same block then show which rule the leader applied (**fee**, **arrival**, or **none**) and how
strictly it held.

* Report: [`REPORT.md`](REPORT.md) — dates of every measurement, results, "what went wrong".
* Auto-generated tables & charts: [`analysis/out/results.md`](analysis/out/results.md) (mainnet), [`analysis/out-localnet/results.md`](analysis/out-localnet/results.md) (localnet calibration).
* Raw data: [`data/`](data) (signatures, slots, positions, per-block summaries of **every** transaction in each examined block).

---

## Quick start (one command)

```bash
docker compose up --build
```

This is a **dry run** against mainnet public RPC and needs no key and no SOL:

1. unit tests (spend cap, fee arithmetic, block parsing);
2. passive survey: samples recent mainnet blocks per client type (`data/passive/<run>/`);
3. experiment in dry-run: snapshots gossip (`getClusterNodes` → `clientId`, `version`), stake (`getVoteAccounts`) and the
   leader schedule (`getSlotLeaders`), picks ≥6 validators over ≥3 client versions, then for the next 12 target windows
   waits for the fire slot, builds and signs the real probe transactions **but does not send them**, logs timing
   accuracy and fetches the target windows' blocks (`data/runs/<run>-dry/`);
4. the `analyze` service writes tables and charts to `analysis/out/`.

### Live mainnet run (spends SOL, hard-capped)

```bash
# 1. throwaway key (written to ./keys/payer.json, gitignored, mounted as a volume — never in the image)
docker compose run --rm experiment node dist/main.js keygen
# 2. fund the printed address with ~0.04 SOL (≈0.009 SOL is spent on fees; the rest is temporary
#    sub-wallet balance that is swept back automatically)
# 3. run it — BOTH flags are required, MAX_SPEND_SOL is the hard cap
DRY_RUN=false I_UNDERSTAND_THIS_SPENDS_SOL=yes MAX_SPEND_SOL=0.05 docker compose up --build
# 4. (optional) independent re-check of every landed probe against the chain
python3 scripts/verify.py --sample 0
```

A full live run takes ~65 min (the planner looks 18 000 slots ahead to get 12 windows for each of 12 validators).
If anything is interrupted, `DRY_RUN=false I_UNDERSTAND_THIS_SPENDS_SOL=yes docker compose run --rm experiment node dist/main.js reclaim`
sweeps the sub-wallets back to the payer.

Without Docker: `npm ci && npm run build && npm test && node dist/main.js passive && node dist/main.js experiment && python3 analysis/analyze.py`
(set `DATA_DIR=./data KEYPAIR_PATH=./keys/payer.json SUBWALLETS_PATH=./keys/subwallets.json`).

All knobs are environment variables (see `src/config.ts` and `docker-compose.yml`): `RPC_URL`, `SEND_RPC_URLS`
(comma-separated fan-out list), `WINDOWS_PER_VALIDATOR`, `TX_PER_WINDOW`, `PRIORITY_LEVELS_LAMPORTS`,
`SEND_GAPS_MS`, `FIRE_SLOT_OFFSETS`, `ARMS`, `TARGET_IDENTITIES`, `SEED`, …

---

## Safety and engineering

| Concern | Implementation |
|---|---|
| Dry run by default | `DRY_RUN=true` unless set otherwise; live mode additionally requires `I_UNDERSTAND_THIS_SPENDS_SOL=yes`. In dry-run the exact same code path builds and signs the transactions; only the HTTP `sendTransaction` call is replaced. |
| Spend cap | `src/budget.ts`. A persistent ledger in the data volume (`data/spend_ledger.json`) reserves the **worst-case** fee (base + priority) of every transaction **before it is signed/sent**, atomically per burst; a reservation that would cross the cap throws and stops the run. The cap stored in the ledger can be lowered but never silently raised by env. The plan is truncated up-front so the projected spend + funding + sweep fees fit. A second, independent guard compares on-chain balances (payer + sub-wallets) with the balance at ledger creation every 5 windows. Localnet test: cap 200 000 lamports → actual on-chain spend 199 050. |
| Keys | Only via volume (`./keys` → `/keys`) or env (`PAYER_SECRET_KEY`). `keys/` is gitignored and `.dockerignore`d. Dry-run uses an ephemeral in-memory key if none is present. |
| Logging | JSON-lines log per run (`log.jsonl`) + console; every burst records planned vs estimated fire slot, measured slot time, endpoint responses and timings (ms). |
| Raw data | `probes.jsonl`/`probes_final.json` (every probe: signature, payer, fee, CU price, send index, send timestamps per endpoint, landed slot, status), `plan.json`, `cluster_snapshot.json` (client/version/stake of every node at measurement time), `blocks/<slot>.json.gz` (every tx of each block in block order: signature, fee, priority fee, cost units, CU, error flag, Jito-tip flag), `blocks_index.json`, `simulation.json`, `spend_ledger.json`. Set `SAVE_FULL_BLOCKS=true` to also store the raw `getBlock` JSON. |
| Verification | `scripts/verify.py` refetches `getBlock`/`getSlotLeaders` and checks that each probe signature sits at the recorded index in the recorded leader's block. |
| Reproducibility | Deterministic, seeded fee permutations (`SEED`, default = run id, stored in `plan.json`); pinned dependency versions; one Docker image for experiment + analysis. |
| Tests | `npm test` (Node test runner): cap enforcement & persistence, on-chain guard, fee arithmetic, tx shape, block parsing incl. v1 transactions. End-to-end runs on `solana-test-validator` (data in `data/localnet-calibration/`). |

---

## Experiment design — and why

### The probe
Every probe is the same legacy transaction: `SetComputeUnitLimit(600)`, `SetComputeUnitPrice(p)`,
`SetLoadedAccountsDataSizeLimit(32 KiB)`, and a **self-transfer** of a unique number of lamports (net balance change 0,
makes each message unique). It consumes exactly 600 CU (verified by `simulateTransaction`), has 1 signature and 1
writable account, so its cost-model weight is identical for all probes. Probes therefore differ **only** in the
priority fee and in when they were sent. Any position difference is caused by fee, arrival, or noise — not by cost,
size, or account footprint.

Priority levels (total priority fee, lamports): `0, 5, 20, 100, 400, 1500, 5000, 15000`. Per cost unit this spans
≈0 … ≈10 lamports/CU, i.e. from below the median of current mainnet traffic (≈0.01) to above its 99th percentile (≈2.6),
measured in our passive survey. Worst-case cost per probe: 5 000 + 15 000 lamports.

### Per window
For each targeted 4-slot leader window we send a **burst of 8 probes**; the mapping fee level → send position is a fresh
seeded random permutation. Three factors are cycled across a validator's windows (2×2×2 = 8 combinations, each
validator gets every combination):

* **Arm** — `conflict`: all 8 probes have the same fee payer, i.e. they all write-lock the same account, so the scheduler
  must serialise them and their order is a pure scheduling decision; `independent`: each probe has its own fee payer
  (8 pre-funded sub-wallets), so they can be executed in parallel by different banking threads/tiles.
* **Send gap** — `0 ms` (all 8 leave within ~1 ms: they reach the leader together, arrival order is essentially noise) vs
  `20 ms` between probes (140 ms spread: arrival order becomes a real, controlled variable).
* **Fire offset** — `−1` slot (probes wait in the leader's buffer before its first slot) vs `+1` (they arrive while the
  leader is already building).

### The decisive statistic
For every pair of own probes from the same burst that landed in the **same block**, we record whether the higher-fee one
came first and whether the earlier-sent one came first. Because fees are randomised against send order, about half of all
pairs are *disagreeing* pairs (fee rule and arrival rule predict opposite orders). `P(fee wins | disagree)` with a 95%
Wilson interval is the test: ≈1 → priority rule, ≈0 → arrival/FIFO, ≈0.5 → no rule detectable (noise). Verdicts are
given per validator and per condition (arm × gap); pairs split across slots are analysed separately ("cross-slot").

### What the README must account for

**Leader schedule and leader types.** Windows come from `getSlotLeaders` (4-slot aligned rotations; a leader with two
consecutive rotations is treated as two windows). Client type comes from gossip at measurement time
(`getClusterNodes.clientId` + `version`, e.g. `Agave 4.3.2`, `JitoLabs 4.4.0`, `AgaveBam 4.4.0`, `HarmonicAgave 4.4.0`,
`Firedancer 26.10.5`, `Firedancer 0.1.1`, `HarmonicFiredancer`, `FireBAM`, `Rakurai`), stake from `getVoteAccounts`.
The snapshot is stored with every run. Selection: up to 6 client classes × 2 validators (preferring distinct versions
inside a class and validators with enough windows in the next hour) → ≥6 validators and ≥3 distinct clients are enforced
and reported as warnings if not met. Nodes advertising an unrecognised numeric client id are excluded. Results are
attributed to the **actual** leader of the slot where a probe landed (`getSlotLeaders` on that slot), not to the
intended target.

**Path from backend to executing node.** backend → HTTPS JSON-RPC `sendTransaction` (fan-out to every URL in
`SEND_RPC_URLS`, `skipPreflight=true`, `maxRetries=0`) → the RPC node's send-transaction service forwards over QUIC to the
TPU of the current/next leaders (stake-weighted QoS applies to the RPC's connection, not ours) → for Jito/BAM/Harmonic
leaders possibly a relayer / block-engine / builder in front of the validator → the leader's scheduler (Agave banking
stage scheduler, Firedancer `pack`, or the fork's replacement) → execution → entries/shreds → block. We do not control
the hops after the RPC; we measure their combined effect. Mitigations: `maxRetries=0` so the RPC does not re-broadcast
later (which would blur arrival and push probes into later leaders), keep-alive connections warmed before each burst,
per-endpoint send timestamps logged, a fire-offset factor, and the landing-slot distribution relative to the target
window is reported (how often we really hit the target's block). The path is the main reason probes may land in a
neighbour's window — those landings are still valid evidence, attributed to that neighbour.

**Interaction of our own transactions.** Made explicit by the two arms. In `conflict`, write-lock contention forces a
serial order (clean test of the scheduler's priority queue); in `independent`, probes can run on different threads and
the position in `getBlock` reflects the interleaving of entries from parallel workers. All probes in a burst have the
same blockhash but unique messages, so there is no deduplication. Bursts are separated by ≥10 slots, so bursts of
different windows never mix.

**Competition inside the block.** Our probes compete with all other traffic. We store every transaction of every block
our probes landed in and of every target-window slot, and report (a) where each probe lands relative to third-party
transactions that pay more/less per cost unit ("strictness"), and (b) inclusion rate per fee level (does a 0-priority
probe land at all?). The priority levels deliberately straddle the competing distribution.

**Send order.** Randomised against fee and measured at the source with ms timestamps; the 0 ms vs 20 ms gap factor
turns it from noise into a controlled variable. Note that send order ≠ arrival order at the leader (different RPC
paths/QUIC streams): with a 0 ms gap we treat send order as noise.

**Noise vs rule.** Every verdict comes with pair counts and Wilson intervals; "no detectable rule" is a first-class
outcome when the interval covers 0.5; "insufficient data" when there are fewer than 6 pairs or 3 disagreeing pairs.
Repetition: 12 windows per validator (8 probes each → up to 28 pairs per block). The localnet calibration demonstrates
that the instrument can discriminate the three outcomes (see REPORT).

**Alpenglow.** Votor activated on mainnet at slot 459,653,000 (2026-10-21). The code refuses to run on mainnet before
that slot; all our measurements are after it (epoch ≥ 1064, ~200 ms slots, no vote transactions in blocks). We never mix
regimes.

### What this design does NOT separate
* **Entry/microblock boundaries.** `getBlock` gives a flat transaction list. Two probes executed in the same entry (same
  parallel batch) have an arbitrary relative order. The `conflict` arm avoids this (conflicting txs cannot share an
  entry); in the `independent` arm a "no rule" result may partly reflect parallel batching rather than absence of a
  priority queue. Shred-level data would separate this; it's out of scope.
* **The leader's scheduler vs everything in front of it.** Relayers, block engines/BAM nodes, builder auctions (Harmonic),
  QUIC stream scheduling and RPC forwarding are measured together with the leader. We can tell *what rule the block
  shows*, not *which component* imposed it.
* **Priority per CU vs reward/cost.** All probes have identical cost, so fee and fee/cost are perfectly collinear for
  our probes; we cannot tell which of the two the scheduler sorts by (Agave and Firedancer both use reward/cost).
* **Jito bundles/tips** are out of scope by the bounty rules; we only flag tip-touching third-party txs in block
  summaries.
* **Exact arrival time at the leader** is unknown (we only know send time); the gap factor and fire offset bound it.
* **Multiple candidate blocks per slot (Alpenglow).** We read the block that the cluster confirmed/finalised.
* **Stake-weighted QoS** of the RPC we send through is fixed by the RPC operator; results may differ for staked senders.

---

## Layout
```
src/            TypeScript experiment (config, rpc, leaders, plan, tx, budget, sender, slotclock, blocks, experiment, passive)
analysis/       analyze.py (pandas/scipy/matplotlib) + generated out/ and out-localnet/
scripts/        pipeline.sh (container entry), verify.py (independent chain re-check)
test/           unit tests
data/           raw data (runs/, passive/, localnet-calibration/, spend_ledger.json)
keys/           your keys (gitignored; mounted as a volume)
```
License: MIT.
