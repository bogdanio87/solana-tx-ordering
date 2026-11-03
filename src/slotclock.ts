// Tracks the cluster's current slot with sub-slot resolution: websocket slotSubscribe (processed)
// plus HTTP getSlot polling fallback. Estimates the slot duration from observations.
import WebSocket from "ws";
import { Rpc } from "./rpc";
import { log } from "./log";

export class SlotClock {
  lastSlot = 0;
  lastTs = 0;
  slotMs: number;
  private ws: WebSocket | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private obs: { slot: number; ts: number }[] = [];
  source = "none";

  constructor(private rpc: Rpc, private wsUrl: string, slotMs: number) {
    this.slotMs = slotMs;
  }

  private observe(slot: number, src: string) {
    const ts = Date.now();
    if (slot > this.lastSlot) {
      this.lastSlot = slot;
      this.lastTs = ts;
      this.source = src;
      this.obs.push({ slot, ts });
      if (this.obs.length > 300) this.obs.shift();
      if (this.obs.length >= 50) {
        const a = this.obs[0], b = this.obs[this.obs.length - 1];
        const est = (b.ts - a.ts) / Math.max(1, b.slot - a.slot);
        if (est > 50 && est < 1000) this.slotMs = est;
      }
    }
  }

  async start() {
    const s = await this.rpc.call<number>("getSlot", [{ commitment: "processed" }]);
    this.observe(s, "http");
    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(this.wsUrl);
        this.ws = ws;
        const to = setTimeout(() => reject(new Error("ws timeout")), 8000);
        ws.on("open", () => {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "slotSubscribe" }));
          clearTimeout(to);
          resolve();
        });
        ws.on("message", (m) => {
          try {
            const msg = JSON.parse(m.toString());
            if (msg.method === "slotNotification") this.observe(msg.params.result.slot, "ws");
          } catch {}
        });
        ws.on("error", (e) => { clearTimeout(to); reject(e); });
        ws.on("close", () => { this.ws = null; });
      });
      log("slotclock_ws", { url: this.wsUrl });
    } catch (e: any) {
      log("slotclock_ws_failed", { err: String(e?.message ?? e) });
    }
    // HTTP polling always on as a backstop (cheap: 2/s)
    this.pollTimer = setInterval(async () => {
      try { this.observe(await this.rpc.call<number>("getSlot", [{ commitment: "processed" }], { retries: 0, noThrottle: true }), "http"); } catch {}
    }, 500);
  }

  /** Estimated current slot (fractional). */
  now(): number {
    return this.lastSlot + (Date.now() - this.lastTs) / this.slotMs;
  }

  async waitForSlot(target: number, maxWaitMs = 30 * 60_000): Promise<number> {
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      const cur = this.now();
      if (cur >= target) return cur;
      if (Date.now() > deadline) throw new Error("waitForSlot timeout");
      const msLeft = (target - cur) * this.slotMs;
      await new Promise((r) => setTimeout(r, Math.max(1, Math.min(msLeft - 2, 200))));
    }
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.ws?.close();
  }
}
