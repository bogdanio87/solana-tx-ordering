import fs from "fs";
import path from "path";
import { Keypair } from "@solana/web3.js";

export function loadOrCreateKeypair(p: string, create: boolean): Keypair | null {
  if (fs.existsSync(p)) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
  }
  if (!create) return null;
  const kp = Keypair.generate();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return kp;
}

export function loadOrCreateSubWallets(p: string, n: number, create: boolean): Keypair[] {
  let arr: number[][] = [];
  if (fs.existsSync(p)) arr = JSON.parse(fs.readFileSync(p, "utf8"));
  if (arr.length < n && create) {
    while (arr.length < n) arr.push(Array.from(Keypair.generate().secretKey));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(arr), { mode: 0o600 });
  }
  return arr.map((a) => Keypair.fromSecretKey(Uint8Array.from(a)));
}
