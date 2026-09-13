'use strict';
// 词语领地服务器：HTTP 静态文件 + WebSocket 实时同步 + 磁盘持久化。
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const game = require('./game');

const PORT = process.env.PORT || 8080;
const DATA_DIR = path.join(__dirname, 'data');
// 测试可用 WT_DATA_FILE 指定独立存档，避免污染开发用的 data/rooms.json
const DATA_FILE = process.env.WT_DATA_FILE
  ? path.resolve(process.env.WT_DATA_FILE)
  : path.join(DATA_DIR, 'rooms.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- 房间存储 ----------

/** rooms: Map<code, room>; tokens: Map<token, {roomCode, playerId, spectator?}> */
const rooms = new Map();
const tokens = new Map();
/** sockets: Map<playerId, Set<ws>>（玩家与观战者共用，id 不冲突：观战者带 sp_ 前缀） */
const sockets = new Map();
/** 观战者断线宽限期：id -> setTimeout，超过后从房间清出（覆盖刷新页面的短暂离线） */
const spectatorPruneTimers = new Map();
const SPECTATOR_TTL_MS = Number(process.env.SPECTATOR_TTL_MS) || 60 * 1000;

function loadRooms() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const loadedRoomCodes = new Set();
    for (const room of raw.rooms) {
      // 旧存档没有 spectators 字段时补空
      if (!Array.isArray(room.spectators)) room.spectators = [];
      // 重启后不存在任何活动连接。玩家保留座位、置离线，凭 token 重连恢复；
      // 观战者是临时只读身份，立即清出——不能让他们在大厅/对局名单里挂到延迟清理才消失，
      // 也不能虚占在线名额让新观战者撞上"已满"。想继续看的人重新输入房间码即可。
      game.resetConnectionsAfterRestart(room);
      game.removeAllSpectators(room);
      rooms.set(room.code, room);
      loadedRoomCodes.add(room.code);
      // 重启后回合计时重新挂上
      if (room.phase === 'playing' && room.turn) {
        if (room.turn.deadline) {
          room.turn.deadline = Date.now() + room.ruleSet.turnSeconds * 1000;
        } else if (room.turn.pausedRemaining == null) {
          room.turn.deadline = Date.now() + room.ruleSet.turnSeconds * 1000;
        }
        scheduleTurnTimer(room);
      }
    }
    // 只恢复玩家 token；旧观战身份已随重启作废，其 token 一并丢弃，避免残留膨胀
    for (const [token, ref] of Object.entries(raw.tokens || {})) {
      if (ref && !ref.spectator && loadedRoomCodes.has(ref.roomCode)) tokens.set(token, ref);
    }
    if (raw.rooms.length) saveRooms(); // 落盘已清出观战者的干净状态
    console.log(`已恢复 ${rooms.size} 个房间`);
  } catch { /* 首次启动或数据损坏，忽略 */ }
}

let saveTimer = null;
function saveRooms() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      // 结束的房间只保留回放/结算所需的玩家与日志，不持久化观战者；
      // 观战是临时身份，重启后本就不可恢复，避免旧观战记录残留在线名单。
      const persistedRooms = [...rooms.values()].map(r =>
        r.phase === 'ended' ? { ...r, spectators: [] } : r);
      const liveCodes = new Set(persistedRooms.map(r => r.code));
      const persistedTokens = {};
      for (const [tok, ref] of tokens) {
        if (!liveCodes.has(ref.roomCode)) continue;
        if (ref.spectator && rooms.get(ref.roomCode).phase === 'ended') continue;
        persistedTokens[tok] = ref;
      }
      fs.writeFileSync(DATA_FILE, JSON.stringify({
        rooms: persistedRooms, tokens: persistedTokens,
      }));
    } catch (e) { console.error('保存失败', e); }
  }, 300);
}

// ---------- 广播 ----------

function broadcast(room) {
  const recipients = [
    ...room.players.map(p => p.id),
    ...(room.spectators || []).map(s => s.id),
  ];
  for (const id of recipients) {
    const set = sockets.get(id);
    if (!set) continue;
    const view = JSON.stringify({ type: 'state', state: game.publicView(room, id) });
    for (const ws of set) if (ws.readyState === 1) ws.send(view);
  }
  saveRooms();
}

function sendTo(playerId, msg) {
  const set = sockets.get(playerId);
  if (!set) return;
  const s = JSON.stringify(msg);
  for (const ws of set) if (ws.readyState === 1) ws.send(s);
}

// ---------- 回合计时 ----------

const turnTimers = new Map();
function scheduleTurnTimer(room) {
  clearTimeout(turnTimers.get(room.code));
  if (room.phase !== 'playing' || !room.turn || !room.turn.deadline) return;
  const delay = Math.max(0, room.turn.deadline - Date.now());
  turnTimers.set(room.code, setTimeout(() => {
    if (room.phase !== 'playing' || !room.turn) return;
    const err = game.endTurn(room, room.turn.playerId, { auto: true });
    if (!err) { scheduleTurnTimer(room); broadcast(room); }
  }, delay + 50));
}

// ---------- 消息处理 ----------

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function issueToken(roomCode, playerId, spectator = false) {
  const token = crypto.randomBytes(16).toString('hex');
  tokens.set(token, { roomCode, playerId, spectator });
  return token;
}

function attachSocket(playerId, ws) {
  if (!sockets.has(playerId)) sockets.set(playerId, new Set());
  sockets.get(playerId).add(ws);
}

function cancelSpectatorPrune(spectatorId) {
  const t = spectatorPruneTimers.get(spectatorId);
  if (t) { clearTimeout(t); spectatorPruneTimers.delete(spectatorId); }
}

// 观战者最后一个连接断开：标记离线并给一个宽限期，超时再清出房间
// （页面刷新/短暂断网时 token 仍可恢复观战身份）
function scheduleSpectatorPrune(spectatorId) {
  cancelSpectatorPrune(spectatorId);
  spectatorPruneTimers.set(spectatorId, setTimeout(() => {
    spectatorPruneTimers.delete(spectatorId);
    for (const room of rooms.values()) {
      const s = (room.spectators || []).find(x => x.id === spectatorId);
      if (!s || sockets.has(spectatorId)) continue;
      game.removeSpectator(room, spectatorId);
      broadcast(room); // 让其他人名单中的旧观战者消失
    }
    // 清掉失效的观战 token，避免 token 表无限增长
    for (const [tok, ref] of tokens) {
      if (ref.spectator && ref.playerId === spectatorId) tokens.delete(tok);
    }
  }, SPECTATOR_TTL_MS));
}

function detachSocket(playerId, ws) {
  const set = sockets.get(playerId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) {
    sockets.delete(playerId);
    for (const room of rooms.values()) {
      // 观战者：走离线宽限，不触发玩家断线/裁定移交逻辑
      const sp = (room.spectators || []).find(x => x.id === playerId);
      if (sp) {
        if (sp.connected) {
          sp.connected = false;
          broadcast(room);
        }
        scheduleSpectatorPrune(playerId);
        continue;
      }
      const p = room.players.find(x => x.id === playerId);
      if (p && p.connected) {
        p.connected = false;
        game.ensureAdjudicatorOnline(room);
        broadcast(room);
      }
    }
  }
}

const handlers = {
  createRoom(ws, ctx, msg) {
    const code = makeRoomCode();
    const playerId = crypto.randomBytes(8).toString('hex');
    const room = game.newRoom(code, playerId, msg.name);
    game.addPlayer(room, playerId, msg.name);
    if (msg.ruleSet) game.setRuleSet(room, playerId, msg.ruleSet);
    rooms.set(code, room);
    const token = issueToken(code, playerId);
    ctx.playerId = playerId; ctx.roomCode = code;
    attachSocket(playerId, ws);
    ws.send(JSON.stringify({ type: 'joined', token, roomCode: code, playerId }));
    broadcast(room);
  },

  joinRoom(ws, ctx, msg) {
    const room = rooms.get(String(msg.roomCode || '').toUpperCase());
    if (!room) return sendErr(ws, '房间不存在，请检查房间码');
    const playerId = crypto.randomBytes(8).toString('hex');
    const err = game.addPlayer(room, playerId, msg.name);
    if (err) return sendErr(ws, err);
    const token = issueToken(room.code, playerId);
    ctx.playerId = playerId; ctx.roomCode = room.code;
    attachSocket(playerId, ws);
    ws.send(JSON.stringify({ type: 'joined', token, roomCode: room.code, playerId }));
    broadcast(room);
  },

  // 观战：凭房间码获得只读身份，任何阶段都可进入（大厅可看规则/玩家，对局中持续收推送）
  spectate(ws, ctx, msg) {
    const room = rooms.get(String(msg.roomCode || '').toUpperCase());
    if (!room) return sendErr(ws, '房间不存在，请检查房间码');
    const spectatorId = 'sp_' + crypto.randomBytes(8).toString('hex');
    const err = game.addSpectator(room, spectatorId, msg.name);
    if (err) return sendErr(ws, err);
    const token = issueToken(room.code, spectatorId, true);
    ctx.playerId = spectatorId; ctx.roomCode = room.code;
    attachSocket(spectatorId, ws);
    ws.send(JSON.stringify({ type: 'joined', token, roomCode: room.code,
      playerId: spectatorId, spectator: true }));
    broadcast(room);
  },

  // 断线重连：凭 token 恢复身份（玩家或观战者）
  reconnect(ws, ctx, msg) {
    const ref = tokens.get(msg.token);
    if (!ref) return sendErr(ws, '会话已失效，请重新加入');
    const room = rooms.get(ref.roomCode);
    if (!room) return sendErr(ws, '房间已不存在');
    if (ref.spectator) {
      const s = (room.spectators || []).find(x => x.id === ref.playerId);
      if (!s) return sendErr(ws, '观战会话已失效，请重新观战');
      // 观战是临时只读会话：对局结束后不再凭 token 恢复。刷新页面应回到首页，
      // 想看结算/回放可重新输入房间码进入。移除记录并作废 token，避免旧会话残留。
      if (room.phase === 'ended') {
        cancelSpectatorPrune(s.id);
        game.removeSpectator(room, s.id);
        for (const [tok, r] of tokens) {
          if (r.spectator && r.playerId === s.id) tokens.delete(tok);
        }
        broadcast(room);
        return sendErr(ws, '对局已结束，观战会话已失效，请重新输入房间码观战');
      }
      s.connected = true;
      cancelSpectatorPrune(s.id);
      ctx.playerId = s.id; ctx.roomCode = room.code;
      attachSocket(s.id, ws);
      ws.send(JSON.stringify({ type: 'joined', token: msg.token,
        roomCode: room.code, playerId: s.id, spectator: true }));
      broadcast(room);
      return;
    }
    const p = room.players.find(x => x.id === ref.playerId);
    if (!p) return sendErr(ws, '你不在该房间中');
    p.connected = true;
    ctx.playerId = ref.playerId; ctx.roomCode = room.code;
    attachSocket(ref.playerId, ws);
    ws.send(JSON.stringify({ type: 'joined', token: msg.token,
      roomCode: room.code, playerId: ref.playerId }));
    broadcast(room);
  },

  setRules(ws, ctx, msg) {
    const room = ctxRoom(ctx);
    // 客户端会等待明确答复后才解除提交锁定，任何情况都要给出回应
    if (!room) return sendErr(ws, '房间已不存在', 'setRules');
    const err = game.setRuleSet(room, ctx.playerId, msg.ruleSet || {});
    if (err) return sendErr(ws, err, 'setRules');
    // 明确告知保存方成功，客户端据此关闭编辑器并给出反馈
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'rulesSaved' }));
    broadcast(room);
  },

  startGame(ws, ctx) {
    const room = ctxRoom(ctx);
    if (!room) return;
    const err = game.startGame(room, ctx.playerId);
    if (err) return sendErr(ws, err);
    scheduleTurnTimer(room);
    broadcast(room);
  },

  play(ws, ctx, msg) {
    const room = ctxRoom(ctx);
    if (!room) return;
    const err = game.playWord(room, ctx.playerId, msg);
    if (err) return sendErr(ws, err);
    broadcast(room);
  },

  reinforce(ws, ctx, msg) {
    const room = ctxRoom(ctx);
    if (!room) return;
    const err = game.reinforce(room, ctx.playerId, msg.nodeId);
    if (err) return sendErr(ws, err);
    broadcast(room);
  },

  endTurn(ws, ctx) {
    const room = ctxRoom(ctx);
    if (!room) return;
    const err = game.endTurn(room, ctx.playerId);
    if (err) return sendErr(ws, err);
    scheduleTurnTimer(room);
    broadcast(room);
  },

  challenge(ws, ctx, msg) {
    const room = ctxRoom(ctx);
    if (!room) return;
    const err = game.challenge(room, ctx.playerId, msg.nodeId);
    if (err) return sendErr(ws, err);
    clearTimeout(turnTimers.get(room.code)); // 计时已暂停
    broadcast(room);
  },

  resolve(ws, ctx, msg) {
    const room = ctxRoom(ctx);
    if (!room) return;
    const err = game.resolveChallenge(room, ctx.playerId, msg.verdict);
    if (err) return sendErr(ws, err);
    scheduleTurnTimer(room); // 恢复计时
    broadcast(room);
  },

  replay(ws, ctx) {
    const room = ctxRoom(ctx);
    if (!room) return;
    if (room.phase !== 'ended') return sendErr(ws, '游戏结束后才能回放');
    sendTo(ctx.playerId, { type: 'replay', frames: game.buildReplay(room) });
  },

  // 历史与战绩：客户端凭本地保存的玩家 token 列表，换取每个房间的战绩摘要。
  // 观战 token 是临时只读身份，不纳入历史；失效 token（房间已删/数据已清）静默跳过，
  // 客户端按"只保留服务器认得的 token"顺势清理本地记录。
  history(ws, ctx, msg) {
    const list = Array.isArray(msg.tokens) ? msg.tokens.slice(0, 50) : [];
    const entries = [];
    for (const token of list) {
      const ref = tokens.get(token);
      if (!ref || ref.spectator) continue;
      const room = rooms.get(ref.roomCode);
      if (!room) continue;
      const summary = game.historySummary(room, ref.playerId);
      if (summary) entries.push({ token, ...summary });
    }
    entries.sort((a, b) => (b.endedAt || b.createdAt) - (a.endedAt || a.createdAt));
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'history', entries }));
  },
};

function ctxRoom(ctx) {
  const room = rooms.get(ctx.roomCode);
  if (!room) return null;
  return room;
}

// 纵深防御：game.js 内已按身份拒绝所有写操作，这里在协议层统一拦截，
// 保证观战 token 即使伪造消息也无法接词、加固、质疑、改规则或开始游戏。
const SPECTATOR_FORBIDDEN = new Set([
  'setRules', 'startGame', 'play', 'reinforce', 'endTurn', 'challenge', 'resolve',
]);

function sendErr(ws, message, context) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', message, context }));
}

// ---------- HTTP + WS ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(p).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  const ctx = { playerId: null, roomCode: null };
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const h = handlers[msg.type];
    if (h) {
      if (SPECTATOR_FORBIDDEN.has(msg.type) && ctx.playerId) {
        const r0 = rooms.get(ctx.roomCode);
        if (r0 && game.isSpectator(r0, ctx.playerId)) {
          return sendErr(ws, '观战者为只读，不能参与对局');
        }
      }
      try { h(ws, ctx, msg); }
      catch (e) { console.error(e); sendErr(ws, '服务器开小差了，请重试'); }
    }
  });
  ws.on('close', () => { if (ctx.playerId) detachSocket(ctx.playerId, ws); });
});

// ---------- 启动 / 停止 ----------
// 默认直接运行时照常监听 8080；测试可 require 本模块后在临时端口上自启、跑完即停，
// 这样 `node --test`（会执行 test/ 下所有 .js，含 e2e.js）不再依赖外部先启动服务器。

function startServer(port = PORT) {
  return new Promise((resolve) => {
    loadRooms();
    server.listen(port, () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : port, stop: stopServer });
    });
  });
}

function stopServer() {
  // 停掉所有定时器，避免保存防抖/回合/观战清理等句柄让进程挂住
  clearTimeout(saveTimer);
  for (const t of turnTimers.values()) clearTimeout(t);
  for (const t of spectatorPruneTimers.values()) clearTimeout(t);
  turnTimers.clear();
  spectatorPruneTimers.clear();
  return new Promise((resolve) => {
      wss.close(() => server.close(() => resolve()));
      // wss.close 只等正常关闭；强制终结仍在打开的连接（e2e 里有 ws.close 竞态）
      for (const client of wss.clients) {
        try { client.terminate(); } catch { /* 已关闭 */ }
      }
    });
}

module.exports = { startServer, stopServer };

// 仅在被直接执行时启动服务（被测试 require 时不自启、不占用 8080）
if (require.main === module) {
  startServer(PORT).then(({ port }) => {
    console.log(`词语领地服务器已启动: http://localhost:${port}`);
  });
}
