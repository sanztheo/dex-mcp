import { describe, it, expect, vi } from "vitest";
import { RpcClient } from "../src/bridge-hub/rpc.js";

function makeClient(timeoutMs = 15000) {
  const sent: string[] = [];
  const events: Array<{ event: string; data: unknown }> = [];
  const client = new RpcClient((msg) => sent.push(msg), {
    timeoutMs,
    onEvent: (event, data) => events.push({ event, data })
  });
  return { client, sent, events };
}

describe("RpcClient", () => {
  it("resolves a request when a matching response arrives", async () => {
    const { client, sent } = makeClient();
    const promise = client.request("status", {});
    const { id } = JSON.parse(sent[0]);
    client.handleMessage(JSON.stringify({ id, ok: true, result: { gameName: "Test" } }));
    await expect(promise).resolves.toEqual({ gameName: "Test" });
  });

  it("rejects on an error response", async () => {
    const { client, sent } = makeClient();
    const promise = client.request("getRoot", {});
    const { id } = JSON.parse(sent[0]);
    client.handleMessage(JSON.stringify({ id, ok: false, error: "boom" }));
    await expect(promise).rejects.toThrow("boom");
  });

  it("rejects on timeout", async () => {
    vi.useFakeTimers();
    const { client } = makeClient(1000);
    const promise = client.request("status", {});
    const assertion = expect(promise).rejects.toThrow(/timeout/i);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    vi.useRealTimers();
  });

  it("routes unsolicited events and ignores unknown ids", () => {
    const { client, events } = makeClient();
    expect(() => client.handleMessage(JSON.stringify({ id: 999, ok: true, result: 1 }))).not.toThrow();
    client.handleMessage(JSON.stringify({ event: "remoteSpy", data: { name: "Buy" } }));
    expect(events).toEqual([{ event: "remoteSpy", data: { name: "Buy" } }]);
  });
});
