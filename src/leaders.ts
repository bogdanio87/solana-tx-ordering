// Leader schedule + client/version detection from public RPC.
import { Rpc } from "./rpc";

export interface NodeInfo {
  identity: string;
  clientId: string | null; // gossip-advertised client id (Agave, JitoLabs, Firedancer, AgaveBam, ...)
  version: string | null;
  featureSet: number | null;
  tpuQuic: string | null;
  votePubkey?: string;
  activatedStake?: number; // lamports
  commission?: number;
}

export interface ClusterSnapshot {
  takenAt: string;
  slot: number;
  epoch: number;
  nodes: Record<string, NodeInfo>;
}

/** Client "class" used for the >=3 distinct clients requirement: gossip clientId + major.minor version. */
export function clientClass(n: NodeInfo | undefined): string {
  if (!n) return "unknown";
  return n.clientId ?? "unknown";
}
export function clientVersionLabel(n: NodeInfo | undefined): string {
  if (!n) return "unknown";
  return `${n.clientId ?? "unknown"} ${n.version ?? "?"}`;
}

export async function snapshotCluster(rpc: Rpc): Promise<ClusterSnapshot> {
  const [nodes, votes, epochInfo] = await Promise.all([
    rpc.call<any[]>("getClusterNodes"),
    rpc.call<any>("getVoteAccounts", [{ commitment: "confirmed" }]),
    rpc.call<any>("getEpochInfo", [{ commitment: "confirmed" }]),
  ]);
  const map: Record<string, NodeInfo> = {};
  for (const n of nodes) {
    map[n.pubkey] = {
      identity: n.pubkey,
      clientId: n.clientId ?? null,
      version: n.version ?? null,
      featureSet: n.featureSet ?? null,
      tpuQuic: n.tpuQuic ?? null,
    };
  }
  for (const v of [...votes.current, ...votes.delinquent]) {
    const m = map[v.nodePubkey] ?? (map[v.nodePubkey] = { identity: v.nodePubkey, clientId: null, version: null, featureSet: null, tpuQuic: null });
    m.votePubkey = v.votePubkey;
    m.activatedStake = v.activatedStake;
    m.commission = v.commission;
  }
  return { takenAt: new Date().toISOString(), slot: epochInfo.absoluteSlot, epoch: epochInfo.epoch, nodes: map };
}

export interface LeaderWindow {
  leader: string;
  startSlot: number;
  endSlot: number; // inclusive
}

/** getSlotLeaders in chunks (max 5000 per call), grouped into consecutive-slot windows. */
export async function upcomingWindows(rpc: Rpc, fromSlot: number, count: number): Promise<{ leaders: string[]; windows: LeaderWindow[] }> {
  const leaders: string[] = [];
  let s = fromSlot;
  let remaining = count;
  while (remaining > 0) {
    const n = Math.min(5000, remaining);
    const chunk = await rpc.call<string[]>("getSlotLeaders", [s, n]);
    leaders.push(...chunk);
    s += n;
    remaining -= n;
  }
  const windows: LeaderWindow[] = [];
  for (let i = 0; i < leaders.length; i++) {
    const slot = fromSlot + i;
    const last = windows[windows.length - 1];
    // Leader rotations are 4-slot aligned (NUM_CONSECUTIVE_LEADER_SLOTS); a leader scheduled for two
    // consecutive rotations is treated as two windows.
    if (last && last.leader === leaders[i] && last.endSlot === slot - 1 && slot % 4 !== 0) last.endSlot = slot;
    else windows.push({ leader: leaders[i], startSlot: slot, endSlot: slot });
  }
  return { leaders, windows };
}

/** Leader map for an arbitrary slot range (used to attribute landed blocks). */
export async function slotLeaderMap(rpc: Rpc, fromSlot: number, toSlot: number): Promise<Map<number, string>> {
  const { leaders } = await upcomingWindows(rpc, fromSlot, toSlot - fromSlot + 1);
  const m = new Map<number, string>();
  leaders.forEach((l, i) => m.set(fromSlot + i, l));
  return m;
}
