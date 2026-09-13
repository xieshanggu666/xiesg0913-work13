'use strict';
/* 战术练习：纯逻辑模块，浏览器（window.WTPractice）与 Node（测试）共用。
   三个固定局面，单机离线练习"延长词链 / 保护关键连接 / 理解级联拆除"。
   计分（depthOf / 词分 + 最长链奖励）与级联拆除规则与 game.js 保持一致。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WTPractice = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const YOU = 'p1';   // 练习者
  const OPP = 'p2';   // 固定对手
  const PLAYERS = [
    { id: YOU, name: '你', color: '#2e86de' },
    { id: OPP, name: '对手', color: '#e0533d' },
  ];

  const RELATION_NAMES = {
    synonym: '同义/近义', antonym: '反义/对立', hypernym: '上下位',
    part: '部分-整体', cause: '因果', tool: '工具-用途',
    scene: '场景共现', derive: '词形/谐音衍生',
  };
  const relationName = (id) => RELATION_NAMES[id] || id;

  // ---------- 计分（与 game.js 同规则） ----------

  // 深度 = 向上追溯到根经过的玩家词数；中立起始词不计入
  function depthOf(nodes, node) {
    let d = 0, cur = node, guard = 0;
    while (cur.parentId && guard < 1000) {
      const parent = nodes.find(n => n.id === cur.parentId);
      if (!parent || parent.ownerId === null) break;
      d += 1; cur = parent; guard += 1;
    }
    return d;
  }

  // 逐词计分明细，供"得分变化和原因解释"面板使用
  function scoreBreakdown(nodes, playerId) {
    const words = [];
    let wordSum = 0, longest = 0;
    for (const n of nodes.filter(n => n.ownerId === playerId)) {
      const depth = depthOf(nodes, n);
      const base = 1 + depth;
      const reinforceBonus = n.reinforced && n.parentId ? 1 : 0;
      wordSum += base + reinforceBonus;
      longest = Math.max(longest, depth + 1);
      words.push({ id: n.id, word: n.word, depth, base, reinforceBonus,
        total: base + reinforceBonus });
    }
    const bonus = longest * 2;
    return { words, wordSum, longest, bonus, total: wordSum + bonus };
  }

  // ---------- 级联拆除（与 game.js cascadeRemove 同规则） ----------

  // 级联拆除（就地版本，行为与 game.js cascadeRemove 一致）：
  // 未加固下游递归倒塌，加固下游断开父链成为新的领地根
  function cascadeRemoveInPlace(nodes, nodeId, removed) {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;
    removed.push(node);
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (nodes[i].id === nodeId) nodes.splice(i, 1);
    }
    for (const child of nodes.filter(n => n.parentId === nodeId)) {
      if (child.reinforced) {
        child.parentId = null;
        child.survivedAsRoot = true;
      } else {
        cascadeRemoveInPlace(nodes, child.id, removed);
      }
    }
  }

  // 在 nodes 的副本上拆除 nodeId，返回新盘面与按拆除顺序排列的词
  function applyChallenge(nodes, nodeId) {
    const next = nodes.map(n => ({ ...n }));
    const removed = [];
    cascadeRemoveInPlace(next, nodeId, removed);
    return { nodes: next, removed };
  }

  // ---------- 三个固定局面 ----------

  const startNode = (id, word) =>
    ({ id, word, ownerId: null, parentId: null, relation: null, reason: '起始词', reinforced: true });

  const SCENARIOS = [
    {
      id: 'extend-chain',
      title: '第 1 关 · 延长词链',
      subtitle: '用 2 行动点把词链接长，体会深度分与最长链奖励',
      goal: '轮到你行动，你有 2 行动点。盘面已有一条你接出的短链「火 → 光 → 灯」。'
        + '想想词该接到哪里：每个词得 1+深度 分，加固 +1，最长链还有 ×2 奖励。'
        + '提交后看看你的总分能不能到本局面最高。',
      ops: [
        '点「接词」从候选词中选词接出（每个词 1 行动点，关系和解释已固定好）',
        '有的候选词要先接上它前面的词才会解锁——留意谁能把链再延长一节',
        '「提交答案」结算本回合；「重置」随时回到初始局面',
      ],
      mode: 'extend',
      ap: 2,
      nodes: [
        startNode('s0', '火'),
        startNode('s1', '海'),
        { id: 'guang', word: '光', ownerId: YOU, parentId: 's0', relation: 'scene',
          reason: '火光相伴，常一起出现', reinforced: false },
        { id: 'deng', word: '灯', ownerId: YOU, parentId: 'guang', relation: 'scene',
          reason: '有灯的地方就有光', reinforced: false },
      ],
      palette: [
        { id: 'm-ye', word: '夜', parent: 'deng', relation: 'scene', reason: '夜里点灯，二者常一起出现' },
        { id: 'm-lang', word: '浪', parent: 's1', relation: 'scene', reason: '海浪是海面上的景象' },
        { id: 'm-xing', word: '星', parent: 'm-ye', relation: 'scene', reason: '夜里才能看到星星' },
        { id: 'm-ying', word: '影', parent: 'guang', relation: 'cause', reason: '有光照射就会投下影子' },
      ],
    },
    {
      id: 'protect-link',
      title: '第 2 关 · 保护关键连接',
      subtitle: '只有 1 行动点加固，判断哪条连接最关键',
      goal: '对手放话：你一提交，他就会质疑一条让你失分最多的未加固连接（练习中裁定一律成立）。'
        + '你只有 1 行动点，可以加固自己的一条连接。'
        + '记住：质疑成立时该词被拆，未加固的下游整片级联倒塌；加固过的下游会成为新根撑住。'
        + '想清楚加固哪条连接，能把最坏情况的损失降到最小。',
      ops: [
        '点「加固」进入选择，再点你自己的一条连接（1 行动点，只能加固一处）',
        '提交后对手自动质疑让你损失最大的目标，连接立即被拆除、下游级联',
        '「重置」可重新选择加固位置',
      ],
      mode: 'protect',
      ap: 1,
      nodes: [
        startNode('s0', '火'),
        startNode('s1', '海'),
        { id: 'opp-chuan', word: '船', ownerId: OPP, parentId: 's1', relation: 'scene',
          reason: '海面上行船', reinforced: false },
        { id: 'guang', word: '光', ownerId: YOU, parentId: 's0', relation: 'scene',
          reason: '火光相伴，常一起出现', reinforced: false },
        { id: 'deng', word: '灯', ownerId: YOU, parentId: 'guang', relation: 'scene',
          reason: '有灯的地方就有光', reinforced: false },
        { id: 'ye', word: '夜', ownerId: YOU, parentId: 'deng', relation: 'scene',
          reason: '夜里点灯，二者常一起出现', reinforced: false },
        { id: 'ying', word: '影', ownerId: YOU, parentId: 'guang', relation: 'cause',
          reason: '有光照射就会投下影子', reinforced: false },
      ],
      palette: [],
    },
    {
      id: 'cascade-teardown',
      title: '第 3 关 · 级联拆除',
      subtitle: '一次质疑拆掉最多的词，看懂未加固下游如何整片倒塌',
      goal: '现在轮到你质疑。对手在「海」上建起一片领地，其中只有「帆」是加固过的。'
        + '你只能质疑一条未加固的连接，练习中裁定一律成立。'
        + '选择拆除后级联规模最大、让对手失分最多的目标。',
      ops: [
        '点击对手的一条未加固连接选中它（再点一次取消），然后「提交答案」',
        '只能质疑一次；被拆词的未加固下游会全部级联倒塌，加固下游会截断级联',
        '「重置」可重新选择目标',
      ],
      mode: 'cascade',
      ap: 0,
      nodes: [
        startNode('s0', '火'),
        startNode('s1', '海'),
        { id: 'matou', word: '码头', ownerId: YOU, parentId: 's1', relation: 'scene',
          reason: '海边常有码头', reinforced: false },
        { id: 'lang', word: '浪', ownerId: OPP, parentId: 's1', relation: 'scene',
          reason: '海里有浪', reinforced: false },
        { id: 'chuan', word: '船', ownerId: OPP, parentId: 'lang', relation: 'scene',
          reason: '浪里行船', reinforced: false },
        { id: 'fan', word: '帆', ownerId: OPP, parentId: 'chuan', relation: 'part',
          reason: '帆是船的一部分', reinforced: true },
        { id: 'chonglang', word: '冲浪', ownerId: OPP, parentId: 'lang', relation: 'scene',
          reason: '浪大适合冲浪', reinforced: false },
        { id: 'ban', word: '冲浪板', ownerId: OPP, parentId: 'chonglang', relation: 'tool',
          reason: '冲浪要用到冲浪板', reinforced: false },
      ],
      palette: [],
    },
  ];

  // ---------- 练习会话 ----------

  function startSession(scenarioId) {
    const scenario = SCENARIOS.find(s => s.id === scenarioId);
    if (!scenario) return null;
    return {
      scenario,
      nodes: scenario.nodes.map(n => ({ ...n })),
      apLeft: scenario.ap,
      actions: [],             // {type:'play',moveId} / {type:'reinforce',nodeId}
      pendingChallengeId: null,
      finished: false,
      result: null,
    };
  }

  function resetSession(session) {
    const fresh = startSession(session.scenario.id);
    Object.keys(session).forEach(k => { delete session[k]; });
    Object.assign(session, fresh);
    return session;
  }

  // 候选词面板需要展示"接到谁后面"
  function parentWord(scenario, parentId) {
    const n = scenario.nodes.find(x => x.id === parentId);
    if (n) return n.word;
    const m = scenario.palette.find(x => x.id === parentId);
    return m ? m.word : '?';
  }

  function playWord(session, moveId) {
    if (session.finished) return '已提交答案，请先重置';
    if (session.scenario.mode !== 'extend') return '本关不能接词';
    if (session.apLeft < 1) return '行动点不足';
    const move = session.scenario.palette.find(m => m.id === moveId);
    if (!move) return '没有这个候选词';
    if (session.nodes.some(n => n.id === move.id)) return '这个词已经接上场了';
    if (!session.nodes.some(n => n.id === move.parent)) return '要先接上它前面的词';
    session.nodes.push({
      id: move.id, word: move.word, ownerId: YOU, parentId: move.parent,
      relation: move.relation, reason: move.reason, reinforced: false,
    });
    session.apLeft -= 1;
    session.actions.push({ type: 'play', moveId });
    return null;
  }

  function reinforce(session, nodeId) {
    if (session.finished) return '已提交答案，请先重置';
    if (session.scenario.mode !== 'protect') return '本关不能加固';
    if (session.apLeft < 1) return '行动点不足';
    const node = session.nodes.find(n => n.id === nodeId);
    if (!node) return '目标词不存在';
    if (!node.parentId) return '起始词无需加固';
    if (node.ownerId !== YOU) return '只能加固自己的词';
    if (node.reinforced) return '这条连接已经加固过了';
    node.reinforced = true;
    session.apLeft -= 1;
    session.actions.push({ type: 'reinforce', nodeId });
    return null;
  }

  // 级联关：点选质疑目标（再点一次取消），提交时才真正拆除
  function selectChallenge(session, nodeId) {
    if (session.finished) return '已提交答案，请先重置';
    if (session.scenario.mode !== 'cascade') return '本关不能质疑';
    const node = session.nodes.find(n => n.id === nodeId);
    if (!node) return '目标词不存在';
    if (node.ownerId !== OPP || !node.parentId) return '只能质疑对手接出的词';
    if (node.reinforced) return '加固过的连接免疫质疑';
    session.pendingChallengeId = session.pendingChallengeId === nodeId ? null : nodeId;
    return null;
  }

  // ---------- 提交评估 ----------

  function submit(session) {
    if (session.finished) return session.result;
    const mode = session.scenario.mode;
    if (mode === 'extend') session.result = evalExtend(session);
    else if (mode === 'protect') session.result = evalProtect(session);
    else {
      const err = evalCascade(session);
      if (typeof err === 'string') return err;
    }
    session.finished = true;
    return session.result;
  }

  function scorePair(initNodes, finalNodes) {
    const b1 = scoreBreakdown(initNodes, YOU), a1 = scoreBreakdown(finalNodes, YOU);
    const b2 = scoreBreakdown(initNodes, OPP), a2 = scoreBreakdown(finalNodes, OPP);
    return {
      you: { name: '你', before: b1.total, after: a1.total },
      opp: { name: '对手', before: b2.total, after: a2.total },
    };
  }

  // -- 第 1 关：穷举合法接法（行动点 ≤ 2、候选词 ≤ 4，状态空间很小），找最高总分 --

  function bestExtend(nodes, apLeft, palette) {
    let best = { total: scoreBreakdown(nodes, YOU).total, seq: [] };
    if (apLeft === 0) return best;
    for (const m of palette) {
      if (nodes.some(n => n.id === m.id)) continue;
      if (!nodes.some(n => n.id === m.parent)) continue;
      const next = nodes.map(n => ({ ...n }));
      next.push({ id: m.id, word: m.word, ownerId: YOU, parentId: m.parent,
        relation: m.relation, reason: m.reason, reinforced: false });
      const sub = bestExtend(next, apLeft - 1, palette);
      const cand = { total: sub.total, seq: [m.id, ...sub.seq] };
      if (cand.total > best.total) best = cand;
    }
    return best; // 提前结束（少用行动点）也是合法选择，已包含在初始值里
  }

  function evalExtend(session) {
    const sc = session.scenario;
    const init = sc.nodes;
    const before = scoreBreakdown(init, YOU);
    const after = scoreBreakdown(session.nodes, YOU);
    const best = bestExtend(init.map(n => ({ ...n })), sc.ap, sc.palette);
    const bestWords = best.seq.map(id => sc.palette.find(m => m.id === id).word);
    const passed = after.total === best.total;

    const lines = [];
    lines.push(`提交前：词分 ${before.wordSum} + 最长链 ×2 奖励 ${before.bonus}（链长 ${before.longest}）= ${before.total} 分。`);
    const plays = session.actions.filter(a => a.type === 'play');
    if (!plays.length) {
      lines.push('你没有接出任何词，2 个行动点都浪费了。');
    }
    for (const a of plays) {
      const node = session.nodes.find(n => n.id === a.moveId);
      lines.push(`接出「${node.word}」：位于深度 ${depthOf(session.nodes, node)}，这个词得 ${1 + depthOf(session.nodes, node)} 分。`);
    }
    if (after.longest > before.longest) {
      lines.push(`最长链从 ${before.longest} 延长到 ${after.longest}，奖励从 ${before.bonus} 分涨到 ${after.bonus} 分。`);
    } else if (plays.length) {
      lines.push(`最长链没有变长（仍是 ${after.longest}），奖励停在 ${after.bonus} 分——从起始词旁另开短链，新词只有 1 分。`);
    }
    lines.push(`提交后：词分 ${after.wordSum} + 最长链奖励 ${after.bonus} = ${after.total} 分（本回合 ${after.total - before.total >= 0 ? '+' : ''}${after.total - before.total}）。`);
    if (session.apLeft > 0 && !passed) {
      lines.push(`你还剩 ${session.apLeft} 行动点没用：把行动点换成链上的词，通常都划算。`);
    }
    if (passed) {
      lines.push(`✅ 通关！最优接法是沿链接 ${bestWords.map(w => `「${w}」`).join(' → ')}，拿到最高 ${best.total} 分：深处的词分高，最长链 ×2 奖励也拉满。`);
    } else {
      lines.push(`还没到最优：沿链接 ${bestWords.map(w => `「${w}」`).join(' → ')} 可拿 ${best.total} 分（比现在多 ${best.total - after.total} 分）。词链越长，深处每个词的分越高；接到另一个起始词旁的短链只得 1 分。`);
    }

    return {
      passed, mode: 'extend',
      scores: scorePair(init, session.nodes),
      removed: [],
      lines,
    };
  }

  // -- 第 2 关：先应用玩家的（至多一处）加固，再由对手贪心质疑失分最多的目标 --

  // 对手在给定盘面下的最优质疑：枚举所有可质疑的本盘目标，取让 player 失分最多的
  function greedyChallenge(nodes, victim) {
    const beforeTotal = scoreBreakdown(nodes, victim).total;
    let pick = null;
    for (const t of nodes.filter(n => n.ownerId === victim && n.parentId && !n.reinforced)) {
      const sim = applyChallenge(nodes, t.id);
      const afterTotal = scoreBreakdown(sim.nodes, victim).total;
      const loss = beforeTotal - afterTotal;
      if (!pick || loss > pick.loss) {
        pick = { targetId: t.id, targetWord: t.word, loss, sim };
      }
    }
    return pick;
  }

  function survivorInfo(nodes) {
    return nodes.filter(n => n.survivedAsRoot).map(n => {
      const sub = [];
      const collect = (pid) => {
        for (const c of nodes.filter(x => x.parentId === pid)) {
          sub.push(c.word);
          collect(c.id);
        }
      };
      collect(n.id);
      return { word: n.word, subtree: sub };
    });
  }

  function evalProtect(session) {
    const sc = session.scenario;
    const init = sc.nodes;
    const before = scoreBreakdown(init, YOU);

    // 穷举所有 1 行动点防守方案：不加固 / 加固自己的某条连接。
    // 各方案的失分统一以"加固前总分"为基准，与下面"你的总分 14 → X"那一行口径一致；
    // 对手在每种防线下各自贪心选择让自己收益最大（你失分最多）的质疑目标。
    const defenses = [{ reinforceId: null, label: '不加固', defended: init.map(x => ({ ...x })) }];
    for (const n of init.filter(x => x.ownerId === YOU && x.parentId)) {
      defenses.push({
        reinforceId: n.id, label: `加固「${n.word}」`,
        defended: init.map(x => ({ ...x, reinforced: x.reinforced || x.id === n.id })),
      });
    }
    for (const d of defenses) {
      d.pick = greedyChallenge(d.defended, YOU);
      d.loss = before.total - scoreBreakdown(d.pick.sim.nodes, YOU).total;
    }
    const used = session.actions.find(a => a.type === 'reinforce') || null;
    const actual = defenses.find(d => d.reinforceId === (used ? used.nodeId : null));
    const best = defenses.reduce((a, b) => (b.loss < a.loss ? b : a));
    const passed = actual.loss === best.loss;

    // 实际防线下对手每个候选质疑的得失（解释"为什么挑中它"）
    const defendedNodes = actual.defended;
    const targetTable = [];
    for (const t of defendedNodes.filter(n => n.ownerId === YOU && n.parentId && !n.reinforced)) {
      const sim = applyChallenge(defendedNodes, t.id);
      targetTable.push({ word: t.word, loss: before.total - scoreBreakdown(sim.nodes, YOU).total,
        removedCount: sim.removed.length, picked: t.id === actual.pick.targetId });
    }
    targetTable.sort((a, b) => b.loss - a.loss);

    // 定格提交后盘面
    const finalNodes = actual.pick.sim.nodes;
    session.nodes = finalNodes;
    const after = scoreBreakdown(finalNodes, YOU);
    const removedWords = actual.pick.sim.removed.map(n => n.word);
    const survivors = survivorInfo(finalNodes);

    const lines = [];
    lines.push(`提交前你的总分：${before.total} 分（词分 ${before.wordSum} + 最长链奖励 ${before.bonus}）。`);
    lines.push(used ? `你用唯一的行动点选择了${actual.label}（加固 +1 分，且该连接免疫质疑）。`
                    : '你没有加固，把行动点留了下来。');
    lines.push(`对手逐一权衡后，质疑了「${actual.pick.targetWord}」——在你当前的防线下，这一下让你失分最多：`);
    for (const r of targetTable) {
      lines.push(`· 质疑「${r.word}」：拆掉 ${r.removedCount} 个词，你失 ${r.loss} 分${r.picked ? ' ← 对手选它' : ''}`);
    }
    if (removedWords.length) {
      lines.push(`裁定成立，级联拆除 ${removedWords.length} 个词：${removedWords.map(w => `「${w}」`).join(' → ')}。`);
    }
    if (survivors.length) {
      lines.push('级联遇到加固连接会截断：' + survivors.map(s =>
        `「${s.word}」成为新的领地根${s.subtree.length ? `，保住了下游 ${s.subtree.map(w => `「${w}」`).join('、')}` : ''}`).join('；') + '。');
    }
    lines.push(`你的总分：${before.total} → ${after.total}（${after.total - before.total >= 0 ? '+' : ''}${after.total - before.total} 分，含加固本身的 +1）。`);
    lines.push('各方案的最坏结果：' + defenses.map(d =>
      `${d.label}失 ${d.loss} 分${d === best ? '（最优）' : ''}`).join('；') + '。');
    if (passed) {
      lines.push(`✅ 通关！${best.label}是正解：这条连接最靠近根、下游连着最多词，是整片领地的关键连接。它被加固后免疫质疑，对手只能绕去拆更深处的连接；就算上方出了事，级联也会在加固处截断，下游不会被整片带走。`);
    } else {
      lines.push(`还没到最优：应选择${best.label}，最坏只失 ${best.loss} 分（你失了 ${actual.loss} 分）。加固只护住这一条连接、并让级联在它这里截断，所以一定要花在撑着最多下游词的关键连接上。`);
    }

    return {
      passed, mode: 'protect',
      scores: scorePair(init, finalNodes),
      removed: actual.pick.sim.removed,
      lines,
    };
  }

  // -- 第 3 关：枚举每个可质疑目标的拆除规模与失分，取最大 --

  function evalCascade(session) {
    const sc = session.scenario;
    const init = sc.nodes;
    if (!session.pendingChallengeId) return '先点击选择要质疑的词';
    const before = scoreBreakdown(init, OPP);

    const table = init
      .filter(n => n.ownerId === OPP && n.parentId && !n.reinforced)
      .map(t => {
        const sim = applyChallenge(init, t.id);
        const survivors = sim.nodes.filter(n => n.survivedAsRoot);
        return { id: t.id, word: t.word, sim,
          removedCount: sim.removed.length,
          loss: before.total - scoreBreakdown(sim.nodes, OPP).total,
          survivors: survivors.map(n => n.word) };
      });
    table.sort((a, b) => b.loss - a.loss || b.removedCount - a.removedCount);
    const actual = table.find(t => t.id === session.pendingChallengeId);
    const best = table[0];
    const passed = actual.loss === best.loss;

    session.nodes = actual.sim.nodes;
    const after = scoreBreakdown(session.nodes, OPP);
    const removedWords = actual.sim.removed.map(n => n.word);
    const survivors = survivorInfo(session.nodes);

    const lines = [];
    lines.push('练习中连接一律按裁定成立处理。');
    lines.push(`你质疑了「${actual.word}」，级联拆除 ${actual.removedCount} 个词：${removedWords.map(w => `「${w}」`).join(' → ')}。`);
    if (survivors.length) {
      lines.push(`加固词${survivors.map(s => `「${s.word}」`).join('、')}截断了级联，成为新的领地根保留下来。`);
    }
    lines.push(`对手总分：${before.total} → ${after.total}（−${actual.loss} 分）；你的分数不变。`);
    lines.push('各质疑目标的效果：' + table.map(t =>
      `「${t.word}」拆 ${t.removedCount} 词、−${t.loss} 分${t === best ? '（最优）' : ''}`).join('；') + '。');
    if (passed) {
      lines.push('✅ 通关！质疑越靠近根的未加固连接，一次带走的未加固下游越多——整片分支连根拔起；但级联遇到加固词会停下，加固词带着自己的下游另成新根。');
    } else {
      lines.push(`还没到最优：质疑「${best.word}」能拆 ${best.removedCount} 个词、让对手失 ${best.loss} 分（你只造成 ${actual.loss} 分损失）。动手前先沿未加固的下游数一数会倒塌多少词。`);
    }

    session.result = {
      passed, mode: 'cascade',
      scores: scorePair(init, session.nodes),
      removed: actual.sim.removed,
      lines,
    };
    return null;
  }

  return {
    YOU, OPP, PLAYERS, RELATION_NAMES,
    SCENARIOS,
    relationName, depthOf, scoreBreakdown, applyChallenge,
    startSession, resetSession, parentWord,
    playWord, reinforce, selectChallenge, submit,
  };
});
