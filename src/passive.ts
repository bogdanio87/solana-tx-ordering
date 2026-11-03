// Passive survey: no sending. Samples recent blocks produced by leaders of each client class and stores
// compact summaries. Supplementary evidence (third-party transactions) for the report.
import fs from "fs";
import path from "path";
import { config } from "./config";
import { log, setLogFile } from "./log";
import { Rpc } from "./rpc";
import { snapshotCluster, slotLeaderMap, clientClass, clientVersionLabel } from "./leaders";
import { fetchBlock, writeBlockSummary } from "./blocks";
import { makeRng } from "./rng";

export async function runPassive() {
  const runId = (config.runId || new Date().toISOString().replace(/[:.]/g, "-")) + "-passive";
  const dir = path.join(config.dataDir, "passive", runId);
  fs.mkdirSync(dir, { recursive: true });
  setLogFile(path.join(dir, "log.jsonl"));
  const rpc = new Rpc(config.rpcUrl, config.rpcMaxRps);
  const snap = await snapshotCluster(rpc);
  fs.writeFileSync(path.join(dir, "cluster_snapshot.json"), JSON.stringify(snap));
  const tip = await rpc.call<number>("getSlot", [{ commitment: "finalized" }]);
  const from = tip - config.passiveRangeSlots;
  const leaders = await slotLeaderMap(rpc, from, tip - 1);
  const byClass = new Map<string, number[]>();
  for (const [slot, l] of leaders) {
    const c = clientClass(snap.nodes[l]);
    if (!byClass.has(c)) byClass.set(c, []);
    byClass.get(c)!.push(slot);
  }
  const rng = makeRng(config.seed || runId);
  const index: any[] = [];
  for (const [c, slots] of byClass) {
    // prefer distinct leaders within a class; sample slots
    const pick = rng.shuffle(slots).slice(0, config.passiveBlocksPerClient);
    for (const s of pick.sort((a, b) => a - b)) {
      try {
        const b = await fetchBlock(rpc, s, config.lamportsPerSignature);
        const l = leaders.get(s)!;
        const rec: any = { slot: s, leader: l, clientClass: c, clientVersion: clientVersionLabel(snap.nodes[l]) };
        if (!b) { index.push({ ...rec, skipped: true }); continue; }
        b.leader = l;
        writeBlockSummary(path.join(dir, "blocks"), b);
        index.push({ ...rec, nTx: b.nTx });
        log("passive_block", { slot: s, client: rec.clientVersion, nTx: b.nTx });
      } catch (e: any) { log("passive_block_error", { slot: s, err: String(e?.message ?? e) }); }
    }
  }
  fs.writeFileSync(path.join(dir, "blocks_index.json"), JSON.stringify(index, null, 1));
  log("passive_done", { blocks: index.length, classes: [...byClass.keys()].join(",") });
}
