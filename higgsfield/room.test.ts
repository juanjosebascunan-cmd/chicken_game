/**
 * Chicken Cross Road room, exercised through real WebSockets in workerd.
 */

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function open(room: string) {
  const res = await SELF.fetch(`https://game.test/ws/${room}`, {
    headers: { Upgrade: "websocket" },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error("no webSocket on the upgrade response");
  ws.accept();

  const frames: any[] = [];
  ws.addEventListener("message", (event: MessageEvent) => {
    const data = typeof event.data === "string" ? event.data : "";
    if (data === "__pong") return;
    frames.push(JSON.parse(data));
  });

  const next = async (pred: (f: any) => boolean, label: string) => {
    for (let i = 0; i < 200; i++) {
      for (let j = frames.length - 1; j >= 0; j--) if (pred(frames[j])) return frames[j];
      await scheduler.wait(10);
    }
    throw new Error(`timed out waiting for ${label}; got ${JSON.stringify(frames.slice(-3))}`);
  };

  return {
    ws,
    frames,
    next,
    send: (msg: unknown) => ws.send(JSON.stringify(msg)),
  };
}

describe("room", () => {
  it("rejects non-websocket requests to /ws", async () => {
    const res = await SELF.fetch("https://game.test/ws/abc");
    expect(res.status).toBe(426);
  });

  it("seats a player and waits for a mode", async () => {
    const a = await open("wait-room");
    a.send({ type: "join", playerId: "alice" });
    const st = await a.next((f) => f.type === "state", "state");
    expect(st.status).toBe("waiting");
    expect(st.seats).toEqual(["alice"]);
  });

  it("solo: moving up scores a point", async () => {
    const a = await open("solo-room");
    a.send({ type: "join", playerId: "alice" });
    await a.next((f) => f.type === "state", "joined");
    a.send({ type: "start_mode", mode: "solo" });
    const playing = await a.next((f) => f.type === "state" && f.status === "playing", "playing");
    expect(playing.view.lanes).toHaveLength(8);
    expect(playing.view.players.alice.y).toBe(7);
    a.send({ type: "move", dx: 0, dy: -1 });
    const moved = await a.next((f) => f.view?.players?.alice?.y === 6, "moved");
    expect(moved.view.players.alice.score).toBeGreaterThanOrEqual(1);
  });

  it("two humans start a versus round; a third spectates", async () => {
    const a = await open("versus-room");
    const b = await open("versus-room");
    const c = await open("versus-room");
    a.send({ type: "join", playerId: "alice" });
    await a.next((f) => f.type === "state", "a joined");
    b.send({ type: "join", playerId: "bob" });
    const st = await b.next((f) => f.type === "state" && f.status === "playing", "versus");
    expect(st.mode).toBe("versus");
    expect(Object.keys(st.view.players).sort()).toEqual(["alice", "bob"]);

    c.send({ type: "join", playerId: "carol" });
    await c.next((f) => f.type === "spectate", "spectate");
    // Spectator moves are ignored.
    c.send({ type: "move", dx: 0, dy: -1 });
    await scheduler.wait(100);
    const last = await a.next((f) => f.type === "state", "state");
    expect(last.view.players.carol).toBeUndefined();
  });

  it("bot mode adds a bot player", async () => {
    const a = await open("bot-room");
    a.send({ type: "join", playerId: "alice" });
    await a.next((f) => f.type === "state", "joined");
    a.send({ type: "start_mode", mode: "bot" });
    const st = await a.next((f) => f.type === "state" && f.mode === "bot", "bot round");
    const bots = Object.values(st.view.players).filter((p: any) => p.isBot);
    expect(bots).toHaveLength(1);
  });
});
