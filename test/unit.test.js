// Offline unit tests (no network): node --test test/
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"); const os = require("os"); const path = require("path");
const { Keypair, Transaction } = require("@solana/web3.js");
const { Budget, SpendCapExceeded } = require("../dist/budget");
const { buildProbe, priorityFee, cuPriceFor } = require("../dist/tx");
const { summarizeBlock } = require("../dist/blocks");
const { makeRng } = require("../dist/rng");

test("spend cap refuses a batch that would exceed it and persists across restarts", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cap-")), "ledger.json");
  const b = new Budget(f, 20000, "t");
  b.reserve([{ kind: "probe", signature: "a", lamports: 15000 }]);
  assert.throws(() => b.reserve([{ kind: "probe", signature: "b", lamports: 5001 }]), SpendCapExceeded);
  const b2 = new Budget(f, 50_000_000, "t2"); // env cannot raise a stored cap
  assert.strictEqual(b2.cap, 20000);
  assert.strictEqual(b2.reserved, 15000);
  assert.throws(() => b2.reserve([{ kind: "probe", signature: "c", lamports: 5001 }]), SpendCapExceeded);
  b2.reserve([{ kind: "probe", signature: "d", lamports: 5000 }]);
  assert.strictEqual(b2.remaining, 0);
});

test("on-chain guard trips when balance dropped by more than the cap", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cap-")), "ledger.json");
  const b = new Budget(f, 1000, "t");
  b.setInitialBalance(10_000);
  assert.strictEqual(b.checkOnchain(9_500), 500);
  assert.throws(() => b.checkOnchain(8_999), SpendCapExceeded);
});

test("probe fee arithmetic is exact and the tx has the expected shape", () => {
  const kp = Keypair.generate();
  for (const lv of [0, 5, 20, 100, 400, 1500, 5000, 15000]) {
    const p = buildProbe({ payer: kp, recentBlockhash: "11111111111111111111111111111111", cuLimit: 600, priorityLamports: lv, loadedAccountsDataLimit: 32768, nonce: 7 }, 5000);
    assert.ok(p.priorityFeeLamports <= lv && p.priorityFeeLamports >= lv - 1, `level ${lv} -> ${p.priorityFeeLamports}`);
    assert.strictEqual(p.maxFeeLamports, 5000 + p.priorityFeeLamports);
    const tx = Transaction.from(Buffer.from(p.wireBase64, "base64"));
    assert.strictEqual(tx.instructions.length, 4);
    assert.strictEqual(tx.signatures.length, 1);
  }
  assert.strictEqual(priorityFee(cuPriceFor(100, 600), 600), 100);
});

test("seeded permutation is reproducible", () => {
  assert.deepStrictEqual(makeRng("x").shuffle([1, 2, 3, 4, 5, 6, 7, 8]), makeRng("x").shuffle([1, 2, 3, 4, 5, 6, 7, 8]));
});

test("block summary keeps order, base/priority split and v1 config", () => {
  const blk = {
    blockhash: "h", parentSlot: 1, blockTime: 1, blockHeight: 1,
    transactions: [
      { version: 1, meta: { fee: 5324, costUnits: 1360, computeUnitsConsumed: 24, err: null, loadedAddresses: { writable: [], readonly: [] } },
        transaction: { signatures: ["s0"], message: { accountKeys: ["P", "A", "Prog"], header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 }, instructions: [{ programIdIndex: 2, accounts: [0, 1], data: "" }], transactionConfig: { computeUnitLimit: 24, priorityFee: 324 } } } },
      { version: "legacy", meta: { fee: 10000, costUnits: 2000, computeUnitsConsumed: 300, err: { x: 1 }, loadedAddresses: { writable: [], readonly: [] } },
        transaction: { signatures: ["s1", "s1b"], message: { accountKeys: ["Q", "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5", "11111111111111111111111111111111"], header: { numRequiredSignatures: 2, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 }, instructions: [] } } },
    ],
  };
  const s = summarizeBlock(9, blk, 5000);
  assert.deepStrictEqual(s.txs.map((t) => t.sig), ["s0", "s1"]);
  assert.strictEqual(s.txs[0].prio, 324);
  assert.strictEqual(s.txs[0].cuLimit, 24);
  assert.strictEqual(s.txs[1].prio, 0);
  assert.strictEqual(s.txs[1].jitoTip, true);
  assert.strictEqual(s.txs[1].err, true);
});
