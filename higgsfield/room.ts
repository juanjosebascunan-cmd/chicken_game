/**
 * `Room` — one Chicken Cross Road match, as a Durable Object.
 *
 * Real-time game: the room owns its own tick loop (50 ms) while a round is
 * playing, which also keeps the object in memory. Between rounds it may
 * hibernate, so the whole match is snapshotted to `ctx.storage` on every state
 * transition and each socket carries its player id in its attachment.
 *
 * Wire protocol:
 *   in:  {type:"join", playerId} | {type:"start_mode", mode:"solo"|"bot"}
 *        {type:"move", dx, dy}   | {type:"reset"}
 *   out: {type:"state", status, mode, seats, you, view, result} | {type:"spectate"}
 */

import { DurableObject } from "cloudflare:workers";

import type { Env } from "./env";

// ---- Constants ----
const TICK_MS = 50;
const NUM_ROAD_LANES = 6;
const TOTAL_LANES = NUM_ROAD_LANES + 2; // goal top + N road + safe bottom
const MAX_PLAYERS = 2;
const LIVES_START = 3;
const MOVE_COOLDOWN_MS = 150;
const BOT_MOVE_COOLDOWN_MS = 380; // bot moves a bit slower than a sharp human
const VEHICLE_GAP_MIN = 240;
const VEHICLE_GAP_MAX = 460;
const WORLD_W = 700;
const MAX_COL = 5; // chickens stay within -5..5 columns of the centre
const SPECTATOR = "__spectator__";

const PING = "__ping";
const PONG = "__pong";

type Status = "waiting" | "playing" | "over";
type Mode = "solo" | "bot" | "versus";

interface Vehicle { x: number; speed: number; type: "truck" | "bus"; w: number; h: number; dir: number }
interface Coin { col: number; collected: string | null }
interface Lane { type: "goal" | "road" | "safe"; vehicles: Vehicle[]; coins: Coin[] }
interface World { lanes: Lane[]; level: number }
interface Player {
  seat: number; name: string; isBot: boolean;
  x: number; y: number; lives: number; score: number;
  moveAt: number; hitCooldown: number; dead: boolean; finished: boolean;
}
interface Snapshot {
  players: Record<string, Player>;
  world: World | null;
  status: Status;
  mode: Mode | null;
  winner: string | null;
  botId: string | null;
}
interface Attachment { playerId?: string; spectator?: boolean }

function freshSnapshot(): Snapshot {
  return { players: {}, world: null, status: "waiting", mode: null, winner: null, botId: null };
}

function makeVehicles(laneIdx: number, level: number): Vehicle[] {
  const dir = laneIdx % 2 === 0 ? 1 : -1;
  const speed = (2 + level * 0.4 + Math.random() * 1.8) * dir;
  const type = Math.random() < 0.5 ? "truck" : "bus";
  const w = type === "bus" ? 110 : 80;
  const gap = VEHICLE_GAP_MIN + Math.random() * (VEHICLE_GAP_MAX - VEHICLE_GAP_MIN);
  const vehicles: Vehicle[] = [];
  for (let i = 0; i < 5; i++) {
    vehicles.push({ x: dir > 0 ? -200 - i * gap : 900 + i * gap, speed, type, w, h: 44, dir });
  }
  return vehicles;
}

function makeCoins(): Coin[] {
  const coins: Coin[] = [];
  for (let i = 0; i < 3; i++) coins.push({ col: Math.floor(Math.random() * 9) - 4, collected: null });
  return coins;
}

function initWorld(level: number): World {
  const lanes: Lane[] = [{ type: "goal", vehicles: [], coins: [] }];
  for (let i = 0; i < NUM_ROAD_LANES; i++) {
    lanes.push({ type: "road", vehicles: makeVehicles(i, level), coins: makeCoins() });
  }
  lanes.push({ type: "safe", vehicles: [], coins: [] });
  return { lanes, level };
}

function newPlayer(seat: number, isBot = false): Player {
  return {
    seat, name: isBot ? "BOT 🤖" : "P" + (seat + 1), isBot,
    x: seat === 0 ? -2 : 2, y: TOTAL_LANES - 1,
    lives: LIVES_START, score: 0,
    moveAt: 0, hitCooldown: 0, dead: false, finished: false,
  };
}

export class Room extends DurableObject<Env> {
  private s: Snapshot = freshSnapshot();
  private tickHandle: ReturnType<typeof setTimeout> | null = null;
  private lastTickTime = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    void ctx.blockConcurrencyWhile(async () => {
      this.s = (await ctx.storage.get<Snapshot>("snap")) ?? freshSnapshot();
      // Revived mid-round (e.g. after a deploy): pick the loop back up.
      if (this.s.status === "playing") {
        this.lastTickTime = Date.now();
        this.scheduleTick();
      }
    });
  }

  private async save(): Promise<void> {
    await this.ctx.storage.put("snap", this.s);
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected a websocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    const server = pair[1]!;
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({} satisfies Attachment);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private attachment(ws: WebSocket): Attachment {
    return (ws.deserializeAttachment() as Attachment | null) ?? {};
  }

  private humanCount(): number {
    return Object.values(this.s.players).filter((p) => !p.isBot).length;
  }

  private spectate(ws: WebSocket, playerId: string): void {
    ws.serializeAttachment({ playerId, spectator: true } satisfies Attachment);
    this.sendTo(ws, { type: "spectate" });
    this.sendTo(ws, this.buildStateMsg(SPECTATOR));
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || raw.length > 512) return;
    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return;
      msg = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const s = this.s;

    // ---- JOIN ----
    if (msg.type === "join") {
      const id = msg.playerId;
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(id)) return;

      if (s.players[id]) { // reconnect reclaims the seat
        ws.serializeAttachment({ playerId: id } satisfies Attachment);
        this.sendTo(ws, this.buildStateMsg(id));
        return;
      }

      // Room full, or a bot round already running: watch this round.
      if (this.humanCount() >= MAX_PLAYERS || (s.status !== "waiting" && s.mode === "bot")) {
        this.spectate(ws, id);
        return;
      }
      if (s.status !== "waiting" && s.mode === "solo") {
        this.spectate(ws, id);
        return;
      }

      const seat = Object.keys(s.players).length;
      s.players[id] = newPlayer(seat);
      ws.serializeAttachment({ playerId: id } satisfies Attachment);

      if (s.status === "waiting" && this.humanCount() === MAX_PLAYERS) {
        this.removeBot();
        this.startGame("versus");
      } else {
        await this.save();
        this.broadcast();
      }
      return;
    }

    const att = this.attachment(ws);
    const id = att.spectator ? undefined : att.playerId;
    if (!id || !s.players[id]) return;

    // ---- START MODE ----
    if (msg.type === "start_mode" && s.status === "waiting") {
      if (msg.mode === "solo") {
        this.startGame("solo");
      } else if (msg.mode === "bot") {
        this.addBot();
        this.startGame("bot");
      }
      return;
    }

    // ---- MOVE ----
    if (msg.type === "move" && s.status === "playing") {
      if (this.tryMove(id, Number(msg.dx), Number(msg.dy))) this.broadcast();
      return;
    }

    // ---- RESET ----
    if (msg.type === "reset" && s.status === "over") {
      this.resetGame();
    }
  }

  override async webSocketClose(): Promise<void> {
    // Seats are kept so a reload with the same playerId reclaims them.
  }

  override async webSocketError(): Promise<void> {}

  // ---- Movement (shared by humans + bot) ----
  private tryMove(id: string, rawDx: number, rawDy: number): boolean {
    const s = this.s;
    const p = s.players[id];
    if (!p || !s.world || p.dead || p.finished) return false;
    const now = Date.now();
    const cd = p.isBot ? BOT_MOVE_COOLDOWN_MS : MOVE_COOLDOWN_MS;
    if (now - p.moveAt < cd) return false;

    const dx = Math.sign(rawDx || 0);
    const dy = Math.sign(rawDy || 0);
    if ((dx === 0 && dy === 0) || (dx !== 0 && dy !== 0)) return false;

    const ny = p.y + dy;
    const nx = p.x + dx;
    if (ny < 0 || ny >= TOTAL_LANES || Math.abs(nx) > MAX_COL) return false;
    p.moveAt = now;
    p.x = nx;
    p.y = ny;
    if (dy < 0) p.score += 1;

    const lane = s.world.lanes[p.y];
    if (lane) {
      for (const c of lane.coins) {
        if (!c.collected && Math.abs(c.col - p.x) <= 1) { c.collected = id; p.score += 5; }
      }
    }

    if (p.y === 0 && !p.finished) {
      p.finished = true;
      p.score += 30;
      const anyOtherActive = Object.values(s.players).some((pl) => pl !== p && !pl.dead && !pl.finished);
      if (!anyOtherActive) this.endGame();
    }
    return true;
  }

  // ---- Bot AI: simple greedy lane-by-lane crosser ----
  private botThink(): void {
    const s = this.s;
    if (!s.botId || !s.world) return;
    const p = s.players[s.botId];
    if (!p || p.dead || p.finished || p.hitCooldown > 0) return;
    if (Date.now() - p.moveAt < BOT_MOVE_COOLDOWN_MS) return;

    const nextY = p.y - 1;
    if (nextY < 0) return;
    const nextLane = s.world.lanes[nextY];

    // Safe/goal lane ahead -> always advance
    if (!nextLane || nextLane.type !== "road") { this.tryMove(s.botId, 0, -1); return; }

    // Is the next lane clear at the bot's column for the near future?
    const botXpx = WORLD_W / 2 + p.x * 64;
    let safe = true;
    for (const v of nextLane.vehicles) {
      const futureX = v.x + v.speed * (250 / 16);
      const lo = Math.min(v.x, futureX) - v.w / 2 - 40;
      const hi = Math.max(v.x, futureX) + v.w / 2 + 40;
      if (botXpx > lo && botXpx < hi) { safe = false; break; }
    }

    if (safe) {
      this.tryMove(s.botId, 0, -1);
    } else if (Math.random() < 0.4) {
      const dir = p.x > 3 ? -1 : p.x < -3 ? 1 : (Math.random() < 0.5 ? -1 : 1);
      this.tryMove(s.botId, dir, 0);
    }
  }

  private addBot(): void {
    const s = this.s;
    if (s.botId) return;
    const id = "bot-" + Math.random().toString(36).slice(2, 8);
    s.players[id] = newPlayer(Object.keys(s.players).length, true);
    s.botId = id;
  }

  private removeBot(): void {
    const s = this.s;
    if (s.botId) { delete s.players[s.botId]; s.botId = null; }
  }

  // ---- Game flow ----
  private startGame(mode: Mode): void {
    const s = this.s;
    s.mode = mode;
    s.world = initWorld(1);
    s.status = "playing";
    s.winner = null;
    this.lastTickTime = Date.now();
    this.scheduleTick();
    void this.save();
    this.broadcast();
  }

  private resetGame(): void {
    const s = this.s;
    let seat = 0;
    for (const id of Object.keys(s.players)) {
      s.players[id] = newPlayer(seat++, s.players[id]!.isBot);
    }
    this.startGame(s.mode ?? "solo");
  }

  private endGame(): void {
    const s = this.s;
    s.status = "over";
    if (this.tickHandle) { clearTimeout(this.tickHandle); this.tickHandle = null; }
    const entries = Object.entries(s.players).sort(([, a], [, b]) => b.score - a.score);
    s.winner = entries[0]?.[0] ?? null;
    void this.save();
    this.broadcast();
  }

  private scheduleTick(): void {
    if (this.tickHandle) clearTimeout(this.tickHandle);
    this.tickHandle = setTimeout(() => this.tick(), TICK_MS);
  }

  private tick(): void {
    this.tickHandle = null;
    const s = this.s;
    if (s.status !== "playing" || !s.world) return;

    const now = Date.now();
    const dt = Math.min(now - this.lastTickTime, 150);
    this.lastTickTime = now;
    const { lanes } = s.world;

    // Move vehicles
    for (const lane of lanes) {
      if (lane.type !== "road") continue;
      for (const v of lane.vehicles) {
        v.x += v.speed * (dt / 16);
        if (v.speed > 0 && v.x > WORLD_W + 200) v.x = -250;
        if (v.speed < 0 && v.x < -250) v.x = WORLD_W + 200;
      }
    }

    this.botThink();
    if (s.status !== "playing") return; // the bot may have finished the round

    // Collisions
    for (const p of Object.values(s.players)) {
      if (p.dead || p.finished) continue;
      if (p.hitCooldown > 0) { p.hitCooldown = Math.max(0, p.hitCooldown - dt); continue; }
      const lane = lanes[p.y];
      if (!lane || lane.type !== "road") continue;
      const chickenX = WORLD_W / 2 + p.x * 64;
      for (const v of lane.vehicles) {
        if (chickenX > v.x - v.w / 2 && chickenX < v.x + v.w / 2) {
          p.lives--;
          p.hitCooldown = 1200;
          if (p.lives <= 0) p.dead = true;
          break;
        }
      }
    }

    // Round ends once nobody is still crossing
    if (!Object.values(s.players).some((p) => !p.dead && !p.finished)) { this.endGame(); return; }

    this.broadcast();
    this.scheduleTick();
  }

  // ---- Messaging ----
  private sendTo(ws: WebSocket, obj: unknown): void {
    try { ws.send(JSON.stringify(obj)); } catch { /* socket already gone */ }
  }

  private buildView(forId: string) {
    const s = this.s;
    if (!s.world) return null;
    const players: Record<string, unknown> = {};
    for (const [id, p] of Object.entries(s.players)) {
      players[id] = {
        seat: p.seat, name: p.name, x: p.x, y: p.y,
        lives: p.lives, score: p.score, dead: p.dead, finished: p.finished,
        hitCooldown: p.hitCooldown > 0, isBot: p.isBot, isMe: id === forId,
      };
    }
    return { lanes: s.world.lanes, level: s.world.level, players, you: forId, mode: s.mode };
  }

  private buildStateMsg(forId: string) {
    const s = this.s;
    return {
      type: "state",
      status: s.status,
      mode: s.mode,
      seats: Object.keys(s.players),
      you: forId,
      view: this.buildView(forId),
      result: s.status === "over" ? { winner: s.winner } : null,
    };
  }

  private broadcast(): void {
    // One serialisation per distinct viewer id, not per socket.
    const cache = new Map<string, string>();
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.attachment(ws);
      if (!att.playerId) continue;
      const viewer = att.spectator || !this.s.players[att.playerId] ? SPECTATOR : att.playerId;
      let data = cache.get(viewer);
      if (!data) { data = JSON.stringify(this.buildStateMsg(viewer)); cache.set(viewer, data); }
      try { ws.send(data); } catch { /* closed mid-fan-out */ }
    }
  }
}
