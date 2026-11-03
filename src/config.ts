// Central configuration. Every knob is an env var so docker-compose / .env controls the run.
// SAFETY: DRY_RUN defaults to true. Real sending requires DRY_RUN=false AND I_UNDERSTAND_THIS_SPENDS_SOL=yes.

function env(name: string, def: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? def : v;
}
function envNum(name: string, def: number): number {
  const v = Number(env(name, String(def)));
  if (!Number.isFinite(v)) throw new Error(`env ${name} is not a number`);
  return v;
}
function envBool(name: string, def: boolean): boolean {
  const v = env(name, def ? "true" : "false").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}
function envList(name: string, def: string): string[] {
  return env(name, def).split(",").map((s) => s.trim()).filter(Boolean);
}

export const LAMPORTS_PER_SOL = 1_000_000_000;

export const config = {
  // ---- safety ----
  dryRun: envBool("DRY_RUN", true),
  confirmSpend: env("I_UNDERSTAND_THIS_SPENDS_SOL", "no") === "yes",
  // Hard cap for the WHOLE experiment (all runs sharing the same ledger file), in SOL.
  maxSpendSol: envNum("MAX_SPEND_SOL", 0.05),
  // Safety margin: stop when the projected spend would exceed cap*(1-margin)
  spendSafetyMargin: envNum("SPEND_SAFETY_MARGIN", 0.0),

  // ---- network ----
  // Read RPC (leader schedule, blocks, statuses).
  rpcUrl: env("RPC_URL", "https://api.mainnet-beta.solana.com"),
  wsUrl: env("WS_URL", ""), // derived from rpcUrl if empty
  // Endpoints a transaction is submitted to (fan-out). Each is a JSON-RPC sendTransaction endpoint.
  sendRpcUrls: envList("SEND_RPC_URLS", "https://api.mainnet-beta.solana.com"),
  rpcMaxRps: envNum("RPC_MAX_RPS", 8),

  // ---- keys ----
  keypairPath: env("KEYPAIR_PATH", "/keys/payer.json"),
  subWalletsPath: env("SUBWALLETS_PATH", "/keys/subwallets.json"),

  // ---- experiment design ----
  minValidators: envNum("MIN_VALIDATORS", 6),
  minClients: envNum("MIN_CLIENTS", 3),
  // Max validators targeted per client class (to spread coverage).
  perClientTargets: envNum("PER_CLIENT_TARGETS", 2),
  // Repetitions (leader windows) per validator.
  windowsPerValidator: envNum("WINDOWS_PER_VALIDATOR", 12),
  // How far ahead to look for target windows (slots). 200ms slots → 18000 slots ≈ 60 min.
  lookaheadSlots: envNum("LOOKAHEAD_SLOTS", 18000),
  // Ignore windows starting sooner than this (slots), so we have time to prepare.
  minLeadSlots: envNum("MIN_LEAD_SLOTS", 40),
  // Fire offsets (slots relative to the first slot of the target window). Negative = before the
  // leader starts (tx waits in the leader's buffer), positive = while the leader is building.
  // Cycled per window so every validator gets every offset.
  fireSlotOffsets: envList("FIRE_SLOT_OFFSETS", "-1,1").map(Number),
  // Upper bound on client classes targeted, and optional explicit target identities.
  maxClientClasses: envNum("MAX_CLIENT_CLASSES", 6),
  targetIdentities: envList("TARGET_IDENTITIES", ""),
  excludeClients: envList("EXCLUDE_CLIENTS", "unknown"),
  // Minimum distance (slots) between two consecutive target windows, so bursts never overlap.
  minWindowGapSlots: envNum("MIN_WINDOW_GAP_SLOTS", 10),
  // Assumed slot duration used for timing estimates (ms); measured live and logged.
  slotMs: envNum("SLOT_MS", 200),
  // Probe transactions per window.
  txPerWindow: envNum("TX_PER_WINDOW", 8),
  // Gap between consecutive sends inside one burst (ms). Makes "send order" a real arrival-order signal.
  // Several values are cycled per window (dose-response: does a larger arrival spread make send order matter more?)
  sendGapsMs: envList("SEND_GAPS_MS", "0,20").map(Number),
  // Priority-fee levels in lamports (total priority fee per tx). Randomly permuted against send order.
  priorityLevelsLamports: envList("PRIORITY_LEVELS_LAMPORTS", "0,5,20,100,400,1500,5000,15000").map(Number),
  // Compute-unit limit requested by each probe (kept tight → small, equal cost for every probe).
  cuLimit: envNum("CU_LIMIT", 600),
  // Loaded-accounts-data-size limit (bytes). Small value keeps cost-model units low and equal.
  loadedAccountsDataLimit: envNum("LOADED_ACCOUNTS_DATA_LIMIT", 32768),
  // Arms: "independent" (each probe has its own fee payer → no write-lock conflicts)
  //       "conflict" (all probes share one fee payer → same write lock).
  arms: envList("ARMS", "independent,conflict"),
  // Base fee per signature (lamports).
  lamportsPerSignature: envNum("LAMPORTS_PER_SIGNATURE", 5000),

  // ---- collection ----
  statusTimeoutMs: envNum("STATUS_TIMEOUT_MS", 60_000),
  saveFullBlocks: envBool("SAVE_FULL_BLOCKS", false),
  // ---- passive survey (no sending; existing blocks) ----
  passiveBlocksPerClient: envNum("PASSIVE_BLOCKS_PER_CLIENT", 6),
  passiveRangeSlots: envNum("PASSIVE_RANGE_SLOTS", 3000),

  // ---- output ----
  dataDir: env("DATA_DIR", "/data"),
  runId: env("RUN_ID", ""),
  seed: env("SEED", ""),
};

export type Config = typeof config;
