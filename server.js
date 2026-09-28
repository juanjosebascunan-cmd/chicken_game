import { DurableObject } from "cloudflare:workers";

// ---- Constants ----
const TICK_MS = 50;
const NUM_ROAD_LANES = 6;
const TOTAL_LANES = NUM_ROAD_LANES + 2; // safe bottom + N road + goal top
const MAX_PLAYERS = 2;
const LIVES_START = 3;
const MOVE_COOLDOWN_MS = 150;
const BOT_MOVE_COOLDOWN_MS = 380; // bot moves a bit slower than a sharp human
const VEHICLE_GAP_MIN = 240;
const VEHICLE_GAP_MAX = 460;
const WORLD_W = 700;

function seededRng(seed) {
  let s = seed >>> 0;
  return () => { s=(Math.imul(1664525,s)+1013904223)>>>0; return s/4294967296; };
}

function makeVehicles(rng, laneIdx, level) {
  const dir = laneIdx % 2 === 0 ? 1 : -1;
  const speed = (2 + level * 0.4 + rng() * 1.8) * dir;
  const type = rng() < 0.5 ? "truck" : "bus";
  const w = type === "bus" ? 110 : 80;
  const gap = VEHICLE_GAP_MIN + rng() * (VEHICLE_GAP_MAX - VEHICLE_GAP_MIN);
  const vehicles = [];
  for (let i = 0; i < 5; i++) {
    vehicles.push({ x: dir > 0 ? -200 - i*gap : 900 + i*gap, speed, type, w, h: 44, dir });
  }
  return vehicles;
}

function makeCoins(rng) {
  const coins = [];
  for (let i = 0; i < 3; i++) coins.push({ col: Math.floor(rng()*9)-4, collected: null });
  return coins;
}

function initWorld(level) {
  const rng = seededRng((Date.now() ^ (level * 0x9e3779b9)) >>> 0);
  const lanes = [];
  lanes.push({ type:"goal",  vehicles:[], coins:[] });
  for (let i=0; i<NUM_ROAD_LANES; i++)
    lanes.push({ type:"road", vehicles:makeVehicles(rng,i,level), coins:makeCoins(rng) });
  lanes.push({ type:"safe", vehicles:[], coins:[] });
  return { lanes, level };
}

function newPlayer(seat, isBot=false) {
  return {
    ws: null, seat,
    x: seat === 0 ? -2 : 2, y: TOTAL_LANES - 1,
    lives: LIVES_START, score: 0,
    moveAt: 0, dead: false, hitCooldown: 0, finished: false,
    name: isBot ? "BOT 🤖" : "P" + (seat + 1),
    isBot,
  };
}

// ---- Worker entry: /…/ws/<room> -> one Durable Object per room, everything else -> static files ----
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const m = url.pathname.match(/\/ws\/([A-Za-z0-9_-]{1,32})$/);
    if (m) return env.GAME.get(env.GAME.idFromName(m[1])).fetch(req);
    return env.ASSETS.fetch(req);
  },
};

export class GameServer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.players = {};       // id -> player object
    this.socketToId = new Map();
    this.world = null;
    this.status = "waiting"; // waiting | playing | over
    this.mode = null;        // "solo" | "bot" | "versus"
    this.winner = null;
    this.tickHandle = null;
    this.lastTickTime = 0;
    this.seatCount = 0;
    this.botId = null;
  }

  async fetch(req) {
    if (req.headers.get("Upgrade") !== "websocket")
      return new Response("Expected WebSocket", { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status:101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ---- JOIN ----
    if (msg.type === "join") {
      const id = msg.playerId;
      if (!id) return;

      if (this.players[id]) { // reconnect
        this.players[id].ws = ws;
        this.socketToId.set(ws, id);
        this.sendTo(ws, this.buildStateMsg(id));
        return;
      }

      const humanCount = Object.values(this.players).filter(p => !p.isBot).length;
      if (humanCount >= MAX_PLAYERS) { // spectator
        this.socketToId.set(ws, "__spectator__:" + id);
        this.sendTo(ws, { type:"spectate" });
        this.sendTo(ws, this.buildStateMsg("__spectator__"));
        return;
      }

      const seat = this.seatCount++;
      this.players[id] = newPlayer(seat);
      this.players[id].ws = ws;
      this.socketToId.set(ws, id);

      // If a 2nd human joins a game that was solo/bot-waiting, upgrade to versus
      if (this.status === "waiting") {
        const humans = Object.values(this.players).filter(p => !p.isBot).length;
        if (humans === MAX_PLAYERS) {
          // remove any bot if present, start versus
          this.removeBot();
          this.startGame("versus");
          return;
        }
      } else if (this.status === "playing" && this.mode === "bot") {
        // A real human arrived mid-bot-game: replace the bot with this human
        // (keep it simple: let them spectate this round, join next reset)
        this.socketToId.set(ws, "__spectator__:" + id);
        delete this.players[id];
        this.seatCount--;
        this.sendTo(ws, { type:"spectate" });
        this.sendTo(ws, this.buildStateMsg("__spectator__"));
        return;
      }

      this.broadcast();
      return;
    }

    // ---- START MODE (solo / bot / wait-for-versus) ----
    if (msg.type === "start_mode" && this.status === "waiting") {
      const id = this.socketToId.get(ws);
      if (!id || !this.players[id]) return;

      if (msg.mode === "solo") {
        this.startGame("solo");
      } else if (msg.mode === "bot") {
        this.addBot();
        this.startGame("bot");
      }
      // "versus" = just keep waiting for a 2nd human (no-op)
      return;
    }

    // ---- MOVE ----
    if (msg.type === "move" && this.status === "playing") {
      const id = this.socketToId.get(ws);
      if (!id) return;
      this.tryMove(id, msg.dx, msg.dy);
      this.broadcast();
      return;
    }

    // ---- RESET ----
    if (msg.type === "reset" && this.status === "over") {
      this.resetGame();
    }
  }

  async webSocketClose(ws) {
    const id = this.socketToId.get(ws);
    this.socketToId.delete(ws);
    if (id && this.players[id]) this.players[id].ws = null;
  }

  // ---- Movement (shared by humans + bot) ----
  tryMove(id, rawDx, rawDy) {
    const p = this.players[id];
    if (!p || p.dead || p.finished) return false;
    const now = Date.now();
    const cd = p.isBot ? BOT_MOVE_COOLDOWN_MS : MOVE_COOLDOWN_MS;
    if (now - p.moveAt < cd) return false;

    const dx = Math.sign(rawDx || 0);
    const dy = Math.sign(rawDy || 0);
    if (dx === 0 && dy === 0) return false;

    const ny = p.y + dy;
    if (ny < 0 || ny >= TOTAL_LANES) return false;
    p.moveAt = now;
    p.x += dx;
    p.y = ny;
    if (dy < 0) p.score += 1;

    const lane = this.world.lanes[p.y];
    if (lane?.coins) {
      for (const c of lane.coins) {
        if (!c.collected && Math.abs(c.col - p.x) <= 1) { c.collected = id; p.score += 5; }
      }
    }

    if (p.y === 0 && !p.finished) {
      p.finished = true;
      p.score += 30;
      const anyOtherActive = Object.values(this.players).some(pl => pl !== p && !pl.dead && !pl.finished);
      if (!anyOtherActive) { this.endGame(); }
    }
    return true;
  }

  // ---- Bot AI: simple greedy lane-by-lane crosser ----
  botThink() {
    if (!this.botId) return;
    const p = this.players[this.botId];
    if (!p || p.dead || p.finished) return;
    if (p.hitCooldown > 0) return;

    const now = Date.now();
    if (now - p.moveAt < BOT_MOVE_COOLDOWN_MS) return;

    // Look at the lane the bot would move INTO (one row up)
    const nextY = p.y - 1;
    if (nextY < 0) return;
    const nextLane = this.world.lanes[nextY];

    // If next lane is safe/goal -> always advance
    if (!nextLane || nextLane.type !== "road") { this.tryMove(this.botId, 0, -1); return; }

    // Check if next lane is clear at the bot's column for the near future
    const botXpx = WORLD_W/2 + p.x * 64;
    let safe = true;
    for (const v of nextLane.vehicles) {
      // predict vehicle position ~250ms ahead
      const futureX = v.x + v.speed * (250/16);
      const lo = Math.min(v.x, futureX) - v.w/2 - 40;
      const hi = Math.max(v.x, futureX) + v.w/2 + 40;
      if (botXpx > lo && botXpx < hi) { safe = false; break; }
    }

    if (safe) {
      this.tryMove(this.botId, 0, -1);
    } else {
      // Occasionally dodge sideways to find a gap (deterministic-ish jitter)
      if (Math.random() < 0.4) {
        const dir = p.x > 3 ? -1 : p.x < -3 ? 1 : (Math.random() < 0.5 ? -1 : 1);
        this.tryMove(this.botId, dir, 0);
      }
      // else wait this tick
    }
  }

  addBot() {
    if (this.botId) return;
    const id = "bot-" + Math.random().toString(36).slice(2, 8);
    const seat = this.seatCount++;
    this.players[id] = newPlayer(seat, true);
    this.botId = id;
  }

  removeBot() {
    if (this.botId) { delete this.players[this.botId]; this.botId = null; }
  }

  // ---- Game flow ----
  startGame(mode) {
    this.mode = mode;
    this.world = initWorld(1);
    this.status = "playing";
    this.winner = null;
    this.lastTickTime = Date.now();
    this.scheduleTick();
    this.broadcast();
  }

  resetGame() {
    // Re-seat all current players fresh; keep mode
    let seat = 0;
    this.seatCount = 0;
    const ids = Object.keys(this.players);
    for (const id of ids) {
      const wasBot = this.players[id].isBot;
      const ws = this.players[id].ws;
      this.players[id] = newPlayer(seat, wasBot);
      this.players[id].ws = ws;
      seat++;
      this.seatCount++;
    }
    this.startGame(this.mode || "solo");
  }

  endGame() {
    this.status = "over";
    if (this.tickHandle) { clearTimeout(this.tickHandle); this.tickHandle = null; }
    const entries = Object.entries(this.players).sort(([,a],[,b]) => b.score - a.score);
    this.winner = entries[0]?.[0] ?? null;
    this.broadcast();
  }

  scheduleTick() {
    if (this.tickHandle) clearTimeout(this.tickHandle);
    this.tickHandle = setTimeout(() => this.tick(), TICK_MS);
  }

  tick() {
    this.tickHandle = null;
    if (this.status !== "playing") return;

    const now = Date.now();
    const dt = Math.min(now - this.lastTickTime, 150);
    this.lastTickTime = now;

    const { lanes } = this.world;

    // Move vehicles
    for (const lane of lanes) {
      if (lane.type !== "road") continue;
      for (const v of lane.vehicles) {
        v.x += v.speed * (dt / 16);
        if (v.speed > 0 && v.x > WORLD_W + 200) v.x = -250;
        if (v.speed < 0 && v.x < -250) v.x = WORLD_W + 200;
      }
    }

    // Bot AI
    if (this.botId) this.botThink();

    // Collision detection
    let allOut = false;
    for (const [id, p] of Object.entries(this.players)) {
      if (p.dead || p.finished) continue;
      if (p.hitCooldown > 0) { p.hitCooldown = Math.max(0, p.hitCooldown - dt); continue; }

      const lane = lanes[p.y];
      if (!lane || lane.type !== "road") continue;
      const chickenX = WORLD_W/2 + p.x * 64;
      for (const v of lane.vehicles) {
        if (chickenX > v.x - v.w/2 && chickenX < v.x + v.w/2) {
          p.lives--;
          p.hitCooldown = 1200;
          if (p.lives <= 0) {
            p.dead = true;
            const active = Object.values(this.players).filter(pl => !pl.dead && !pl.finished);
            const alive = Object.values(this.players).filter(pl => !pl.dead);
            if (alive.length === 0) { allOut = true; }
            // versus/bot: if one dead and the other already finished or only one remains -> end
            else if (active.length === 0) { allOut = true; }
          }
          break;
        }
      }
      if (allOut) break;
    }

    if (allOut) { this.endGame(); return; }

    this.broadcast();
    this.scheduleTick();
  }

  // ---- Messaging ----
  sendTo(ws, obj) {
    try { if (ws?.readyState === 1) ws.send(JSON.stringify(obj)); } catch {}
  }

  buildView(forId) {
    if (!this.world) return null;
    const pViews = {};
    for (const [id, p] of Object.entries(this.players)) {
      pViews[id] = {
        seat: p.seat, name: p.name,
        x: p.x, y: p.y,
        lives: p.lives, score: p.score,
        dead: p.dead, finished: p.finished,
        hitCooldown: p.hitCooldown > 0,
        isBot: !!p.isBot,
        isMe: id === forId,
      };
    }
    return { lanes: this.world.lanes, level: this.world.level, players: pViews, you: forId, mode: this.mode };
  }

  buildStateMsg(forId) {
    return {
      type: "state",
      status: this.status,
      mode: this.mode,
      seats: Object.keys(this.players),
      you: forId,
      view: this.buildView(forId),
      result: this.status === "over" ? { winner: this.winner } : null,
    };
  }

  broadcast() {
    for (const [id, p] of Object.entries(this.players)) {
      if (p.ws) this.sendTo(p.ws, this.buildStateMsg(id));
    }
    for (const [ws, sid] of this.socketToId.entries()) {
      if (sid.startsWith("__spectator__:")) this.sendTo(ws, this.buildStateMsg("__spectator__"));
    }
  }
}
