// Fan-out sender. Each probe is POSTed (sendTransaction, skipPreflight, maxRetries=0) to every
// configured endpoint concurrently; probes are spaced by SEND_GAP_MS so that "send order" is a
// controlled variable. maxRetries=0 stops the RPC node from re-broadcasting later (which would blur
// arrival time and push probes into other leaders' windows).
import { log } from "./log";

export interface SendResult {
  endpoint: string;
  tStartMs: number;
  tEndMs: number;
  ok: boolean;
  result?: string;
  error?: string;
}

async function postSend(endpoint: string, wireBase64: string): Promise<SendResult> {
  const tStartMs = Date.now();
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [wireBase64, { encoding: "base64", skipPreflight: true, maxRetries: 0 }] }),
    });
    const body: any = await res.json().catch(() => ({}));
    const tEndMs = Date.now();
    if (body.error) return { endpoint, tStartMs, tEndMs, ok: false, error: JSON.stringify(body.error) };
    return { endpoint, tStartMs, tEndMs, ok: res.ok, result: body.result };
  } catch (e: any) {
    return { endpoint, tStartMs, tEndMs: Date.now(), ok: false, error: String(e?.message ?? e) };
  }
}

/** Opens keep-alive connections so the burst is not delayed by TLS handshakes. */
export async function warmUp(endpoints: string[]) {
  await Promise.all(endpoints.map((e) => fetch(e, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }) }).catch(() => null)));
}

export async function sendBurst(wires: string[], endpoints: string[], gapMs: number, dryRun: boolean): Promise<SendResult[][]> {
  const pending: Promise<SendResult[]>[] = [];
  for (let k = 0; k < wires.length; k++) {
    if (dryRun) {
      const t = Date.now();
      pending.push(Promise.resolve(endpoints.map((e) => ({ endpoint: e, tStartMs: t, tEndMs: t, ok: true, result: "DRY_RUN_NOT_SENT" }))));
    } else {
      pending.push(Promise.all(endpoints.map((e) => postSend(e, wires[k]))));
    }
    if (gapMs > 0 && k < wires.length - 1) await new Promise((r) => setTimeout(r, gapMs));
  }
  const res = await Promise.all(pending);
  const errs = res.flat().filter((r) => !r.ok);
  if (errs.length) log("send_errors", { n: errs.length, first: errs[0].error });
  return res;
}
