// Target selection and per-window experiment plan.
import { config } from "./config";
import { ClusterSnapshot, LeaderWindow, clientClass, clientVersionLabel } from "./leaders";
import { makeRng } from "./rng";

export interface PlannedWindow {
  windowId: string;
  leader: string;
  clientClass: string;
  clientVersion: string;
  startSlot: number;
  endSlot: number;
  arm: string; // independent | conflict
  fireOffset: number; // slots relative to startSlot
  fireSlot: number;
  sendGapMs: number;
  // priorityLamports[i] = priority fee of the i-th transaction in SEND order
  priorityBySendOrder: number[];
}

export interface Plan {
  createdAt: string;
  seed: string;
  currentSlot: number;
  targets: { identity: string; clientClass: string; clientVersion: string; stakeSol: number; windowsAvailable: number }[];
  windows: PlannedWindow[];
  clientsCovered: string[];
  warnings: string[];
}

export function buildPlan(snap: ClusterSnapshot, windows: LeaderWindow[], currentSlot: number, seed: string, fixedTargets?: string[]): Plan {
  const rng = makeRng(seed);
  const warnings: string[] = [];
  const lo = currentSlot + config.minLeadSlots;
  const candidates = windows.filter((w) => w.startSlot >= lo);
  const byLeader = new Map<string, LeaderWindow[]>();
  for (const w of candidates) {
    if (!byLeader.has(w.leader)) byLeader.set(w.leader, []);
    byLeader.get(w.leader)!.push(w);
  }
  const node = (id: string) => snap.nodes[id];

  let chosen: string[] = [];
  const explicit = fixedTargets ?? config.targetIdentities;
  if (explicit.length) {
    chosen = explicit.filter((id) => byLeader.has(id));
    const missing = explicit.filter((id) => !byLeader.has(id));
    if (missing.length) warnings.push(`explicit targets without windows in lookahead: ${missing.join(",")}`);
  } else {
    // group leaders by client class
    const byClass = new Map<string, string[]>();
    for (const id of byLeader.keys()) {
      const c = clientClass(node(id));
      if (config.excludeClients.includes(c) || c.startsWith("Unknown(")) continue; // unrecognised client id → not a usable class
      if (!byClass.has(c)) byClass.set(c, []);
      byClass.get(c)!.push(id);
    }
    // rank classes by how many leaders have enough windows, then by leader count
    const enough = (id: string) => (byLeader.get(id)!.length >= config.windowsPerValidator ? 1 : 0);
    const classes = [...byClass.entries()]
      .map(([c, ids]) => ({ c, ids, score: ids.reduce((a, id) => a + enough(id), 0) * 1000 + ids.length }))
      .sort((a, b) => b.score - a.score)
      .slice(0, config.maxClientClasses);
    for (const { ids } of classes) {
      // prefer leaders with most windows; within class prefer distinct versions
      const sorted = ids.slice().sort((a, b) => byLeader.get(b)!.length - byLeader.get(a)!.length);
      const picked: string[] = [];
      const versions = new Set<string>();
      for (const id of sorted) {
        if (picked.length >= config.perClientTargets) break;
        const v = node(id)?.version ?? "?";
        // a second, distinct version is only worth it if that leader has enough windows to give a verdict
        if (picked.length > 0 && byLeader.get(id)!.length < Math.min(6, config.windowsPerValidator)) continue;
        if (!versions.has(v) || sorted.length - sorted.indexOf(id) <= config.perClientTargets - picked.length) {
          picked.push(id);
          versions.add(v);
        }
      }
      for (const id of sorted) if (picked.length < config.perClientTargets && !picked.includes(id)) picked.push(id);
      chosen.push(...picked);
    }
    // top up to minValidators
    if (chosen.length < config.minValidators) {
      const rest = [...byLeader.keys()]
        .filter((id) => !chosen.includes(id) && !config.excludeClients.includes(clientClass(node(id))))
        .sort((a, b) => byLeader.get(b)!.length - byLeader.get(a)!.length);
      chosen.push(...rest.slice(0, config.minValidators - chosen.length));
    }
  }

  // pick windows, enforce min gap between bursts
  const all: LeaderWindow[] = [];
  for (const id of chosen) all.push(...byLeader.get(id)!.slice(0, config.windowsPerValidator * 3));
  all.sort((a, b) => a.startSlot - b.startSlot);
  const perLeaderCount = new Map<string, number>();
  const picked: PlannedWindow[] = [];
  let lastStart = -1e12;
  const combos: { arm: string; off: number; gap: number }[] = [];
  for (const gap of config.sendGapsMs) for (const arm of config.arms) for (const off of config.fireSlotOffsets) combos.push({ arm, off, gap });
  for (const w of all) {
    const k = perLeaderCount.get(w.leader) ?? 0;
    if (k >= config.windowsPerValidator) continue;
    if (w.startSlot - lastStart < config.minWindowGapSlots) continue;
    const combo = combos[k % combos.length];
    const levels = config.priorityLevelsLamports.slice(0, config.txPerWindow);
    while (levels.length < config.txPerWindow) levels.push(config.priorityLevelsLamports[levels.length % config.priorityLevelsLamports.length]);
    const n = node(w.leader);
    picked.push({
      windowId: `${w.startSlot}-${w.leader.slice(0, 6)}`,
      leader: w.leader,
      clientClass: clientClass(n),
      clientVersion: clientVersionLabel(n),
      startSlot: w.startSlot,
      endSlot: w.endSlot,
      arm: combo.arm,
      fireOffset: combo.off,
      fireSlot: w.startSlot + combo.off,
      sendGapMs: combo.gap,
      priorityBySendOrder: rng.shuffle(levels),
    });
    perLeaderCount.set(w.leader, k + 1);
    lastStart = w.startSlot;
  }
  const targets = chosen.map((id) => ({
    identity: id,
    clientClass: clientClass(node(id)),
    clientVersion: clientVersionLabel(node(id)),
    stakeSol: (node(id)?.activatedStake ?? 0) / 1e9,
    windowsAvailable: byLeader.get(id)?.length ?? 0,
  }));
  const clientsCovered = [...new Set(targets.map((t) => t.clientVersion))];
  const classesCovered = new Set(targets.map((t) => t.clientClass));
  if (targets.length < config.minValidators) warnings.push(`only ${targets.length} validators (< ${config.minValidators})`);
  if (clientsCovered.length < config.minClients) warnings.push(`only ${clientsCovered.length} client versions (< ${config.minClients})`);
  if (classesCovered.size < config.minClients) warnings.push(`only ${classesCovered.size} client classes (< ${config.minClients})`);
  for (const t of targets) {
    const c = perLeaderCount.get(t.identity) ?? 0;
    if (c < config.windowsPerValidator) warnings.push(`${t.identity} (${t.clientVersion}) only ${c}/${config.windowsPerValidator} windows in lookahead`);
  }
  return { createdAt: new Date().toISOString(), seed, currentSlot, targets, windows: picked, clientsCovered, warnings };
}
