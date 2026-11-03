// Probe transaction builder. Every probe is identical in cost-model terms (same instructions, same
// CU limit, same loaded-accounts-data limit, 1 signature, 1 writable account) and differs ONLY in its
// priority fee and a unique nonce (self-transfer amount). So any ordering difference between probes in
// the same block can be attributed to fee, arrival, or noise - not to cost differences.
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";

export interface ProbeSpec {
  payer: Keypair;
  recentBlockhash: string;
  cuLimit: number;
  priorityLamports: number; // desired total priority fee
  loadedAccountsDataLimit: number;
  nonce: number; // unique per probe; encoded as self-transfer lamports
}

export interface BuiltProbe {
  signature: string;
  wireBase64: string;
  cuPriceMicroLamports: number;
  priorityFeeLamports: number; // exact = ceil(cuPrice * cuLimit / 1e6)
  maxFeeLamports: number; // base + priority (upper bound of what this tx can cost)
  payer: string;
  nonce: number;
}

const COMPUTE_BUDGET_ID = new PublicKey("ComputeBudget111111111111111111111111111111");

function setLoadedAccountsDataSizeLimit(bytes: number): TransactionInstruction {
  const data = Buffer.alloc(5);
  data.writeUInt8(4, 0); // ComputeBudgetInstruction::SetLoadedAccountsDataSizeLimit
  data.writeUInt32LE(bytes, 1);
  return new TransactionInstruction({ programId: COMPUTE_BUDGET_ID, keys: [], data });
}

export function cuPriceFor(priorityLamports: number, cuLimit: number): number {
  return Math.floor((priorityLamports * 1_000_000) / cuLimit);
}
export function priorityFee(cuPrice: number, cuLimit: number): number {
  return Math.ceil((cuPrice * cuLimit) / 1_000_000);
}

export function buildProbe(s: ProbeSpec, lamportsPerSignature: number): BuiltProbe {
  const cuPrice = cuPriceFor(s.priorityLamports, s.cuLimit);
  const tx = new Transaction({ feePayer: s.payer.publicKey, recentBlockhash: s.recentBlockhash });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: s.cuLimit }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }));
  tx.add(setLoadedAccountsDataSizeLimit(s.loadedAccountsDataLimit));
  // Self-transfer: net balance change 0, makes every probe message unique (no dedup collisions).
  tx.add(SystemProgram.transfer({ fromPubkey: s.payer.publicKey, toPubkey: s.payer.publicKey, lamports: s.nonce }));
  tx.sign(s.payer);
  const pf = priorityFee(cuPrice, s.cuLimit);
  return {
    signature: require("bs58").default.encode(tx.signature!),
    wireBase64: tx.serialize().toString("base64"),
    cuPriceMicroLamports: cuPrice,
    priorityFeeLamports: pf,
    maxFeeLamports: lamportsPerSignature + pf,
    payer: s.payer.publicKey.toBase58(),
    nonce: s.nonce,
  };
}

export function buildTransfer(from: Keypair, to: PublicKey, lamports: number, recentBlockhash: string) {
  const tx = new Transaction({ feePayer: from.publicKey, recentBlockhash });
  tx.add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports }));
  tx.sign(from);
  return { signature: require("bs58").default.encode(tx.signature!), wireBase64: tx.serialize().toString("base64") };
}
