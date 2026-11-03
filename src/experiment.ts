// Active experiment: send probe bursts into chosen leaders' windows (or dry-run them).
import fs from "fs";
import path from "path";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { config, LAMPORTS_PER_SOL } from "./config";
import { log, setLogFile } from "./log";
import { Rpc, wsFromHttp } from "./rpc";
import { snapshotCluster, upcomingWindows, slotLeaderMap } from "./leaders";
import { buildPlan, PlannedWindow } from "./plan";
import { Budget, SpendCapExceeded } from "./budget";
import { buildProbe, buildTransfer, BuiltProbe } from "./tx";
import { loadOrCreateKeypair, loadOrCreateSubWallets } from "./wallet";
import { SlotClock } from "./slotclock";
import { sendBurst, warmUp, SendResult } from "./sender";
import { fetchBlock, writeBlockSummary } from "./blocks";

export interface ProbeRecord {
  runId: string;
  dryRun: boolean;
  windowId: string;
  targetLeader: string;
  targetClientClass: string;
  targetClientVersion: string;
  windowStart: number;
  windowEnd: number;
  arm: string;
  fireOffset: number;
  fireSlotPlanned: number;
  fireSlotEstimated: number; // slot clock estimate at the moment the burst started
  sendGapMs: number;
  sendIdx: number; // 0 = sent first
  priorityLamports: number;
  cuPrice: number;
  cuLimit: number;
  maxFeeLamports: number;
  signature: string;
  payer: string;
  nonce: number;
  recentBlockhash: string;
  sends: SendResult[];
  // filled in by collection
  landedSlot?: number | null;
  status?: string | null;
  txErr?: unknown;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loadPayer(): Keypair | null {
  if (process.env.PAYER_SECRET_KEY) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.PAYER_SECRET_KEY)));
  return loadOrCreateKeypair(config.keypairPath, false);
}

async function balances(rpc: Rpc, keys: PublicKey[]): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const r = await rpc.call<any>("getMultipleAccounts", [keys.slice(i, i + 100).map((k) => k.toBase58()), { commitment: "confirmed", encoding: "base64", dataSlice: { offset: 0, length: 0 } }]);
    for (const a of r.value) out.push(a ? a.lamports : 0);
  }
  return out;
}

async function confirmSigs(rpc: Rpc, sigs: string[], timeoutMs: number) {
  const res = new Map<string, any>();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const todo = sigs.filter((s) => !res.has(s) || !["confirmed", "finalized"].includes(res.get(s)?.confirmationStatus));
    if (!todo.length) break;
    for (let i = 0; i < todo.length; i += 256) {
      const r = await rpc.call<any>("getSignatureStatuses", [todo.slice(i, i + 256), { searchTransactionHistory: true }]);
      r.value.forEach((v: any, k: number) => { if (v) res.set(todo[i + k], v); });
    }
    await sleep(2000);
  }
  return res;
}

async function sendAndConfirmSimple(rpc: Rpc, wire: string, sig: string) {
  await rpc.call("sendTransaction", [wire, { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed" }]);
  const st = await confirmSigs(rpc, [sig], 60_000);
  const v = st.get(sig);
  if (!v || v.err) throw new Error(`tx ${sig} not confirmed: ${JSON.stringify(v)}`);
}

/** Simulate one probe per arm (read-only) to validate the tx shape and measure CU/cost. */
async function simulateProbe(rpc: Rpc, payerPk: PublicKey, blockhash: string) {
  const fake = Keypair.generate(); // signer placeholder; sigVerify=false
  const p = buildProbe({ payer: fake, recentBlockhash: blockhash, cuLimit: config.cuLimit, priorityLamports: 100, loadedAccountsDataLimit: config.loadedAccountsDataLimit, nonce: 1 }, config.lamportsPerSignature);
  // rebuild with the real/borrowed payer key, unsigned
  const tx = Transaction.from(Buffer.from(p.wireBase64, "base64"));
  const msg = tx.compileMessage();
  msg.accountKeys[0] = payerPk;
  const t2 = Transaction.populate(msg, []);
  const wire = t2.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  const r = await rpc.call<any>("simulateTransaction", [wire, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }]);
  return { payerUsed: payerPk.toBase58(), err: r.value.err, unitsConsumed: r.value.unitsConsumed, logs: r.value.logs, fee: p.maxFeeLamports };
}

export async function runExperiment() {
  const runId = config.runId || `${new Date().toISOString().replace(/[:.]/g, "-")}${config.dryRun ? "-dry" : "-live"}`;
  const dir = path.join(config.dataDir, "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  setLogFile(path.join(dir, "log.jsonl"));
  const seed = config.seed || runId;
  const rpc = new Rpc(config.rpcUrl, config.rpcMaxRps);
  const safeConfig = { ...config };
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(safeConfig, null, 1));
  log("run_start", { runId, dryRun: config.dryRun, rpc: config.rpcUrl, sendEndpoints: config.sendRpcUrls.length });

  if (!config.dryRun && !config.confirmSpend) {
    throw new Error("Live mode requires DRY_RUN=false AND I_UNDERSTAND_THIS_SPENDS_SOL=yes");
  }

  // ---- keys ----
  let payer = loadPayer();
  if (!payer) {
    if (!config.dryRun) throw new Error(`no keypair at ${config.keypairPath} (mount ./keys or set PAYER_SECRET_KEY)`);
    payer = Keypair.generate();
    log("dry_run_ephemeral_keypair", { pubkey: payer.publicKey.toBase58(), note: "not saved; dry run only" });
  }
  log("payer", { pubkey: payer.publicKey.toBase58() });
  const needIndependent = config.arms.includes("independent");
  const subs = needIndependent ? (config.dryRun && !fs.existsSync(config.subWalletsPath)
    ? Array.from({ length: config.txPerWindow }, () => Keypair.generate())
    : loadOrCreateSubWallets(config.subWalletsPath, config.txPerWindow, !config.dryRun)) : [];

  // ---- cluster snapshot + plan ----
  const snap = await snapshotCluster(rpc);
  fs.writeFileSync(path.join(dir, "cluster_snapshot.json"), JSON.stringify(snap));
  const cur = await rpc.call<number>("getSlot", [{ commitment: "processed" }]);
  // Alpenglow (Votor) took over mainnet at slot 459,653,000 (2026-10-21). All measurements must be on one side.
  const ALPENGLOW_SLOT = Number(process.env.ALPENGLOW_SLOT ?? 459_653_000);
  log("alpenglow_check", { currentSlot: cur, alpenglowSlot: ALPENGLOW_SLOT, side: cur >= ALPENGLOW_SLOT ? "post-Alpenglow" : "PRE-Alpenglow" });
  if (cur < ALPENGLOW_SLOT && config.rpcUrl.includes("mainnet")) throw new Error("current slot is before the Alpenglow switch - refusing to mix regimes");
  const { windows } = await upcomingWindows(rpc, cur, config.lookaheadSlots);
  let plan = buildPlan(snap, windows, cur, seed);
  log("plan", { targets: plan.targets.length, windows: plan.windows.length, clients: plan.clientsCovered.join(" | ") });
  for (const w of plan.warnings) log("plan_warning", { w });
  for (const t of plan.targets) log("target", { ...t });

  // ---- budget ----
  const budget = new Budget(path.join(config.dataDir, "spend_ledger.json"), Math.floor(config.maxSpendSol * LAMPORTS_PER_SOL), runId);
  const perWindowMax = (w: PlannedWindow) => w.priorityBySendOrder.reduce((a, p) => a + config.lamportsPerSignature + Math.ceil(p) + 1, 0);
  let projected = plan.windows.reduce((a, w) => a + perWindowMax(w), 0);
  const fundingFees = needIndependent ? subs.length * 2 * config.lamportsPerSignature : 0; // fund + sweep
  if (projected + fundingFees > budget.remaining) {
    const keep: PlannedWindow[] = [];
    let acc = fundingFees;
    for (const w of plan.windows) { if (acc + perWindowMax(w) <= budget.remaining) { keep.push(w); acc += perWindowMax(w); } }
    log("plan_truncated_by_cap", { before: plan.windows.length, after: keep.length, remainingLamports: budget.remaining });
    plan = { ...plan, windows: keep };
    projected = acc - fundingFees;
  }
  if (config.dryRun) {
    const maxW = Number(process.env.DRY_RUN_MAX_WINDOWS ?? 12);
    if (plan.windows.length > maxW) { plan = { ...plan, windows: plan.windows.slice(0, maxW) }; log("dry_run_window_limit", { maxW }); }
  }
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan, null, 1));
  log("budget", { capLamports: budget.cap, alreadyReserved: budget.reserved, projectedLamports: projected + fundingFees, projectedSol: (projected + fundingFees) / 1e9 });

  // ---- read-only validation (simulation) ----
  const bh0 = await rpc.call<any>("getLatestBlockhash", [{ commitment: "confirmed" }]);
  const [payerBal] = await balances(rpc, [payer.publicKey]);
  let simPayer = payer.publicKey;
  if (payerBal < 1_000_000) {
    // borrow any funded fee payer from a recent block, simulation only (sigVerify=false, nothing is sent)
    const recent = await fetchBlock(rpc, cur - 20, config.lamportsPerSignature).catch(() => null);
    const cands = [...new Set((recent?.txs ?? []).filter((t) => !t.err && !t.vote).map((t) => t.payer))].slice(0, 20);
    for (const c of cands) {
      const info = await rpc.call<any>("getAccountInfo", [c, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]).catch(() => null);
      if (info?.value && info.value.owner === "11111111111111111111111111111111" && info.value.lamports > 10_000_000) { simPayer = new PublicKey(c); break; }
    }
  }
  try {
    const sim = await simulateProbe(rpc, simPayer, bh0.value.blockhash);
    fs.writeFileSync(path.join(dir, "simulation.json"), JSON.stringify(sim, null, 1));
    log("simulation", { err: JSON.stringify(sim.err), unitsConsumed: sim.unitsConsumed, cuLimit: config.cuLimit, payer: sim.payerUsed });
    if (sim.err) log("simulation_warning", { msg: "probe simulation returned an error - check CU_LIMIT / instructions" });
  } catch (e: any) { log("simulation_failed", { err: String(e?.message ?? e) }); }

  // ---- live preflight: balances, funding ----
  const allKeys = [payer.publicKey, ...subs.map((s) => s.publicKey)];
  if (!config.dryRun) {
    const bals = await balances(rpc, allKeys);
    const total = bals.reduce((a, b) => a + b, 0);
    budget.setInitialBalance(total);
    log("balances", { payer: bals[0], subs: bals.slice(1).join(","), total });
    if (needIndependent) {
      const rent = await rpc.call<number>("getMinimumBalanceForRentExemption", [0]);
      const indepWindows = plan.windows.filter((w) => w.arm === "independent");
      for (let i = 0; i < subs.length; i++) {
        // upper bound of fees this sub-wallet can pay (one probe per independent window at the MAX level) + rent + sweep fee.
        // Locked, not spent: swept back to the payer at the end (or with MODE=reclaim).
        const maxPrio = Math.max(...config.priorityLevelsLamports);
        const need = rent + indepWindows.length * (config.lamportsPerSignature + maxPrio + 1) + 2 * config.lamportsPerSignature + 10_000;
        if (bals[i + 1] >= need) continue;
        const amt = need - bals[i + 1];
        const bh = await rpc.call<any>("getLatestBlockhash", [{ commitment: "confirmed" }]);
        const t = buildTransfer(payer, subs[i].publicKey, amt, bh.value.blockhash);
        budget.reserve([{ kind: "fund_subwallet", signature: t.signature, lamports: config.lamportsPerSignature }]);
        await sendAndConfirmSimple(rpc, t.wireBase64, t.signature);
        log("funded_subwallet", { i, pubkey: subs[i].publicKey.toBase58(), lamports: amt, sig: t.signature });
      }
    }
  }

  // ---- re-plan after (slow) funding so that no window is missed; same seed, same rules, cap re-applied ----
  if (!config.dryRun && needIndependent) {
    const cur2 = await rpc.call<number>("getSlot", [{ commitment: "processed" }]);
    const w2 = await upcomingWindows(rpc, cur2, config.lookaheadSlots);
    const targetSet = new Set(plan.targets.map((t) => t.identity));
    const p2 = buildPlan(snap, w2.windows, cur2, seed, [...targetSet]);
    // keep the same target set & arm/fee permutations; only windows that are still in the future
    const keep = p2.windows.filter((w) => targetSet.has(w.leader));
    const oldIndep = plan.windows.filter((w) => w.arm === "independent").length;
    let acc = subs.length * config.lamportsPerSignature; // keep the sweep fees reserved
    const capped: PlannedWindow[] = [];
    let indep = 0;
    for (const w of keep) {
      if (w.arm === "independent" && indep >= oldIndep) continue; // sub-wallets were funded for oldIndep windows
      if (acc + perWindowMax(w) > budget.remaining) continue;
      acc += perWindowMax(w); capped.push(w); if (w.arm === "independent") indep++;
    }
    if (capped.length) { plan = { ...plan, windows: capped, currentSlot: cur2 }; fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan, null, 1)); }
    log("replanned_after_funding", { windows: plan.windows.length });
  }

  // ---- fire loop ----
  const clock = new SlotClock(rpc, config.wsUrl || wsFromHttp(config.rpcUrl), config.slotMs);
  await clock.start();
  await warmUp(config.sendRpcUrls);
  const recordsPath = path.join(dir, "probes.jsonl");
  const records: ProbeRecord[] = [];
  let nonce = 0; // self-transferred lamports (net 0); unique per probe within a run (and blockhash differs per window)
  let aborted: string | null = null;
  for (let wi = 0; wi < plan.windows.length; wi++) {
    const w = plan.windows[wi];
    if (clock.now() > w.fireSlot - 6) { log("window_skipped_late", { windowId: w.windowId, now: clock.now().toFixed(1), fireSlot: w.fireSlot }); continue; }
    await clock.waitForSlot(w.fireSlot - 12); // ~2.4s ahead: get blockhash, build, sign, reserve
    try {
      if (!config.dryRun && wi % 5 === 0) {
        const tot = (await balances(rpc, allKeys)).reduce((a, b) => a + b, 0);
        const spent = budget.checkOnchain(tot);
        log("onchain_spend_check", { spentLamports: spent, cap: budget.cap });
      }
      const bh = await rpc.call<any>("getLatestBlockhash", [{ commitment: "confirmed" }], { noThrottle: true });
      const probes: BuiltProbe[] = w.priorityBySendOrder.map((prio, k) => buildProbe({
        payer: w.arm === "independent" ? subs[k % subs.length] : payer!,
        recentBlockhash: bh.value.blockhash,
        cuLimit: config.cuLimit,
        priorityLamports: prio,
        loadedAccountsDataLimit: config.loadedAccountsDataLimit,
        nonce: ++nonce,
      }, config.lamportsPerSignature));
      if (!config.dryRun) budget.reserve(probes.map((p) => ({ kind: "probe", signature: p.signature, lamports: p.maxFeeLamports })));
      await clock.waitForSlot(w.fireSlot);
      const est = clock.now();
      const sends = await sendBurst(probes.map((p) => p.wireBase64), config.sendRpcUrls, w.sendGapMs, config.dryRun);
      probes.forEach((p, k) => {
        const rec: ProbeRecord = {
          runId, dryRun: config.dryRun, windowId: w.windowId, targetLeader: w.leader, targetClientClass: w.clientClass, targetClientVersion: w.clientVersion,
          windowStart: w.startSlot, windowEnd: w.endSlot, arm: w.arm, fireOffset: w.fireOffset, fireSlotPlanned: w.fireSlot, fireSlotEstimated: Number(est.toFixed(2)), sendGapMs: w.sendGapMs,
          sendIdx: k, priorityLamports: w.priorityBySendOrder[k], cuPrice: p.cuPriceMicroLamports, cuLimit: config.cuLimit, maxFeeLamports: p.maxFeeLamports,
          signature: p.signature, payer: p.payer, nonce: p.nonce, recentBlockhash: bh.value.blockhash, sends: sends[k],
        };
        records.push(rec);
        fs.appendFileSync(recordsPath, JSON.stringify(rec) + "\n");
      });
      log("burst", { windowId: w.windowId, client: w.clientVersion, arm: w.arm, off: w.fireOffset, gap: w.sendGapMs, fireSlot: w.fireSlot, est: est.toFixed(2), slotMs: clock.slotMs.toFixed(1), src: clock.source, reserved: budget.reserved });
    } catch (e: any) {
      if (e instanceof SpendCapExceeded) { aborted = e.message; log("SPEND_CAP_STOP", { msg: e.message }); break; }
      log("window_error", { windowId: plan.windows[wi].windowId, err: String(e?.message ?? e) });
    }
  }
  clock.stop();

  // ---- collection ----
  await collect(rpc, dir, records, plan.windows);

  // ---- sweep sub-wallets back ----
  if (!config.dryRun && needIndependent && (process.env.SWEEP_AFTER ?? "true") === "true") await sweep(rpc, payer, subs, budget);
  if (!config.dryRun) {
    const tot = (await balances(rpc, allKeys)).reduce((a, b) => a + b, 0);
    log("final_balance", { total: tot, spentOnchain: budget.initialBalance !== null ? budget.initialBalance - tot : null, reservedLedger: budget.reserved, cap: budget.cap });
  }
  log("run_done", { runId, probes: records.length, aborted });
}

export async function collect(rpc: Rpc, dir: string, records: ProbeRecord[], windows: PlannedWindow[]) {
  const blocksDir = path.join(dir, "blocks");
  const fullDir = config.saveFullBlocks ? path.join(dir, "blocks_full") : undefined;
  const slots = new Set<number>();
  if (records.length && !records[0].dryRun) {
    const st = await confirmSigs(rpc, records.map((r) => r.signature), config.statusTimeoutMs);
    for (const r of records) {
      const v = st.get(r.signature);
      r.landedSlot = v?.slot ?? null;
      r.status = v?.confirmationStatus ?? null;
      r.txErr = v?.err ?? null;
      if (r.landedSlot) slots.add(r.landedSlot);
    }
    fs.writeFileSync(path.join(dir, "probes_final.json"), JSON.stringify(records));
    log("statuses", { sent: records.length, landed: records.filter((r) => r.landedSlot).length });
  }
  // also fetch the target windows' own blocks (competition context; and in dry-run the only evidence)
  const maxCtx = Number(process.env.CONTEXT_BLOCKS_MAX ?? 400);
  for (const w of windows) for (let s = w.startSlot; s <= w.endSlot; s++) if (slots.size < maxCtx) slots.add(s);
  const sorted = [...slots].sort((a, b) => a - b);
  if (!sorted.length) return;
  // wait until the last slot is old enough
  const leaders = await slotLeaderMap(rpc, sorted[0], sorted[sorted.length - 1]);
  const index: any[] = [];
  for (const s of sorted) {
    try {
      const b = await fetchBlock(rpc, s, config.lamportsPerSignature, fullDir);
      if (!b) { index.push({ slot: s, leader: leaders.get(s), skipped: true }); continue; }
      b.leader = leaders.get(s);
      writeBlockSummary(blocksDir, b);
      index.push({ slot: s, leader: b.leader, nTx: b.nTx, blockhash: b.blockhash });
    } catch (e: any) { index.push({ slot: s, leader: leaders.get(s), error: String(e?.message ?? e) }); }
  }
  fs.writeFileSync(path.join(dir, "blocks_index.json"), JSON.stringify(index, null, 1));
  log("blocks_fetched", { n: index.length, skipped: index.filter((x) => x.skipped).length });
}

async function sweep(rpc: Rpc, payer: Keypair, subs: Keypair[], budget: Budget) {
  const bals = await balances(rpc, subs.map((s) => s.publicKey));
  for (let i = 0; i < subs.length; i++) {
    const amt = bals[i] - config.lamportsPerSignature;
    if (amt <= 0) continue;
    try {
      const bh = await rpc.call<any>("getLatestBlockhash", [{ commitment: "confirmed" }]);
      const t = buildTransfer(subs[i], payer.publicKey, amt, bh.value.blockhash);
      budget.reserve([{ kind: "sweep", signature: t.signature, lamports: config.lamportsPerSignature }]);
      await sendAndConfirmSimple(rpc, t.wireBase64, t.signature);
      log("swept", { i, lamports: amt, sig: t.signature });
    } catch (e: any) { log("sweep_failed", { i, err: String(e?.message ?? e) }); }
  }
}

export async function runReclaim() {
  const rpc = new Rpc(config.rpcUrl, config.rpcMaxRps);
  setLogFile(path.join(config.dataDir, "reclaim.log.jsonl"));
  const payer = loadPayer();
  if (!payer) throw new Error("no payer key");
  if (config.dryRun || !config.confirmSpend) throw new Error("reclaim sends transactions: needs DRY_RUN=false I_UNDERSTAND_THIS_SPENDS_SOL=yes");
  const subs = loadOrCreateSubWallets(config.subWalletsPath, 0, false);
  const budget = new Budget(path.join(config.dataDir, "spend_ledger.json"), Math.floor(config.maxSpendSol * LAMPORTS_PER_SOL), "reclaim");
  await sweep(rpc, payer, subs, budget);
}
