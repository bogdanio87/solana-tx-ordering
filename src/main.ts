import { config } from "./config";
import { runExperiment, runReclaim, runCollect } from "./experiment";
import { runPassive } from "./passive";
import { Rpc } from "./rpc";
import { snapshotCluster, upcomingWindows } from "./leaders";
import { buildPlan } from "./plan";
import { loadOrCreateKeypair } from "./wallet";

async function main() {
  const mode = process.argv[2] ?? process.env.MODE ?? "experiment";
  switch (mode) {
    case "experiment": return runExperiment();
    case "passive": return runPassive();
    case "reclaim": return runReclaim();
    case "collect": return runCollect();
    case "keygen": {
      const kp = loadOrCreateKeypair(config.keypairPath, true)!;
      console.log(`payer public key: ${kp.publicKey.toBase58()}  (secret stays in ${config.keypairPath})`);
      return;
    }
    case "plan": {
      const rpc = new Rpc(config.rpcUrl, config.rpcMaxRps);
      const snap = await snapshotCluster(rpc);
      const cur = await rpc.call<number>("getSlot", [{ commitment: "processed" }]);
      const { windows } = await upcomingWindows(rpc, cur, config.lookaheadSlots);
      const plan = buildPlan(snap, windows, cur, config.seed || "plan");
      console.log(JSON.stringify({ targets: plan.targets, windows: plan.windows.length, warnings: plan.warnings }, null, 1));
      return;
    }
    default: throw new Error(`unknown mode ${mode}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error("FATAL", e?.stack ?? e); process.exit(1); });
