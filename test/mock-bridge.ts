import WebSocket from "ws";
import type { RobloxValue } from "../src/protocol.js";

interface FakeInstance {
  name: string;
  className: string;
  properties: Record<string, RobloxValue>;
  source?: string;
  children: FakeInstance[];
}

// Minimal fake DataModel used by all tool tests.
function fakeTree(): FakeInstance {
  const part: FakeInstance = {
    name: "Part", className: "Part",
    properties: { Name: "Part", Anchored: false, Position: { __t: "Vector3", x: 0, y: 5, z: 0 } },
    children: []
  };
  const buyRemote: FakeInstance = {
    name: "Buy", className: "RemoteEvent", properties: { Name: "Buy" }, children: []
  };
  const moduleScript: FakeInstance = {
    name: "Logic", className: "ModuleScript",
    properties: { Name: "Logic" }, source: "return {}", children: []
  };
  const workspace: FakeInstance = {
    name: "Workspace", className: "Workspace", properties: { Name: "Workspace" }, children: [part]
  };
  const replicatedStorage: FakeInstance = {
    name: "ReplicatedStorage", className: "ReplicatedStorage",
    properties: { Name: "ReplicatedStorage" }, children: [buyRemote, moduleScript]
  };
  return {
    name: "game", className: "DataModel", properties: { Name: "Game" },
    children: [workspace, replicatedStorage]
  };
}

export class MockBridge {
  private ws?: WebSocket;
  private readonly root = fakeTree();
  private readonly refs = new Map<number, FakeInstance>();
  private readonly byInstance = new Map<FakeInstance, number>();
  private nextRef = 0;

  constructor(private readonly url: string) {
    this.assignRef(this.root); // game = ref 0
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.on("open", () => resolve());
      this.ws.on("error", reject);
      this.ws.on("message", (data) => this.dispatch(data.toString()));
    });
  }

  async close(): Promise<void> { this.ws?.close(); }

  private assignRef(inst: FakeInstance): number {
    const existing = this.byInstance.get(inst);
    if (existing !== undefined) return existing;
    const ref = this.nextRef++;
    this.refs.set(ref, inst);
    this.byInstance.set(inst, ref);
    return ref;
  }

  private pathOf(inst: FakeInstance): string {
    const find = (cur: FakeInstance, target: FakeInstance, trail: string[]): string[] | undefined => {
      const next = [...trail, cur.name];
      if (cur === target) return next;
      for (const child of cur.children) {
        const found = find(child, target, next);
        if (found) return found;
      }
      return undefined;
    };
    return (find(this.root, inst, []) ?? [inst.name]).join(".");
  }

  private node(inst: FakeInstance) {
    return {
      ref: this.assignRef(inst), name: inst.name, className: inst.className,
      path: this.pathOf(inst), childCount: inst.children.length
    };
  }

  private dispatch(raw: string): void {
    const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params: any };
    try {
      this.reply(id, this.handle(method, params ?? {}));
    } catch (err) {
      this.ws?.send(JSON.stringify({ id, ok: false, error: (err as Error).message }));
    }
  }

  private reply(id: number, result: unknown): void {
    this.ws?.send(JSON.stringify({ id, ok: true, result }));
  }

  private require(ref: number): FakeInstance {
    const inst = this.refs.get(ref);
    if (!inst) throw new Error(`stale ref ${ref}`);
    return inst;
  }

  private handle(method: string, params: any): unknown {
    switch (method) {
      case "status":
        return { gameName: "MockGame", placeId: 123, clientVersion: "mock", capabilities: { hookmetamethod: true } };
      case "getRoot":
        return { node: this.node(this.root), services: this.root.children.map((c) => this.node(c)) };
      case "getChildren": {
        const inst = this.require(params.ref);
        const children = inst.children.filter((c) => !params.classFilter || c.className === params.classFilter);
        return children.map((c) => this.node(c));
      }
      case "getProperties": {
        const inst = this.require(params.ref);
        const names: string[] | undefined = params.propertyNames;
        const properties: Record<string, RobloxValue> = {};
        const keys = names ?? Object.keys(inst.properties);
        for (const key of keys) if (key in inst.properties) properties[key] = inst.properties[key];
        return { className: inst.className, properties };
      }
      case "setProperty": {
        const inst = this.require(params.ref);
        inst.properties[params.name] = params.value;
        return { ok: true };
      }
      case "search": {
        const limit = params.limit ?? 100;
        const results: ReturnType<MockBridge["node"]>[] = [];
        const walk = (inst: FakeInstance) => {
          if (results.length >= limit) return;
          const matchesName = inst.name.toLowerCase().includes(String(params.query).toLowerCase());
          const matchesClass = !params.classFilter || inst.className === params.classFilter;
          if (matchesName && matchesClass) results.push(this.node(inst));
          inst.children.forEach(walk);
        };
        this.root.children.forEach(walk);
        return results;
      }
      case "getSource": {
        const inst = this.require(params.ref);
        if (inst.source === undefined) throw new Error("instance has no readable source");
        return { source: inst.source };
      }
      case "getByPath": {
        const target = params.path.split(".").slice(1); // drop "game"
        let cur = this.root;
        for (const segment of target) {
          const next = cur.children.find((c) => c.name === segment);
          if (!next) throw new Error(`path not found: ${params.path}`);
          cur = next;
        }
        return this.node(cur);
      }
      case "fireRemote": return { ok: true };
      case "invokeRemote": return { result: { __t: "Instance", ref: 0, path: "game", class: "DataModel" } };
      case "remoteSpyStart": return { ok: true };
      case "remoteSpyStop": return { ok: true };
      case "remoteSpyDump": return { entries: [{ remote: "Buy", args: [1] }] };
      case "runLuau": return { output: "hello\n", returned: 42 };
      default: throw new Error(`unknown method ${method}`);
    }
  }
}
