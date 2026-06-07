import type { RpcEvent, RpcResponse } from "../protocol.js";

export type Sender = (message: string) => void;

export interface RpcOptions {
  timeoutMs: number;
  onEvent?: (event: string, data: unknown) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly send: Sender, private readonly opts: RpcOptions) {}

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout for "${method}"`));
      }, this.opts.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send(JSON.stringify({ id, method, params }));
    });
  }

  handleMessage(raw: string): void {
    const parsed = JSON.parse(raw) as RpcResponse | RpcEvent;
    if ("event" in parsed) {
      this.opts.onEvent?.(parsed.event, parsed.data);
      return;
    }
    const entry = this.pending.get(parsed.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(parsed.id);
    if (parsed.ok) entry.resolve(parsed.result);
    else entry.reject(new Error(parsed.error ?? "unknown bridge error"));
  }

  rejectAll(reason: string): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
