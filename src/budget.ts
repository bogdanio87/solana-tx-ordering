// Hard spend cap. A persistent ledger (in the data volume) accumulates the WORST-CASE fee of every
// transaction BEFORE it is sent. If the next reservation would exceed the cap, the process refuses to
// sign/send and exits. A second, independent guard compares on-chain balances against the balance
// recorded when the ledger was created.
import fs from "fs";
import path from "path";
import { log } from "./log";

export interface LedgerEntry { ts: string; kind: string; signature: string; lamports: number; runId: string }
export interface Ledger {
  createdAt: string;
  capLamports: number;
  reservedLamports: number;
  initialTotalBalance: number | null; // payer + sub-wallets when ledger was created
  entries: LedgerEntry[];
}

export class SpendCapExceeded extends Error {}

export class Budget {
  private ledger: Ledger;
  constructor(private file: string, capLamports: number, private runId: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      this.ledger = JSON.parse(fs.readFileSync(file, "utf8"));
      // The cap can only be lowered from the env, never raised above the stored cap silently.
      if (capLamports < this.ledger.capLamports) this.ledger.capLamports = capLamports;
      if (capLamports > this.ledger.capLamports) {
        log("budget_cap_env_higher_than_ledger_ignored", { env: capLamports, ledger: this.ledger.capLamports });
      }
    } else {
      this.ledger = { createdAt: new Date().toISOString(), capLamports, reservedLamports: 0, initialTotalBalance: null, entries: [] };
    }
    this.persist();
  }
  get cap() { return this.ledger.capLamports; }
  get reserved() { return this.ledger.reservedLamports; }
  get remaining() { return this.ledger.capLamports - this.ledger.reservedLamports; }
  get initialBalance() { return this.ledger.initialTotalBalance; }
  setInitialBalance(b: number) {
    if (this.ledger.initialTotalBalance === null) { this.ledger.initialTotalBalance = b; this.persist(); }
  }
  canReserve(lamports: number) { return this.ledger.reservedLamports + lamports <= this.ledger.capLamports; }
  /** Reserve worst-case fees for a batch atomically (all or nothing). */
  reserve(items: { kind: string; signature: string; lamports: number }[]) {
    const total = items.reduce((a, b) => a + b.lamports, 0);
    if (!this.canReserve(total)) {
      throw new SpendCapExceeded(`spend cap: reserved ${this.reserved} + ${total} > cap ${this.cap} lamports`);
    }
    const ts = new Date().toISOString();
    for (const it of items) this.ledger.entries.push({ ts, runId: this.runId, ...it });
    this.ledger.reservedLamports += total;
    this.persist();
  }
  /** On-chain guard: total balance must not have dropped by more than the cap (+ the locked rent we can sweep back). */
  checkOnchain(currentTotal: number) {
    if (this.ledger.initialTotalBalance === null) return;
    const spent = this.ledger.initialTotalBalance - currentTotal;
    if (spent > this.ledger.capLamports) throw new SpendCapExceeded(`on-chain spend ${spent} > cap ${this.cap}`);
    return spent;
  }
  private persist() {
    const tmp = this.file + ".tmp";
    const fd = fs.openSync(tmp, "w");
    fs.writeSync(fd, JSON.stringify(this.ledger, null, 1));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, this.file);
  }
}
