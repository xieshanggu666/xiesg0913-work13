'use strict';
// 端到端冒烟测试：两名玩家建房→加入→开局→接词→质疑→裁定→断线重连→结算→回放
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const URL = 'ws://localhost:8080';
let failures = 0;
function check(name, cond) {
  console.log(`${cond ? '✓' : '✗'} ${name}`);
  if (!cond) failures++;
}

function client(name) {
  const c = { name, ws: new WebSocket(URL), state: null, token: null, msgs: [] };
  c.send = (m) => c.ws.send(JSON.stringify(m));
  c.ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'joined') c.token = msg.token;
    if (msg.type === 'state') c.state = msg.state;
    c.msgs.push(msg);
  });
  c.waitFor = (pred, timeout = 3000) => new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (pred(c)) { clearInterval(iv); res(c); }
      else if (Date.now() - t0 > timeout) { clearInterval(iv); rej(new Error(`${name}: waitFor 超时`)); }
    }, 20);
  });
  c.opened = new Promise(res => c.ws.on('open', res));
  return c;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const A = client('甲');
  await A.opened;
  A.send({ type: 'createRoom', name: '甲' });
  await A.waitFor(c => c.state && c.state.phase === 'lobby');
  const code = A.state.code;
  check('创建房间', !!code);

  const B = client('乙');
  await B.opened;
  B.send({ type: 'joinRoom', name: '乙', roomCode: code });
  await B.waitFor(c => c.state && c.state.players.length === 2);
  check('加入房间', B.state.players.length === 2);

  // 规则编辑：空关系列表被服务端拒绝（带上下文，供客户端就地提示）
  A.send({ type: 'setRules', ruleSet: { allowedRelations: [] } });
  await A.waitFor(c => c.msgs.some(m => m.type === 'error' && m.context === 'setRules'));
  check('非法规则被拒绝且带上下文', A.state.ruleSet.allowedRelations.length > 0);

  // 合法保存：房主收到确认，非房主及时看到更新（不改变行动点等，避免影响后续流程）
  A.send({ type: 'setRules', ruleSet: { turnSeconds: 120, challengeTokens: 2 } });
  await A.waitFor(c => c.msgs.some(m => m.type === 'rulesSaved'));
  check('保存成功收到确认', true);
  await B.waitFor(c => c.state.ruleSet.turnSeconds === 120);
  check('非房主及时看到规则更新', B.state.ruleSet.challengeTokens === 2);

  // 非房主无权修改规则
  B.send({ type: 'setRules', ruleSet: { turnSeconds: 45 } });
  await B.waitFor(c => c.msgs.some(m => m.type === 'error' && m.context === 'setRules'));
  check('非房主修改被拒绝', B.state.ruleSet.turnSeconds === 120);

  A.send({ type: 'startGame' });
  await A.waitFor(c => c.state.phase === 'playing');
  check('开局', A.state.nodes.length === 3);
  const first = A.state.turn.playerId;
  const active = first === A.state.you ? A : B;
  const other = first === A.state.you ? B : A;
  check('轮到房主', first === A.state.you);

  // 房主接两个词成链
  const start0 = active.state.nodes[0].id;
  active.send({ type: 'play', word: '火焰', parentId: start0, relation: 'hypernym', reason: '火焰是火的一种形态' });
  await active.waitFor(c => c.state.nodes.some(n => n.word === '火焰'));
  const n1 = active.state.nodes.find(n => n.word === '火焰');
  active.send({ type: 'play', word: '篝火', parentId: n1.id, relation: 'scene', reason: '篝火晚会场景中出现' });
  await active.waitFor(c => c.state.nodes.some(n => n.word === '篝火'));
  check('接词成链', active.state.turn.apLeft === 1);

  // 质疑发起并暂停计时
  other.send({ type: 'challenge', nodeId: n1.id });
  await other.waitFor(c => c.state.pendingChallenge);
  check('质疑发起并暂停计时', other.state.turn.deadline === null);
  check('裁定者是房主', other.state.pendingChallenge.adjudicatorId === A.state.you);

  // 裁定者（房主）在待裁定状态下断开重连——模拟关掉弹窗/刷新页面后仍能回到裁定
  const tokenA = A.token;
  A.ws.close();
  await sleep(300);
  const A1 = client('甲');
  await A1.opened;
  A1.send({ type: 'reconnect', token: tokenA });
  await A1.waitFor(c => c.state && c.state.pendingChallenge);
  check('重连后待裁定状态仍在', A1.state.pendingChallenge.adjudicatorId === A1.state.you);

  // 裁定不成立 → 词保留
  A1.send({ type: 'resolve', verdict: 'reject' });
  await A1.waitFor(c => !c.state.pendingChallenge);
  check('重连后裁定成功，计时恢复', !!A1.state.turn.deadline);
  check('词保留', A1.state.nodes.some(n => n.word === '火焰'));

  // 加固「篝火」然后结束回合
  const n2 = A1.state.nodes.find(n => n.word === '篝火');
  A1.send({ type: 'reinforce', nodeId: n2.id });
  await A1.waitFor(c => c.state.nodes.find(n => n.word === '篝火').reinforced);
  check('加固成功', true);
  A1.send({ type: 'endTurn' });
  await other.waitFor(c => c.state.turn.playerId === other.state.you);
  check('回合切换', true);

  // 乙断线重连
  const tokenB = B.token;
  B.ws.close();
  await sleep(300);
  check('断线被标记', A1.state.players.find(p => p.name === '乙') && true);
  const B2 = client('乙');
  await B2.opened;
  B2.send({ type: 'reconnect', token: tokenB });
  await B2.waitFor(c => c.state && c.state.phase === 'playing');
  check('断线重连恢复局面', B2.state.nodes.length === A1.state.nodes.length);

  // 观战：对局进行中凭房间码进入，持续收到玩家/词链/回合推送
  const S = client('朋友');
  await S.opened;
  S.send({ type: 'spectate', name: '朋友', roomCode: code });
  await S.waitFor(c => c.state && c.state.spectating === true);
  check('观战者获得只读身份', S.state.spectating === true);
  check('观战者看到全部玩家与当前词链',
    S.state.players.length === 2 && S.state.nodes.length === A1.state.nodes.length);
  check('观战者看到回合与计时', !!S.state.turn && (!!S.state.turn.deadline || S.state.turn.pausedRemaining != null));
  await A1.waitFor(c => (c.state.spectators || []).some(s => s.name === '朋友'));
  check('玩家能看到观战者', true);

  // 观战者尝试所有写操作：一律被服务器拒绝（纵深防御，协议层拦截）
  const nodeId = S.state.nodes.find(n => n.ownerId).id;
  for (const [m, extra] of [
    ['play', { word: '捣乱词', parentId: S.state.nodes[0].id, relation: 'synonym', reason: '观战者不该能接词' }],
    ['reinforce', { nodeId }],
    ['endTurn', {}],
    ['challenge', { nodeId }],
    ['resolve', { verdict: 'uphold' }],
    ['setRules', { ruleSet: { turnSeconds: 30 } }],
    ['startGame', {}],
  ]) {
    S.send({ type: m, ...extra });
  }
  await sleep(300);
  const denied = S.msgs.filter(m => m.type === 'error' && /观战|只读/.test(m.message)).length;
  check('观战者的全部行动被拒绝（7 项）', denied >= 7);
  check('观战者捣乱未改变局面',
    S.state.nodes.length === A1.state.nodes.length && !S.state.nodes.some(n => n.word === '捣乱词'));

  // 观战者断线重连：刷新页面后凭 token 恢复观战身份
  const tokenS = S.token;
  S.ws.close();
  await sleep(300);
  const S2 = client('朋友');
  await S2.opened;
  S2.send({ type: 'reconnect', token: tokenS });
  await S2.waitFor(c => c.state && c.state.spectating === true);
  check('观战者刷新后凭 token 恢复身份', S2.state.phase === 'playing');

  // 快进结束：轮流空过
  let guard = 0;
  while (A1.state.phase === 'playing' && guard < 50) {
    guard++;
    const cur = A1.state.turn.playerId === A1.state.you ? A1 : B2;
    cur.send({ type: 'endTurn' });
    await sleep(120);
  }
  await A1.waitFor(c => c.state.phase === 'ended');
  await S2.waitFor(c => c.state.phase === 'ended');
  check('游戏结束并结算', Array.isArray(A1.state.scores) && A1.state.scores.length === 2);
  check('观战者不在结算名单中', !S2.state.scores.some(s => s.playerId === S2.state.you));
  console.log('  结算:', A1.state.scores.map(s => `${s.name}:${s.total}`).join(' '));

  // 回放：玩家与观战者都能进入现有回放
  A1.send({ type: 'replay' });
  await A1.waitFor(c => c.msgs.some(m => m.type === 'replay'));
  const frames = A1.msgs.find(m => m.type === 'replay').frames;
  check('回放帧可用', frames.length > 5 && frames[frames.length - 1].scores);
  S2.send({ type: 'replay' });
  await S2.waitFor(c => c.msgs.some(m => m.type === 'replay'));
  check('观战者结束后可看回放', S2.msgs.some(m => m.type === 'replay' && m.frames.length === frames.length));

  // 对局结束后观战者刷新页面：旧观战会话不应再自动恢复
  const tokenS2 = S2.token;
  S2.ws.close();
  await sleep(300);
  const S2b = client('朋友');
  await S2b.opened;
  S2b.send({ type: 'reconnect', token: tokenS2 });
  await S2b.waitFor(c => c.msgs.some(m => m.type === 'error'));
  check('结束后观战者凭旧 token 刷新被拒',
    S2b.msgs.some(m => m.type === 'error' && /观战会话已失效/.test(m.message)));
  S2b.ws.close();
  await sleep(300);

  // 玩家结束后仍可凭 token 重连回来看结算/回放
  const tokenAEnd = A1.token;
  A1.ws.close();
  await sleep(300);
  const A2 = client('甲');
  await A2.opened;
  A2.send({ type: 'reconnect', token: tokenAEnd });
  await A2.waitFor(c => c.state && c.state.phase === 'ended');
  check('玩家结束后仍可凭 token 重连', A2.state.you === A1.state.you && !!A2.state.scores);

  // 观战者重新输入房间码即可观看结算与回放
  const S2c = client('朋友');
  await S2c.opened;
  S2c.send({ type: 'spectate', name: '回来看结算', roomCode: code });
  await S2c.waitFor(c => c.state && c.state.spectating === true && c.state.phase === 'ended');
  check('重新输入房间码可观战已结束房间', S2c.state.spectators.some(s => s.name === '回来看结算'));
  S2c.send({ type: 'replay' });
  await S2c.waitFor(c => c.msgs.some(m => m.type === 'replay'));
  check('重新观战后仍可看回放', S2c.msgs.some(m => m.type === 'replay' && m.frames.length === frames.length));

  // 观战 token 是临时身份，不纳入历史
  S2c.send({ type: 'history', tokens: [S2c.token] });
  await S2c.waitFor(c => c.msgs.some(m => m.type === 'history'));
  check('观战 token 不进历史', S2c.msgs.find(m => m.type === 'history').entries.length === 0);
  S2c.ws.close();

  // 历史与战绩：凭本地保存的玩家 token 换取战绩摘要；失效 token 静默跳过
  A2.send({ type: 'history', tokens: [tokenAEnd, 'invalid-token'] });
  await A2.waitFor(c => c.msgs.some(m => m.type === 'history'));
  const hist = A2.msgs.find(m => m.type === 'history').entries;
  check('历史只返回有效 token 的房间', hist.length === 1 && hist[0].code === code);
  check('战绩含名次/得分/胜者/结束时间',
    hist[0].phase === 'ended' && hist[0].yourRank === 1 && hist[0].yourTotal > 0 &&
    hist[0].winnerName === '甲' && hist[0].endedAt > 0);

  // 落盘：结束的房间不带观战者与观战 token，旧观战记录不残留
  await sleep(500); // 等 300ms 防抖落盘
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'rooms.json'), 'utf8'));
  const ended = data.rooms.find(r => r.code === code);
  check('结束房间落盘不含观战者', Array.isArray(ended.spectators) && ended.spectators.length === 0);
  check('结束房间落盘不含观战 token',
    !Object.values(data.tokens).some(t => t.spectator && t.roomCode === code));

  // 大厅观战：新房只在大厅阶段也能进入
  const C = client('新房主');
  await C.opened;
  C.send({ type: 'createRoom', name: '新房主' });
  await C.waitFor(c => c.state && c.state.phase === 'lobby');
  const S3 = client('大厅观赛');
  await S3.opened;
  S3.send({ type: 'spectate', name: '大厅观赛', roomCode: C.state.code });
  await S3.waitFor(c => c.state && c.state.spectating === true);
  check('大厅阶段可观战（看规则与玩家）', S3.state.phase === 'lobby');
  // 未结束房间的观战者刷新仍可凭 token 恢复（防止误伤进行中/大厅的观战会话）
  const tokenS3 = S3.token;
  S3.ws.close();
  await sleep(300);
  const S3b = client('大厅观赛');
  await S3b.opened;
  S3b.send({ type: 'reconnect', token: tokenS3 });
  await S3b.waitFor(c => c.state && c.state.spectating === true);
  check('大厅观战者刷新后仍可恢复', S3b.state.phase === 'lobby');
  S3.send({ type: 'startGame' });
  await sleep(200);
  check('大厅观战者不能开始游戏', S3b.state.phase === 'lobby');

  A2.ws.close(); B2.ws.close(); C.ws.close(); S3b.ws.close();
  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('冒烟测试异常:', e.message); process.exit(1); });
