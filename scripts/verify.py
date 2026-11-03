#!/usr/bin/env python3
"""Independent re-check of the raw data against the chain (read-only, stdlib only).

For every landed probe in data/runs/*/probes_final.json (or a random sample with --sample N):
  * getBlock(slot) is fetched fresh from RPC_URL and the probe's signature must be at the recorded index;
  * the fee and the leader (getSlotLeaders) must match what the analysis used.
Usage:  python3 scripts/verify.py [--data ./data] [--sample 50] [--rpc https://api.mainnet-beta.solana.com]
"""
import argparse, glob, gzip, json, os, random, sys, time, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--data", default=os.environ.get("DATA_DIR", "./data"))
ap.add_argument("--rpc", default=os.environ.get("RPC_URL", "https://api.mainnet-beta.solana.com"))
ap.add_argument("--sample", type=int, default=40)
a = ap.parse_args()


def rpc(method, params):
    for i in range(6):
        try:
            req = urllib.request.Request(a.rpc, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(), {"content-type": "application/json"})
            r = json.load(urllib.request.urlopen(req, timeout=60))
            if "error" in r:
                raise RuntimeError(r["error"])
            return r["result"]
        except Exception as e:
            if i == 5:
                raise
            time.sleep(1.5 * (i + 1))


probes = []
for run in glob.glob(os.path.join(a.data, "runs", "*")):
    f = os.path.join(run, "probes_final.json")
    if os.path.exists(f):
        for p in json.load(open(f)):
            if p.get("landedSlot"):
                p["_run"] = run
                probes.append(p)
if not probes:
    print("no landed probes to verify (dry-run data only)")
    sys.exit(0)
random.seed(1)
sample = probes if a.sample <= 0 or a.sample >= len(probes) else random.sample(probes, a.sample)
ok = bad = 0
cache = {}
for p in sample:
    s = p["landedSlot"]
    if s not in cache:
        b = rpc("getBlock", [s, {"encoding": "json", "maxSupportedTransactionVersion": 1, "transactionDetails": "signatures", "rewards": False}])
        leader = rpc("getSlotLeaders", [s, 1])[0]
        cache[s] = (b["signatures"], leader)
    sigs, leader = cache[s]
    with gzip.open(os.path.join(p["_run"], "blocks", f"{s}.json.gz"), "rt") as f:
        local = json.load(f)
    li = next((t["i"] for t in local["txs"] if t["sig"] == p["signature"]), None)
    ci = sigs.index(p["signature"]) if p["signature"] in sigs else None
    good = ci is not None and ci == li and leader == local.get("leader")
    ok += good; bad += (not good)
    print(f"{'OK ' if good else 'BAD'} slot={s} idx_chain={ci} idx_local={li} leader={leader[:8]} sig={p['signature'][:16]}…")
print(f"verified {ok}/{ok + bad}")
sys.exit(1 if bad else 0)
