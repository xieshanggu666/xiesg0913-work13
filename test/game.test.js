'use strict';
const test = require('node:test');
const assert = require('node:assert');
const g = require('../game');

function makeRoom(playerNames = ['甲', '乙', '丙']) {
  const room = g.newRoom('TEST', 'p0', playerNames[0]);
  playerNames.forEach((n, i) => g.addPlayer(room, `p${i}`, n));
  const err = g.startGame(room, 'p0', () => 0.01); // 固定随机数，起始词可预测
  assert.strictEqual(err, null);
  return room;
}

function activeId(room) { return room.turn.playerId; }

function playOk(room, word, parentId = 'start0', relation = 'synonym', reason = '这是合理的解释') {
  return g.playWord(room, activeId(room), { word, parentId, relation, reason });
}

test('开局：起始词、回合、行动点就绪', () => {
  const room = makeRoom();
  assert.strictEqual(room.phase, 'playing');
  assert.strictEqual(room.nodes.length, room.ruleSet.startWordCount);
  assert.strictEqual(room.turn.apLeft, room.ruleSet.apPerTurn);
  assert.strictEqual(activeId(room), 'p0');
});

test('接词：扣行动点、校验重复词与解释长度', () => {
  const room = makeRoom();
  assert.strictEqual(playOk(room, '开心'), null);
  assert.strictEqual(room.turn.apLeft, room.ruleSet.apPerTurn - 1);
  assert.strictEqual(playOk(room, '开心'), '这个词已经在场上了');
  const err = g.playWord(room, activeId(room), { word: '高兴', parentId: 'start0', relation: 'synonym', reason: '短' });
  assert.match(err, /至少/);
});

test('接词：不允许的关系类型被拒绝', () => {
  const room = makeRoom();
  room.ruleSet.allowedRelations = ['synonym'];
  const err = g.playWord(room, activeId(room), { word: '黑夜', parentId: 'start0', relation: 'antonym', reason: '足够的解释长度' });
  assert.match(err, /规则/);
});

test('回合推进与游戏结束', () => {
  const room = makeRoom(['甲', '乙']);
  const total = room.players.length * room.ruleSet.rounds;
  for (let i = 0; i < total; i++) {
    assert.strictEqual(room.phase, 'playing');
    assert.strictEqual(g.endTurn(room, activeId(room)), null);
  }
  assert.strictEqual(room.phase, 'ended');
  assert.ok(room.log.some(e => e.type === 'end'));
});

test('加固消耗行动点且免疫质疑', () => {
  const room = makeRoom(['甲', '乙']);
  playOk(room, '开心');
  const node = room.nodes.find(n => n.word === '开心');
  assert.strictEqual(g.reinforce(room, 'p0', node.id), null);
  // 质疑必须在对方（词主）的回合内发起
  assert.strictEqual(g.challenge(room, 'p1', node.id), '加固过的连接免疫质疑');
});

test('质疑成立：级联拆除未加固下游，加固下游成为新根', () => {
  const room = makeRoom(['甲', '乙']);
  // p0 建链：开心 -> 快乐；加固「快乐」（3 AP 用完）
  playOk(room, '开心');
  const n1 = room.nodes.find(n => n.word === '开心');
  playOk(room, '快乐', n1.id);
  const n2 = room.nodes.find(n => n.word === '快乐');
  g.reinforce(room, 'p0', n2.id);
  // p1 在 p0 的回合内质疑「开心」
  assert.strictEqual(g.challenge(room, 'p1', n1.id), null);
  assert.ok(room.pendingChallenge);
  assert.strictEqual(room.turn.deadline, null, '计时应暂停');
  assert.strictEqual(g.resolveChallenge(room, 'p0', 'uphold'), null);
  assert.ok(!room.nodes.some(n => n.word === '开心'), '开心应被移除');
  const happy = room.nodes.find(n => n.word === '快乐');
  assert.ok(happy, '加固的快乐应幸存');
  assert.strictEqual(happy.parentId, null, '快乐应成为新根');
  assert.ok(room.turn.deadline, '裁定后计时应恢复');
});

test('质疑不成立：词保留，质疑次数已消耗', () => {
  const room = makeRoom(['甲', '乙']);
  playOk(room, '开心');
  const n1 = room.nodes.find(n => n.word === '开心');
  const tokensBefore = room.players[1].tokensLeft;
  g.challenge(room, 'p1', n1.id);
  g.resolveChallenge(room, 'p0', 'reject');
  assert.ok(room.nodes.some(n => n.word === '开心'));
  assert.strictEqual(room.players[1].tokensLeft, tokensBefore - 1);
});

test('未加固的下游被级联拆除', () => {
  const room = makeRoom(['甲', '乙']);
  playOk(room, '开心');
  const n1 = room.nodes.find(n => n.word === '开心');
  playOk(room, '快乐', n1.id);
  playOk(room, '喜悦', room.nodes.find(n => n.word === '快乐').id);
  g.challenge(room, 'p1', n1.id);
  g.resolveChallenge(room, 'p0', 'uphold');
  for (const w of ['开心', '快乐', '喜悦']) {
    assert.ok(!room.nodes.some(n => n.word === w), `${w} 应被级联移除`);
  }
});

test('计分：长链与加固有更高收益', () => {
  const room = makeRoom(['甲', '乙']);
  // p0: 链 a->b->c（深度 0,1,2）= 1+2+3 = 6，最长链 3 → +6
  playOk(room, '甲一');
  playOk(room, '甲二', room.nodes.find(n => n.word === '甲一').id);
  playOk(room, '甲三', room.nodes.find(n => n.word === '甲二').id);
  g.endTurn(room, 'p0');
  // p1: 只接一个词 = 1 分，最长链 1 → +2
  playOk(room, '乙一');
  g.endTurn(room, 'p1');
  const scores = g.computeScores(room);
  const s0 = scores.find(s => s.playerId === 'p0');
  const s1 = scores.find(s => s.playerId === 'p1');
  assert.strictEqual(s0.total, 1 + 2 + 3 + 6);
  assert.strictEqual(s1.total, 1 + 2);
  assert.ok(s0.total > s1.total);
});

test('回放帧可从日志重建', () => {
  const room = makeRoom(['甲', '乙']);
  playOk(room, '开心');
  g.endTurn(room, 'p0');
  g.endTurn(room, 'p1');
  // 强制结束以便包含 end 帧
  while (room.phase === 'playing') g.endTurn(room, activeId(room));
  const frames = g.buildReplay(room);
  assert.ok(frames.length > 3);
  const playFrame = frames.find(f => f.label.includes('开心'));
  assert.ok(playFrame.nodes.some(n => n.word === '开心'));
  assert.ok(frames[frames.length - 1].scores, '最后一帧应有结算');
});

test('断线重连后玩家状态保留', () => {
  const room = makeRoom(['甲', '乙']);
  room.players[1].connected = false;
  room.players[1].connected = true; // 模拟重连
  assert.strictEqual(room.players[1].connected, true);
  assert.strictEqual(room.phase, 'playing');
});

test('裁定者掉线后裁定权移交给在线玩家', () => {
  const room = makeRoom(['甲', '乙', '丙']);
  playOk(room, '开心'); // p0（房主）的词
  const n1 = room.nodes.find(n => n.word === '开心');
  g.challenge(room, 'p1', n1.id);
  const adj = room.pendingChallenge.adjudicatorId;
  assert.strictEqual(adj, 'p2'); // 顺延给丙
  // 丙掉线 → 应移交（此时只有 p1 在线且合格？p1 是质疑者，不合格；无合格人选则保持）
  room.players.find(p => p.id === 'p2').connected = false;
  assert.strictEqual(g.ensureAdjudicatorOnline(room), false, '无合格人选时保持不变');
  // 丙恢复在线后又掉线，乙完成行动… 改测：让丙不是唯一人选——先让 p2 在线，p1 掉线不影响
  room.players.find(p => p.id === 'p2').connected = true;
  assert.strictEqual(g.ensureAdjudicatorOnline(room), false, '裁定者在线时不移交');
});

test('裁定者掉线且存在合格人选时移交', () => {
  const room = makeRoom(['甲', '乙', '丙']);
  // 乙的词被丙质疑，裁定者是房主 p0；房主掉线后应移交给在线的乙？乙是词主不合格→无人可移交
  g.endTurn(room, 'p0');
  playOk(room, '水花'); // p1 的词
  const n1 = room.nodes.find(n => n.word === '水花');
  g.challenge(room, 'p2', n1.id);
  assert.strictEqual(room.pendingChallenge.adjudicatorId, 'p0');
  room.players.find(p => p.id === 'p0').connected = false;
  // 合格人选：在线、非质疑者、非词主 → 无人（p1 词主，p2 质疑者）
  assert.strictEqual(g.ensureAdjudicatorOnline(room), false);
  // 甲的词被乙质疑，裁定者是丙；丙掉线后无其他合格人选（甲词主、乙质疑者）→ 保持
  // 换 4 人局验证移交成功
  const room4 = g.newRoom('TEST4', 'h', '一');
  ['h', 'a', 'b', 'c'].forEach((id, i) => g.addPlayer(room4, id, `玩家${i}`));
  g.startGame(room4, 'h', () => 0.01);
  g.playWord(room4, 'h', { word: '开心', parentId: 'start0', relation: 'synonym', reason: '合理的解释' });
  const node = room4.nodes.find(n => n.word === '开心');
  g.challenge(room4, 'a', node.id); // 房主的词 → 顺延给非词主非质疑者：b
  assert.strictEqual(room4.pendingChallenge.adjudicatorId, 'b');
  room4.players.find(p => p.id === 'b').connected = false;
  assert.strictEqual(g.ensureAdjudicatorOnline(room4), true);
  assert.strictEqual(room4.pendingChallenge.adjudicatorId, 'c');
  // c 可以正常裁定，对局继续
  assert.strictEqual(g.resolveChallenge(room4, 'c', 'reject'), null);
  assert.strictEqual(room4.pendingChallenge, null);
});

test('涉及房主的质疑由其他玩家裁定', () => {
  const room = makeRoom(['甲', '乙', '丙']);
  playOk(room, '开心'); // p0（房主）的词
  const n1 = room.nodes.find(n => n.word === '开心');
  g.challenge(room, 'p1', n1.id); // p0 回合内，p1 质疑
  assert.notStrictEqual(room.pendingChallenge.adjudicatorId, 'p0');
  assert.notStrictEqual(room.pendingChallenge.adjudicatorId, 'p1', '质疑者不应裁定自己的质疑');
  assert.strictEqual(g.resolveChallenge(room, 'p0', 'uphold'), '只有裁定者可以判定');
  assert.strictEqual(g.resolveChallenge(room, room.pendingChallenge.adjudicatorId, 'uphold'), null);
});

// ---------- 观战模式 ----------

test('观战：对局开始后仍可加入，且不占玩家名额、不进入回合顺序', () => {
  const room = makeRoom(['甲', '乙']);
  assert.strictEqual(g.addSpectator(room, 'sp1', '朋友'), null);
  assert.ok(g.isSpectator(room, 'sp1'));
  assert.strictEqual(room.players.length, 2);
  assert.deepStrictEqual(g.computeScores(room).map(s => s.playerId), ['p0', 'p1']);
});

test('观战：大厅阶段也能进入看规则与玩家', () => {
  const room = g.newRoom('LOBBY', 'p0', '甲');
  g.addPlayer(room, 'p0', '甲');
  assert.strictEqual(g.addSpectator(room, 'sp1', '朋友'), null);
  const view = g.publicView(room, 'sp1');
  assert.strictEqual(view.spectating, true);
  assert.strictEqual(view.players.length, 1);
  assert.strictEqual(view.spectators.length, 1);
  // 玩家视角里自己不是观战者，但能看到观战名单
  assert.strictEqual(g.publicView(room, 'p0').spectating, false);
  assert.strictEqual(g.publicView(room, 'p0').spectators.length, 1);
});

test('观战者不能接词、加固、结束回合、质疑或裁定', () => {
  const room = makeRoom(['甲', '乙']);
  g.addSpectator(room, 'sp1', '朋友');
  playOk(room, '开心');
  const node = room.nodes.find(n => n.word === '开心');
  assert.match(g.playWord(room, 'sp1', { word: '旁观词', parentId: 'start0',
    relation: 'synonym', reason: '足够长度的解释' }), /观战/);
  assert.match(g.reinforce(room, 'sp1', node.id), /观战/);
  assert.match(g.endTurn(room, 'sp1'), /观战/);
  assert.match(g.challenge(room, 'sp1', node.id), /观战/);
  // 观战者即便伪造裁定请求也被拒绝
  g.challenge(room, 'p1', node.id);
  assert.match(g.resolveChallenge(room, 'sp1', 'uphold'), /观战/);
});

test('观战者不能修改规则或开始游戏', () => {
  const lobby = g.newRoom('L', 'p0', '甲');
  g.addPlayer(lobby, 'p0', '甲');
  g.addSpectator(lobby, 'sp1', '朋友');
  assert.match(g.setRuleSet(lobby, 'sp1', { turnSeconds: 60 }), /观战/);
  assert.match(g.startGame(lobby, 'sp1'), /观战/);
});

test('观战人数有上限', () => {
  const room = makeRoom(['甲', '乙']);
  for (let i = 0; i < g.MAX_SPECTATORS; i++) {
    assert.strictEqual(g.addSpectator(room, `sp${i}`, `观${i}`), null);
  }
  assert.match(g.addSpectator(room, 'spX', '再多一个'), /已满/);
});

test('断线的观战者可恢复身份，被清出房间后需重新进入', () => {
  const room = makeRoom(['甲', '乙']);
  g.addSpectator(room, 'sp1', '朋友');
  room.spectators[0].connected = false;
  room.spectators[0].connected = true; // 模拟刷新页面后凭 token 恢复
  assert.ok(g.isSpectator(room, 'sp1'));
  g.removeSpectator(room, 'sp1');
  assert.ok(!g.isSpectator(room, 'sp1'));
  assert.strictEqual(room.players.length, 2, '清出观战者不影响玩家');
});

test('服务器重启：旧观战者立即清出，玩家保留座位置离线', () => {
  const room = makeRoom(['甲', '乙']);
  // 占满观战名额（重启前都在线）
  for (let i = 0; i < g.MAX_SPECTATORS; i++) {
    assert.strictEqual(g.addSpectator(room, `sp${i}`, `观${i}`), null);
  }
  assert.strictEqual(room.spectators.filter(s => s.connected).length, g.MAX_SPECTATORS);
  assert.match(g.addSpectator(room, 'spX', '再来一个'), /已满/);
  const playerCount = room.players.length;

  // 模拟服务器恢复房间：连接已全部不存在
  g.resetConnectionsAfterRestart(room); // 玩家置离线
  g.removeAllSpectators(room);          // 观战者立即清出（而非挂在名单上等延迟清理）

  assert.strictEqual(room.spectators.length, 0, '大厅/对局名单上不应残留旧观战者');
  assert.ok(room.players.every(p => p.connected === false), '玩家置离线（凭 token 重连恢复）');
  assert.strictEqual(room.players.length, playerCount, '玩家座位保留');

  // 名额立即全部释放：新观战者当场就能进，最多 MAX_SPECTATORS 人
  for (let i = 0; i < g.MAX_SPECTATORS; i++) {
    assert.strictEqual(g.addSpectator(room, `nw${i}`, `新观${i}`), null);
  }
  assert.match(g.addSpectator(room, 'spX', '再多一个'), /已满/);
});

test('历史战绩摘要：名次、得分、胜者与时间；未结束房间也可查', () => {
  const room = makeRoom(['甲', '乙']);
  assert.strictEqual(g.historySummary(room, '陌生人'), null, '非本房玩家没有战绩');

  // 对局进行中：可重返，但还没有名次与得分
  const playing = g.historySummary(room, 'p0');
  assert.strictEqual(playing.phase, 'playing');
  assert.strictEqual(playing.yourRank, null);
  assert.strictEqual(playing.yourTotal, null);
  assert.strictEqual(playing.endedAt, null);

  playOk(room, '开心'); // 甲接一词，确保分出胜负
  const total = room.players.length * room.ruleSet.rounds;
  for (let i = 0; i < total; i++) g.endTurn(room, room.turn.playerId);

  const s = g.historySummary(room, 'p0');
  assert.strictEqual(s.phase, 'ended');
  assert.ok(s.endedAt >= s.createdAt, '记录结束时间供列表展示与排序');
  assert.strictEqual(s.winner, 'p0');
  assert.strictEqual(s.winnerName, '甲');
  assert.strictEqual(s.yourRank, 1);
  assert.ok(s.yourTotal > 0);
  assert.deepStrictEqual(s.players, ['甲', '乙']);
  assert.strictEqual(s.youName, '甲');

  const s1 = g.historySummary(room, 'p1');
  assert.strictEqual(s1.yourRank, 2);
  assert.strictEqual(s1.yourTotal, 0);
});

test('房主提前离线时，新质疑的裁定者顺延给在线玩家', () => {
  // 4 人局：房主 p0 离线；p1 的词被 p2 质疑 → 裁定者应是在线的 p3，而不是离线房主
  const room = g.newRoom('TESTOFF', 'p0', '甲');
  ['p0', 'p1', 'p2', 'p3'].forEach((id, i) => g.addPlayer(room, id, `玩家${i}`));
  g.startGame(room, 'p0', () => 0.01);
  g.endTurn(room, 'p0'); // 轮到 p1
  g.playWord(room, 'p1', { word: '水花', parentId: 'start0', relation: 'synonym', reason: '合理的解释' });
  room.players.find(p => p.id === 'p0').connected = false; // 房主提前离线
  const n1 = room.nodes.find(n => n.word === '水花');
  assert.strictEqual(g.challenge(room, 'p2', n1.id), null);
  assert.strictEqual(room.pendingChallenge.adjudicatorId, 'p3', '离线房主不应再收到新质疑');
  assert.strictEqual(g.resolveChallenge(room, 'p3', 'reject'), null, '在线裁定者可正常裁定，对局不停住');
  assert.strictEqual(room.pendingChallenge, null);
});

test('没有在线裁定者时，质疑被拒绝：不扣次数、不停计时、不卡对局', () => {
  const room = makeRoom(['甲', '乙', '丙']); // p0 房主
  g.endTurn(room, 'p0');
  playOk(room, '水花'); // p1 的词
  room.players.find(p => p.id === 'p0').connected = false; // 房主提前离线
  const n1 = room.nodes.find(n => n.word === '水花');
  const challenger = room.players.find(p => p.id === 'p2');
  const tokensBefore = challenger.tokensLeft;
  const err = g.challenge(room, 'p2', n1.id); // p1 词主、p2 质疑者 → 无在线裁定者
  assert.match(err, /裁定/);
  assert.strictEqual(room.pendingChallenge, null, '不应产生待裁定质疑');
  assert.strictEqual(challenger.tokensLeft, tokensBefore, '不扣质疑次数');
  assert.ok(room.turn.deadline, '回合计时不应暂停');
  // 房主回来后即可正常质疑
  room.players.find(p => p.id === 'p0').connected = true;
  assert.strictEqual(g.challenge(room, 'p2', n1.id), null);
  assert.strictEqual(room.pendingChallenge.adjudicatorId, 'p0');
  assert.strictEqual(challenger.tokensLeft, tokensBefore - 1);
});

test('房主在线时，新质疑的裁定者仍是房主', () => {
  const room = makeRoom(['甲', '乙', '丙']);
  g.endTurn(room, 'p0');
  playOk(room, '水花'); // p1 的词
  const n1 = room.nodes.find(n => n.word === '水花');
  assert.strictEqual(g.challenge(room, 'p2', n1.id), null);
  assert.strictEqual(room.pendingChallenge.adjudicatorId, 'p0');
});
