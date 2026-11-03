import fs from "fs";
import path from "path";

let logFile: string | null = null;
export function setLogFile(p: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  logFile = p;
}
// Structured JSON-lines log + human-readable console line.
export function log(event: string, fields: Record<string, unknown> = {}) {
  const rec = { ts: new Date().toISOString(), tsMs: Date.now(), event, ...fields };
  const line = JSON.stringify(rec, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  const short = Object.entries(fields)
    .filter(([, v]) => typeof v !== "object")
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.log(`[${rec.ts}] ${event} ${short}`);
  if (logFile) fs.appendFileSync(logFile, line + "\n");
}
