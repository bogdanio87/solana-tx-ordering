// getBlock → compact, verifiable per-transaction summary (every tx in the block, in block order).
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { Rpc, RpcError } from "./rpc";

export const JITO_TIP_ACCOUNTS = new Set([
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5", "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY", "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh", "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL", "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
]);
const VOTE_PROGRAM = "Vote111111111111111111111111111111111111111";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";

export interface TxSummary {
  i: number; // position in block (getBlock transaction index)
  sig: string;
  payer: string;
  nSig: number;
  fee: number;
  prio: number; // fee - base fee (lamports)
  cost: number | null; // meta.costUnits (cost-model units)
  cu: number | null; // compute units consumed
  cuLimit: number | null;
  cuPrice: number | null; // micro-lamports/CU when set via ComputeBudget (legacy/v0) - null otherwise
  ver: string | number;
  err: boolean;
  vote: boolean;
  jitoTip: boolean; // touches a Jito tip account (likely bundle member)
  nWritable: number;
}

export interface BlockSummary {
  slot: number;
  blockhash: string;
  parentSlot: number;
  blockTime: number | null;
  blockHeight: number | null;
  leader?: string;
  nTx: number;
  txs: TxSummary[];
  fetchedAt: string;
}

function decodeB58(s: string): Buffer {
  return Buffer.from(require("bs58").default.decode(s));
}

function parseComputeBudget(ixData: string): { kind: number; value: number } | null {
  try {
    const b = decodeB58(ixData);
    const kind = b[0];
    if (kind === 2 && b.length >= 5) return { kind, value: b.readUInt32LE(1) }; // SetComputeUnitLimit
    if (kind === 3 && b.length >= 9) return { kind, value: Number(b.readBigUInt64LE(1)) }; // SetComputeUnitPrice
    return { kind, value: -1 };
  } catch { return null; }
}

export function summarizeBlock(slot: number, b: any, lamportsPerSig: number): BlockSummary {
  const txs: TxSummary[] = (b.transactions ?? []).map((t: any, i: number) => {
    const m = t.transaction.message;
    const keys: string[] = [...m.accountKeys, ...(t.meta?.loadedAddresses?.writable ?? []), ...(t.meta?.loadedAddresses?.readonly ?? [])];
    const nSig = t.transaction.signatures.length;
    let cuLimit: number | null = null, cuPrice: number | null = null, vote = false, jito = false;
    for (const ix of m.instructions) {
      const pid = keys[ix.programIdIndex];
      if (pid === VOTE_PROGRAM) vote = true;
      if (pid === COMPUTE_BUDGET) {
        const p = parseComputeBudget(ix.data);
        if (p?.kind === 2) cuLimit = p.value;
        if (p?.kind === 3) cuPrice = p.value;
      }
    }
    if (m.transactionConfig) {
      cuLimit = m.transactionConfig.computeUnitLimit ?? cuLimit;
    }
    for (const k of m.accountKeys) if (JITO_TIP_ACCOUNTS.has(k)) jito = true;
    const h = m.header;
    const nStatic = m.accountKeys.length;
    const nWritable = (h.numRequiredSignatures - h.numReadonlySignedAccounts) + (nStatic - h.numRequiredSignatures - h.numReadonlyUnsignedAccounts) + (t.meta?.loadedAddresses?.writable?.length ?? 0);
    const fee = t.meta?.fee ?? 0;
    return {
      i, sig: t.transaction.signatures[0], payer: m.accountKeys[0], nSig, fee,
      prio: Math.max(0, fee - lamportsPerSig * nSig),
      cost: t.meta?.costUnits ?? null, cu: t.meta?.computeUnitsConsumed ?? null,
      cuLimit, cuPrice, ver: t.version ?? "legacy", err: t.meta?.err != null, vote, jitoTip: jito, nWritable,
    };
  });
  return { slot, blockhash: b.blockhash, parentSlot: b.parentSlot, blockTime: b.blockTime ?? null, blockHeight: b.blockHeight ?? null, nTx: txs.length, txs, fetchedAt: new Date().toISOString() };
}

/** Returns null when the slot was skipped / has no block. */
export async function fetchBlock(rpc: Rpc, slot: number, lamportsPerSig: number, fullDir?: string): Promise<BlockSummary | null> {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const b = await rpc.call<any>("getBlock", [slot, { commitment: "confirmed", encoding: "json", maxSupportedTransactionVersion: 1, transactionDetails: "full", rewards: false }], { timeoutMs: 60_000 });
      if (!b) return null;
      if (fullDir) {
        fs.mkdirSync(fullDir, { recursive: true });
        fs.writeFileSync(path.join(fullDir, `${slot}.json.gz`), zlib.gzipSync(JSON.stringify(b)));
      }
      return summarizeBlock(slot, b, lamportsPerSig);
    } catch (e) {
      if (e instanceof RpcError && (e.code === -32007 || e.code === -32009)) return null; // skipped
      if (e instanceof RpcError && e.code === -32004) { await new Promise((r) => setTimeout(r, 1500)); continue; } // not yet available
      throw e;
    }
  }
  return null;
}

export function writeBlockSummary(dir: string, s: BlockSummary) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${s.slot}.json.gz`), zlib.gzipSync(JSON.stringify(s)));
}
