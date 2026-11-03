#!/usr/bin/env python3
"""Analysis of transaction ordering.

Inputs  (DATA_DIR, default ./data):
  runs/<run>/probes.jsonl, probes_final.json, plan.json, cluster_snapshot.json, blocks/<slot>.json.gz
  passive/<run>/blocks/<slot>.json.gz, blocks_index.json, cluster_snapshot.json
Outputs (OUT_DIR, default ./analysis/out):
  results.md, results.json, *.csv, *.png
Everything is derived from the raw files, so every number can be re-checked with getBlock.
"""
import glob, gzip, json, math, os, sys
from collections import defaultdict
from itertools import combinations

import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from scipy import stats

DATA = os.environ.get("DATA_DIR", "./data")
OUT = os.environ.get("OUT_DIR", "./analysis/out")
os.makedirs(OUT, exist_ok=True)
md = []  # markdown lines


def wilson(k, n, z=1.96):
    if n == 0:
        return (float("nan"), float("nan"), float("nan"))
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (p, max(0, c - h), min(1, c + h))


def fmt_ci(t):
    p, lo, hi = t
    if math.isnan(p):
        return "n/a"
    return f"{p:.2f} [{lo:.2f}-{hi:.2f}]"


def load_block(path):
    with gzip.open(path, "rt") as f:
        return json.load(f)


def snapshot_nodes(path):
    try:
        return json.load(open(path))["nodes"]
    except Exception:
        return {}


def client_of(nodes, ident):
    n = nodes.get(ident) or {}
    c = n.get("clientId") or "unknown"
    if c.startswith("Unknown("):
        c = "Unknown(numeric id)"  # gossip client id not recognised by the RPC node; varies between snapshots
    return c, f'{c} {n.get("version") or "?"}'


# ---------------------------------------------------------------- passive (third-party txs)
def block_metrics(b):
    txs = [t for t in b["txs"] if not t.get("vote")]
    if len(txs) < 10:
        return None
    pos = np.array([t["i"] for t in txs], dtype=float)
    cost = np.array([max(1, t.get("cost") or 1) for t in txs], dtype=float)
    prio = np.array([t["prio"] for t in txs], dtype=float)
    ppc = prio / cost  # lamports of priority fee per cost-model unit (≈ scheduler priority)
    rho = stats.spearmanr(pos, ppc).statistic
    # adjacent-pair test: fraction of consecutive tx pairs in non-increasing priority
    d = np.diff(ppc)
    dn = d[d != 0]
    noninc = float(np.mean(dn < 0)) if len(dn) else float("nan")  # among adjacent pairs with distinct priority
    def local_rho(k):
        vals = []
        for s0 in range(0, len(ppc) - k + 1, k):
            seg = ppc[s0:s0 + k]
            if np.ptp(seg) > 0:
                vals.append(stats.spearmanr(np.arange(k), seg).statistic)
        return float(np.mean(vals)) if vals else float("nan")
    # longest prefix-free "monotone run": fraction of block covered by runs of non-increasing ppc of length>=5
    runs, cur = [], 1
    for x in d:
        if x <= 0:
            cur += 1
        else:
            runs.append(cur); cur = 1
    runs.append(cur)
    mono_cov = sum(r for r in runs if r >= 5) / len(ppc)
    # rho over first/second half separately
    half = len(ppc) // 2
    rho_first = stats.spearmanr(pos[:half], ppc[:half]).statistic if half > 5 else float("nan")
    jito = [t["i"] for t in txs if t.get("jitoTip")]
    return dict(n=len(txs), rho=rho, noninc_adjacent=noninc, local_rho8=local_rho(8), local_rho32=local_rho(32), mono_cov=mono_cov, rho_first_half=rho_first,
                zero_prio_share=float(np.mean(prio == 0)), median_ppc=float(np.median(ppc)),
                jito_tip_txs=len(jito), jito_tip_mean_relpos=float(np.mean(np.array(jito) / max(1, b["nTx"] - 1))) if jito else float("nan"))


def passive():
    rows, decile_rows, seen = [], [], set()
    for run in sorted(glob.glob(os.path.join(DATA, "passive", "*"))):
        nodes = snapshot_nodes(os.path.join(run, "cluster_snapshot.json"))
        for p in sorted(glob.glob(os.path.join(run, "blocks", "*.json.gz"))):
            b = load_block(p)
            if b["slot"] in seen:  # overlapping passive runs: count each block once
                continue
            seen.add(b["slot"])
            m = block_metrics(b)
            if not m:
                continue
            cc, cv = client_of(nodes, b.get("leader"))
            rows.append(dict(run=os.path.basename(run), slot=b["slot"], leader=b.get("leader"), client=cc, client_version=cv, blockTime=b.get("blockTime"), **m))
            txs = [t for t in b["txs"] if not t.get("vote")]
            n = len(txs)
            ppc = np.array([t["prio"] / max(1, t.get("cost") or 1) for t in txs])
            pct = stats.rankdata(ppc) / n
            for k, t in enumerate(txs):
                decile_rows.append(dict(client=cc, reldec=min(9, int(10 * k / n)), ppc_pct=pct[k]))
    if not rows:
        md.append("_No passive data._\n")
        return pd.DataFrame()
    df = pd.DataFrame(rows)
    df.to_csv(os.path.join(OUT, "passive_blocks.csv"), index=False)
    g = df.groupby("client").agg(blocks=("slot", "count"), leaders=("leader", "nunique"), median_rho=("rho", "median"),
                                 q25_rho=("rho", lambda x: x.quantile(.25)), q75_rho=("rho", lambda x: x.quantile(.75)),
                                 local_rho8=("local_rho8", "median"), local_rho32=("local_rho32", "median"),
                                 dec_adjacent=("noninc_adjacent", "median"), mono_cov=("mono_cov", "median"),
                                 zero_prio=("zero_prio_share", "median"), txs_per_block=("n", "median")).sort_values("median_rho")
    md.append("## Passive survey (third-party transactions, supplementary)\n")
    md.append(f"Blocks: {len(df)}; slots {df.slot.min()}-{df.slot.max()}; blockTime {pd.to_datetime(df.blockTime.min(), unit='s')} – {pd.to_datetime(df.blockTime.max(), unit='s')} UTC.\n")
    md.append("Spearman ρ between position-in-block and priority-fee-per-cost-unit (negative = higher priority earlier). "
              "`local_rho8/32` = mean ρ inside consecutive chunks of 8/32 txs (local sortedness). "
              "`dec_adjacent` = among adjacent pairs with different priority, share where priority decreases (0.5 = random). "
              "`mono_cov` = share of block covered by runs of ≥5 consecutive non-increasing-priority txs.\n")
    md.append(g.round(3).to_markdown() + "\n")
    # chart: rho per client
    order = g.index.tolist()
    fig, ax = plt.subplots(figsize=(10, 4.5))
    ax.boxplot([df[df.client == c].rho.dropna() for c in order], tick_labels=order)
    ax.axhline(0, color="grey", lw=.8)
    ax.set_ylabel("Spearman ρ(position, prio/cost)")
    ax.set_title("Passive: does priority predict position? (each point = one block)")
    plt.xticks(rotation=30, ha="right"); plt.tight_layout()
    plt.savefig(os.path.join(OUT, "passive_rho_by_client.png"), dpi=130); plt.close()
    dd0 = pd.DataFrame(decile_rows)
    fd = dd0[dd0.reldec == 0].groupby("client").ppc_pct.mean().round(2).sort_values(ascending=False)
    md.append("First decile of each block: mean within-block priority percentile of its txs (0.5 = no relation; all blocks: "
              f"{dd0[dd0.reldec == 0].ppc_pct.mean():.2f}).\n")
    md.append(fd.to_frame("first_decile_prio_pct").to_markdown() + "\n")
    # chart: mean priority percentile by position decile
    dd = pd.DataFrame(decile_rows).groupby(["client", "reldec"]).ppc_pct.mean().unstack(0)
    fig, ax = plt.subplots(figsize=(9, 4.5))
    for c in dd.columns:
        ax.plot(dd.index * 10 + 5, dd[c], marker="o", label=c)
    ax.axhline(0.5, color="grey", lw=.8, ls="--")
    ax.set_xlabel("position in block (percentile)"); ax.set_ylabel("mean priority percentile within block")
    ax.set_title("Passive: priority vs position, by client"); ax.legend(fontsize=7, ncol=2); plt.tight_layout()
    plt.savefig(os.path.join(OUT, "passive_priority_by_position.png"), dpi=130); plt.close()
    # example scatter, one block per client
    clients = df.client.unique().tolist()
    fig, axes = plt.subplots(int(math.ceil(len(clients) / 3)), 3, figsize=(13, 3.2 * math.ceil(len(clients) / 3)), squeeze=False)
    for ax, c in zip(axes.flat, clients):
        row = df[df.client == c].sort_values("n").iloc[len(df[df.client == c]) // 2]
        run = os.path.join(DATA, "passive", row.run)
        b = load_block(os.path.join(run, "blocks", f"{row.slot}.json.gz"))
        txs = [t for t in b["txs"] if not t.get("vote")]
        ax.scatter([t["i"] for t in txs], [max(1e-4, t["prio"] / max(1, t.get("cost") or 1)) for t in txs], s=6,
                   c=["red" if t.get("jitoTip") else "C0" for t in txs])
        ax.set_yscale("log"); ax.set_title(f"{c} slot {row.slot} ρ={row.rho:.2f}", fontsize=8)
    for ax in list(axes.flat)[len(clients):]:
        ax.axis("off")
    fig.supxlabel("position in block"); fig.supylabel("priority lamports / cost unit (log)")
    plt.tight_layout(); plt.savefig(os.path.join(OUT, "passive_example_blocks.png"), dpi=120); plt.close()
    return df


# ---------------------------------------------------------------- active (own probes)
def load_runs():
    probes, blocks, plans = [], {}, []
    for run in sorted(glob.glob(os.path.join(DATA, "runs", "*"))):
        rid = os.path.basename(run)
        fin = os.path.join(run, "probes_final.json")
        if os.path.exists(fin):
            recs = json.load(open(fin))
        elif os.path.exists(os.path.join(run, "probes.jsonl")):
            recs = [json.loads(l) for l in open(os.path.join(run, "probes.jsonl"))]
        else:
            continue
        nodes = snapshot_nodes(os.path.join(run, "cluster_snapshot.json"))
        for r in recs:
            r["_run"] = rid
            r["_nodes"] = nodes
        probes += recs
        for p in glob.glob(os.path.join(run, "blocks", "*.json.gz")):
            b = load_block(p)
            blocks[(rid, b["slot"])] = b
    return probes, blocks


def active():
    probes, blocks = load_runs()
    if not probes:
        md.append("## Active experiment\n\n_No probe data yet._\n")
        return
    live = [p for p in probes if not p.get("dryRun")]
    dry = [p for p in probes if p.get("dryRun")]
    if dry:
        d = pd.DataFrame([{k: v for k, v in p.items() if not k.startswith("_") and k != "sends"} for p in dry])
        d["fire_err_slots"] = d.fireSlotEstimated - d.fireSlotPlanned
        md.append("## Dry-run timing (no transactions sent)\n")
        md.append(f"Dry-run bursts: {d.windowId.nunique()} windows, {len(d)} probes built & signed (not sent). "
                  f"Fire error vs plan (slots): median {d.fire_err_slots.median():.2f}, max {d.fire_err_slots.max():.2f}.\n")
        md.append(d.groupby("targetClientVersion").agg(windows=("windowId", "nunique"), probes=("signature", "count")).to_markdown() + "\n")
    if not live:
        md.append("## Active experiment\n\n_No live probes yet (dry-run only)._\n")
        return
    # index block positions
    rows = []
    for p in live:
        rid = p["_run"]
        slot = p.get("landedSlot")
        b = blocks.get((rid, slot)) if slot else None
        pos = None; ntx = None; leader = None; better_before = None; worse_after = None; others_before = None
        if b:
            leader = b.get("leader")
            ntx = b["nTx"]
            idx = {t["sig"]: t for t in b["txs"]}
            t = idx.get(p["signature"])
            if t:
                pos = t["i"]
                my = t["prio"] / max(1, t.get("cost") or 1)
                own = {q["signature"] for q in live}
                others = [o for o in b["txs"] if o["sig"] not in own and not o.get("vote")]
                before = [o for o in others if o["i"] < pos]
                after = [o for o in others if o["i"] > pos]
                # strictness: lower-priority third-party txs placed before us, higher-priority placed after us
                better_before = sum(1 for o in before if o["prio"] / max(1, o.get("cost") or 1) < my) / max(1, len(before)) if before else None
                worse_after = sum(1 for o in after if o["prio"] / max(1, o.get("cost") or 1) > my) / max(1, len(after)) if after else None
                others_before = len(before)
                p["_cost"] = t.get("cost"); p["_cu"] = t.get("cu")
        lc, lv = client_of(p["_nodes"], leader) if leader else (None, None)
        sends = p.get("sends") or []
        rows.append(dict(run=rid, windowId=p["windowId"], target=p["targetLeader"], target_client=p["targetClientClass"], target_version=p["targetClientVersion"],
                         arm=p["arm"], fireOffset=p["fireOffset"], gap=p.get("sendGapMs"), sendIdx=p["sendIdx"], prio=p["priorityLamports"], cuPrice=p["cuPrice"], sig=p["signature"],
                         fireSlot=p["fireSlotPlanned"], windowStart=p["windowStart"], windowEnd=p["windowEnd"], landedSlot=slot, status=p.get("status"),
                         txErr=json.dumps(p.get("txErr")) if p.get("txErr") else None, pos=pos, blockTx=ntx, leader=leader, leader_client=lc, leader_version=lv,
                         in_target=bool(slot and p["windowStart"] <= slot <= p["windowEnd"]), slot_off=(slot - p["windowStart"]) if slot else None,
                         send_t=min((s["tStartMs"] for s in sends), default=None), send_ok=any(s.get("ok") for s in sends),
                         lower_prio_before_share=better_before, higher_prio_after_share=worse_after, others_before=others_before, cost=p.get("_cost")))
    df = pd.DataFrame(rows)
    df.to_csv(os.path.join(OUT, "probes.csv"), index=False)
    md.append("## Active experiment (own probe transactions)\n")
    md.append(f"Live probes: {len(df)} in {df.windowId.nunique()} windows; landed {df.landedSlot.notna().sum()} "
              f"({df.landedSlot.notna().mean():.0%}); landed inside target window {df.in_target.sum()} ({df.in_target.mean():.0%}).\n")
    md.append(f"Measurement period (UTC): {pd.to_datetime(df.send_t.min(), unit='ms')} – {pd.to_datetime(df.send_t.max(), unit='ms')}.\n")
    # landing table
    lt = df.groupby("target_version").agg(windows=("windowId", "nunique"), probes=("sig", "count"), landed=("landedSlot", lambda x: x.notna().mean()),
                                          in_target=("in_target", "mean"), median_slot_off=("slot_off", "median")).round(2)
    md.append("### Landing by target\n" + lt.to_markdown() + "\n")
    inc = df.groupby("prio").agg(landed=("landedSlot", lambda x: x.notna().mean()), n=("sig", "count")).round(2)
    md.append("### Inclusion vs priority fee (lamports)\n" + inc.to_markdown() + "\n")
    fo = df.groupby(["fireOffset"]).agg(n=("sig", "count"), landed=("landedSlot", lambda x: x.notna().mean()), in_target=("in_target", "mean"), med_off=("slot_off", "median")).round(2)
    md.append("### Fire offset vs landing\n" + fo.to_markdown() + "\n")
    # slot offset histogram
    fig, ax = plt.subplots(figsize=(8, 3.5))
    for off, g in df[df.landedSlot.notna()].groupby("fireOffset"):
        ax.hist(g.slot_off, bins=range(-8, 14), alpha=.6, label=f"fire offset {off}")
    ax.axvspan(-0.5, 3.5, color="green", alpha=.08, label="target window")
    ax.set_xlabel("landed slot − target window start"); ax.legend(); plt.tight_layout()
    plt.savefig(os.path.join(OUT, "active_slot_offset.png"), dpi=130); plt.close()

    # ---- pairwise ordering within the same block, same window ----
    pairs = []
    land = df[df.pos.notna()]
    for (wid, slot), g in land.groupby(["windowId", "landedSlot"]):
        for a, b in combinations(g.itertuples(), 2):
            if a.prio == b.prio:
                continue
            a_first = a.pos < b.pos
            hi_first = (a.prio > b.prio) == a_first
            early_first = (a.sendIdx < b.sendIdx) == a_first
            agree = (a.prio > b.prio) == (a.sendIdx < b.sendIdx)  # fee rule and send-order rule predict the same
            pairs.append(dict(windowId=wid, slot=slot, leader=a.leader, leader_client=a.leader_client, leader_version=a.leader_version, arm=a.arm,
                              fireOffset=a.fireOffset, gap=a.gap, hi_first=hi_first, early_first=early_first, agree=agree,
                              dpos=abs(a.pos - b.pos), logratio=abs(math.log((a.prio + 1) / (b.prio + 1)))))
    # cross-slot (same window, different slots): did the higher-priority probe land in the earlier slot?
    xs = []
    for wid, g in land.groupby("windowId"):
        for a, b in combinations(g.itertuples(), 2):
            if a.landedSlot == b.landedSlot or a.prio == b.prio:
                continue
            xs.append(dict(windowId=wid, target_version=a.target_version, hi_earlier_slot=(a.prio > b.prio) == (a.landedSlot < b.landedSlot),
                           early_sent_earlier_slot=(a.sendIdx < b.sendIdx) == (a.landedSlot < b.landedSlot)))
    if not pairs:
        md.append("_No block contains two or more probes of the same burst; no pairwise ordering evidence._\n")
        return
    P = pd.DataFrame(pairs)
    P.to_csv(os.path.join(OUT, "pairs.csv"), index=False)
    out = []
    for key, g in P.groupby(["leader_version", "leader"]):
        dis = g[~g.agree]
        out.append(dict(leader_version=key[0], leader=key[1][:8], blocks=g.slot.nunique(), pairs=len(g),
                        P_higher_fee_first=fmt_ci(wilson(g.hi_first.sum(), len(g))),
                        P_earlier_sent_first=fmt_ci(wilson(g.early_first.sum(), len(g))),
                        disagree_pairs=len(dis), P_fee_wins_when_disagree=fmt_ci(wilson(dis.hi_first.sum(), len(dis))),
                        verdict=verdict(g)))
    T = pd.DataFrame(out).sort_values("leader_version")
    # per-condition verdicts: the cleanest test of the scheduler's priority rule is the conflict arm with
    # gap 0 (all probes contend for one write lock and arrive together); gap 20 shows whether arrival dominates.
    V = []
    for key, g in P.groupby(["leader_version", "leader", "arm", "gap"]):
        dis = g[~g.agree]
        V.append(dict(leader_version=key[0], leader=key[1][:8], arm=key[2], send_gap_ms=key[3], blocks=g.slot.nunique(), pairs=len(g),
                      P_higher_fee_first=fmt_ci(wilson(g.hi_first.sum(), len(g))), P_earlier_sent_first=fmt_ci(wilson(g.early_first.sum(), len(g))),
                      P_fee_wins_when_disagree=fmt_ci(wilson(dis.hi_first.sum(), len(dis))), verdict=verdict(g)))
    pd.DataFrame(V).to_csv(os.path.join(OUT, "verdicts_by_condition.csv"), index=False)
    md.append("### Pairwise ordering of own probes in the same block (per validator)\n")
    md.append("`P_fee_wins_when_disagree` is the decisive test: pairs where the fee rule and the arrival (send-order) rule predict opposite orders. "
              "95% Wilson intervals.\n")
    md.append(T.to_markdown(index=False) + "\n")
    md.append("### Per validator and condition (arm × send gap)\n" + pd.DataFrame(V).to_markdown(index=False) + "\n")
    # per client class
    C = []
    for key, g in P.groupby("leader_client"):
        dis = g[~g.agree]
        C.append(dict(client=key, validators=g.leader.nunique(), blocks=g.slot.nunique(), pairs=len(g),
                      P_higher_fee_first=fmt_ci(wilson(g.hi_first.sum(), len(g))), P_fee_wins_when_disagree=fmt_ci(wilson(dis.hi_first.sum(), len(dis))),
                      P_earlier_sent_first=fmt_ci(wilson(g.early_first.sum(), len(g)))))
    md.append("### Per client class\n" + pd.DataFrame(C).to_markdown(index=False) + "\n")
    # headline: client class x condition, decisive statistic + verdict, and a heatmap
    H = []
    for key, g in P.groupby(["leader_client", "arm", "gap"]):
        dis = g[~g.agree]
        pf, lo, hi = wilson(dis.hi_first.sum(), len(dis))
        H.append(dict(client=key[0], arm=key[1], send_gap_ms=key[2], validators=g.leader.nunique(), blocks=g.slot.nunique(), pairs=len(g),
                      disagree_pairs=len(dis), P_fee_wins_when_disagree=fmt_ci((pf, lo, hi)),
                      P_earlier_sent_first=fmt_ci(wilson(g.early_first.sum(), len(g))), verdict=verdict(g), _p=pf, _n=len(dis)))
    Hd = pd.DataFrame(H)
    Hd.drop(columns=["_p", "_n"]).to_csv(os.path.join(OUT, "verdicts_by_client_condition.csv"), index=False)
    md.append("### Headline: client class × condition\n`conflict` = all 8 probes write-lock one account; `independent` = 8 separate payers. "
              "gap 0 = probes sent together (arrival order ≈ noise); gap 20 ms = arrival order is a controlled variable.\n"
              + Hd.drop(columns=["_p", "_n"]).to_markdown(index=False) + "\n")
    conds = [("conflict", 0), ("conflict", 20), ("independent", 0), ("independent", 20)]
    clients = sorted(Hd.client.unique())
    M = np.full((len(clients), len(conds)), np.nan); N = np.zeros_like(M)
    for _, r in Hd.iterrows():
        if (r.arm, r.send_gap_ms) in conds:
            M[clients.index(r.client), conds.index((r.arm, r.send_gap_ms))] = r._p; N[clients.index(r.client), conds.index((r.arm, r.send_gap_ms))] = r._n
    fig, ax = plt.subplots(figsize=(7.5, 0.55 * len(clients) + 1.6))
    im = ax.imshow(M, cmap="RdBu_r", vmin=0, vmax=1, aspect="auto")
    for i in range(len(clients)):
        for j in range(len(conds)):
            if not np.isnan(M[i, j]):
                ax.text(j, i, f"{M[i, j]:.2f}\nn={int(N[i, j])}", ha="center", va="center", fontsize=8)
    ax.set_xticks(range(len(conds))); ax.set_xticklabels([f"{a}\ngap {g} ms" for a, g in conds], fontsize=8)
    ax.set_yticks(range(len(clients))); ax.set_yticklabels(clients, fontsize=8)
    plt.colorbar(im, ax=ax, label="P(higher fee first | fee and send order disagree)")
    ax.set_title("1 = fee decides (red), 0 = arrival decides (blue), 0.5 = neither", fontsize=9); plt.tight_layout()
    plt.savefig(os.path.join(OUT, "active_headline_heatmap.png"), dpi=130); plt.close()
    A = []
    for key, g in P.groupby(["leader_client", "arm", "fireOffset", "gap"]):
        A.append(dict(client=key[0], arm=key[1], fireOffset=key[2], send_gap_ms=key[3], pairs=len(g), P_higher_fee_first=fmt_ci(wilson(g.hi_first.sum(), len(g))),
                      P_earlier_sent_first=fmt_ci(wilson(g.early_first.sum(), len(g)))))
    md.append("### By arm (write-lock conflict vs independent), fire offset (before vs during the window) and send gap\n" + pd.DataFrame(A).to_markdown(index=False) + "\n")
    if xs:
        X = pd.DataFrame(xs)
        xr = X.groupby("target_version").agg(pairs=("windowId", "count"), P_higher_fee_earlier_slot=("hi_earlier_slot", "mean"),
                                              P_earlier_sent_earlier_slot=("early_sent_earlier_slot", "mean")).round(2)
        md.append("### Cross-slot (same burst split over several slots)\n" + xr.to_markdown() + "\n")
    st = land.groupby("leader_version").agg(n=("sig", "count"), lower_prio_before=("lower_prio_before_share", "median"), higher_prio_after=("higher_prio_after_share", "median")).round(2)
    md.append("### Strictness against third-party competition\nMedian share of third-party txs placed *before* a probe that pay a *lower* priority per cost unit, "
              "and placed *after* it that pay *higher* (0 = perfectly priority-sorted block).\n" + st.to_markdown() + "\n")
    # chart: P(higher fee first) per validator
    fig, ax = plt.subplots(figsize=(10, 4.5))
    labels, vals, los, his, vals2 = [], [], [], [], []
    for key, g in P.groupby(["leader_version", "leader"]):
        p, lo, hi = wilson(g.hi_first.sum(), len(g))
        labels.append(f"{key[0]}\n{key[1][:6]}"); vals.append(p); los.append(max(0, p - lo)); his.append(max(0, hi - p))
        vals2.append(g.early_first.mean())
    x = np.arange(len(labels))
    ax.bar(x - .2, vals, .4, yerr=[los, his], capsize=3, label="P(higher fee earlier)")
    ax.bar(x + .2, vals2, .4, label="P(earlier sent earlier)")
    ax.axhline(.5, color="grey", ls="--", lw=.8)
    ax.set_xticks(x); ax.set_xticklabels(labels, fontsize=7, rotation=30, ha="right"); ax.set_ylim(0, 1); ax.legend()
    ax.set_title("Own probes: which rule predicts order inside the block?"); plt.tight_layout()
    plt.savefig(os.path.join(OUT, "active_rule_by_validator.png"), dpi=130); plt.close()
    # chart: position vs priority per block, small multiples
    blocks_with = land.groupby(["windowId", "landedSlot"]).filter(lambda g: len(g) >= 3)
    keys = list(blocks_with.groupby(["leader_version", "windowId", "landedSlot"]).groups.keys())[:12]
    if keys:
        fig, axes = plt.subplots(int(math.ceil(len(keys) / 4)), 4, figsize=(14, 3 * math.ceil(len(keys) / 4)), squeeze=False)
        for ax, k in zip(axes.flat, keys):
            g = blocks_with[(blocks_with.windowId == k[1]) & (blocks_with.landedSlot == k[2])]
            ax.scatter(g.pos, g.prio + 1, c=g.sendIdx, cmap="viridis", s=40)
            for r in g.itertuples():
                ax.annotate(str(r.sendIdx), (r.pos, r.prio + 1), fontsize=7)
            ax.set_yscale("log"); ax.set_title(f"{k[0]} slot {int(k[2])}", fontsize=8)
        for ax in list(axes.flat)[len(keys):]:
            ax.axis("off")
        fig.supxlabel("position in block (label = send order)"); fig.supylabel("priority fee + 1 (lamports)")
        plt.tight_layout(); plt.savefig(os.path.join(OUT, "active_blocks.png"), dpi=120); plt.close()


def verdict(g):
    dis = g[~g.agree]
    if len(g) < 6 or len(dis) < 5:
        return "insufficient data"
    pf, lo, hi = wilson(dis.hi_first.sum(), len(dis))
    if lo > 0.5:
        return "priority (strict)" if pf >= 0.95 else "priority (soft)"
    if hi < 0.5:
        return "arrival/FIFO" if wilson(g.early_first.sum(), len(g))[1] > .5 else "anti-priority"
    return "no detectable rule (noise)"


if __name__ == "__main__":
    md.append("# Results (auto-generated by analysis/analyze.py)\n")
    md.append(f"Generated: {pd.Timestamp.now('UTC')} UTC; data dir `{DATA}`.\n")
    passive()
    active()
    open(os.path.join(OUT, "results.md"), "w").write("\n".join(md))
    print("\n".join(md))
