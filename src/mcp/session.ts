import type { BridgeHub } from "../bridge-hub/ws-server.js";
import type { DexConfig } from "../config.js";
import type { ApiDump } from "../api-dump/properties.js";
import type { Node } from "../protocol.js";

export class Session {
  private readonly classNames = new Map<number, string>();

  constructor(
    private readonly hub: BridgeHub,
    readonly config: DexConfig,
    readonly dump: ApiDump | undefined
  ) {}

  async callBridge(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.hub.request(method, params);
  }

  cacheNodes(nodes: Node[]): void {
    for (const node of nodes) this.classNames.set(node.ref, node.className);
  }

  classNameFor(ref: number): string | undefined {
    return this.classNames.get(ref);
  }
}
