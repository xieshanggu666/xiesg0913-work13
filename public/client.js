'use strict';
/* 词语领地客户端 */
(() => {
  const $ = (id) => document.getElementById(id);
  const store = {
    get token() { return localStorage.getItem('wt_token'); },
    set token(v) { v ? localStorage.setItem('wt_token', v) : localStorage.removeItem('wt_token'); },
    get name() { return localStorage.getItem('wt_name') || ''; },
    set name(v) { localStorage.setItem('wt_name', v); },
    get seenTips() { return JSON.parse(localStorage.getItem('wt_tips') || '[]'); },
    addSeenTip(k) {
      const a = store.seenTips; if (!a.includes(k)) { a.push(k); localStorage.setItem('wt_tips', JSON.stringify(a)); }
    },
    // 历史与战绩：本机参与过的房间 token（用于换取战绩摘要与重返房间），上限 30 条
    get history() { return JSON.parse(localStorage.getItem('wt_history') || '[]'); },
    set history(v) { localStorage.setItem('wt_history', JSON.stringify(v)); },
    addHistory(token, roomCode) {
      const a = store.history.filter(e => e.roomCode !== roomCode);
      a.unshift({ token, roomCode });
      store.history = a.slice(0, 30);
    },
  };

  let ws = null, state = null, prevState = null;
  let selectedParent = null;   // 接词时选中的父节点
  let reinforceMode = false;
  let challengeNodeId = null;
  let replayFrames = null, replayIdx = 0;
  let timerInterval = null;

  // ---------- 连接 ----------

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => {
      if (store.token) send({ type: 'reconnect', token: store.token });
      requestHistory();
    };
    ws.onmessage = (e) => handle(JSON.parse(e.data));
    ws.onclose = () => {
      // 连接断开：在途的保存请求不会再收到答复，解除提交锁定（重连后会拉取最新状态）
      setRulesSavePending(false);
      setTimeout(connect, 1500); // 自动重连
    };
  }

  function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

  function handle(msg) {
    switch (msg.type) {
      case 'joined':
        store.token = msg.token;
        // 观战是临时只读身份，不进历史；玩家 token 按房间码去重保存
        if (!msg.spectator) store.addHistory(msg.token, msg.roomCode);
        break;
      case 'state':
        prevState = state;
        state = msg.state;
        onStateChange(prevState, state);
        render();
        break;
      case 'error':
        // 规则保存失败：编辑器保持打开，错误就地展示
        if (msg.context === 'setRules') onRulesSaveError(msg.message);
        else toast(msg.message);
        if (msg.message.includes('会话已失效') || msg.message.includes('房间已不存在')) {
          store.token = null;
          showScreen('home');
        }
        break;
      case 'rulesSaved':
        onRulesSaved();
        break;
      case 'replay':
        replayFrames = msg.frames; replayIdx = 0;
        openReplay();
        break;
      case 'history':
        onHistory(msg.entries);
        break;
    }
  }

  // ---------- 历史与战绩 ----------

  let historyEntries = [];
  let historyQueryTokens = []; // 最近一次历史查询覆盖的 token，决定清理失效记录的范围

  function requestHistory() {
    const tokens = store.history.map(e => e.token);
    if (!tokens.length) { historyEntries = []; renderHistory(); return; }
    historyQueryTokens = tokens;
    send({ type: 'history', tokens });
  }

  function onHistory(entries) {
    // 只清理"本次查询过、但服务器已不认得"的 token（房间已删/数据已清）。
    // 不能按"未出现在结果中"全量清理：查询发出后，其他标签页可能又加入了新房间，
    // 那些记录不在本次查询的覆盖范围里，全量清理会把它们误删掉。
    const valid = new Set(entries.map(e => e.token));
    const queried = new Set(historyQueryTokens);
    store.history = store.history.filter(e => !queried.has(e.token) || valid.has(e.token));
    // 发现有本次查询未覆盖的新记录：补一次查询，把它们也带进列表
    if (store.history.some(e => !queried.has(e.token))) { requestHistory(); return; }
    historyEntries = entries;
    renderHistory();
  }

  function fmtDate(ts) {
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function renderHistory() {
    const card = $('history-card');
    if (!historyEntries.length) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    const ended = historyEntries.filter(e => e.phase === 'ended');
    const wins = ended.filter(e => e.winner && e.winner === e.youId).length;
    $('history-stats').textContent = ended.length
      ? `已结束 ${ended.length} 场 · 胜 ${wins} 场 · 胜率 ${Math.round(wins / ended.length * 100)}%`
      : '还没有已结束的对局';
    $('history-list').innerHTML = historyEntries.map((e, i) => {
      let badge, result;
      if (e.phase === 'lobby') { badge = '<span class="badge">大厅中</span>'; result = '等待开局'; }
      else if (e.phase === 'playing') { badge = '<span class="badge">对局中</span>'; result = '正在进行'; }
      else if (!e.winner) { badge = '<span class="badge">平局</span>'; result = `你 ${e.yourTotal} 分`; }
      else if (e.winner === e.youId) { badge = '<span class="badge win">胜利</span>'; result = `你 ${e.yourTotal} 分 · 第 1 名`; }
      else { badge = '<span class="badge lose">落败</span>'; result = `${esc(e.winnerName)} 获胜 · 你 ${e.yourTotal} 分（第 ${e.yourRank} 名）`; }
      const others = e.players.filter(n => n !== e.youName).map(esc).join('、') || '—';
      return `<li>
        <div>
          <div><span class="h-code">${e.code}</span>${badge}</div>
          <div class="h-sub">${fmtDate(e.endedAt || e.createdAt)} · 与 ${others} 对局 · ${result}</div>
        </div>
        <button class="link" data-hidx="${i}">${e.phase === 'ended' ? '回看' : '进入'}</button>
      </li>`;
    }).join('');
    $('history-list').querySelectorAll('[data-hidx]').forEach(btn => {
      btn.onclick = () => {
        const entry = historyEntries[Number(btn.dataset.hidx)];
        if (!entry) return;
        // 凭该房间的玩家 token 重返：进行中回到对局，已结束回到结算（可回放）
        store.token = entry.token;
        send({ type: 'reconnect', token: entry.token });
      };
    });
  }

  // ---------- 状态变化 → 提示 / 教学 ----------

  function onStateChange(prev, cur) {
    // 观战者只读：不发任何行动引导，只在进入时提示一次
    if (cur.spectating) {
      if (!prev || !prev.spectating) {
        toast(cur.phase === 'playing'
          ? '正在观战：玩家、词链、回合和质疑状态会实时同步'
          : cur.phase === 'ended' ? '对局已结束，可以查看结算与回放' : '正在观战大厅，等待房主开始游戏');
      }
      return;
    }
    if (!prev || prev.phase !== cur.phase) {
      if (cur.phase === 'playing') tip('goal', '【目标】用行动点把新词接到场上，连成你的领地。词链越长得分越高；未加固的连接可能被对手质疑拆除。');
    }
    // 大厅里规则被修改：高亮规则卡片，非房主玩家额外弹提示，确保及时看到
    if (prev && cur.phase === 'lobby' && !WTRules.sameRuleSet(prev.ruleSet, cur.ruleSet)) {
      flashRulesCard();
      if (cur.you !== cur.hostId) toast('房主更新了本局规则');
    }
    if (cur.phase === 'playing' && cur.turn) {
      if (!prev || !prev.turn || prev.turn.turnNumber !== cur.turn.turnNumber) {
        if (cur.turn.playerId === cur.you) {
          tip('yourturn', '【轮到你了】点击场上任意一个词作为连接点，再点「接词」。也可以点「加固」保护自己的关键连接。');
        }
      }
      // 有对手新接了词（起始词等中立词不算）
      if (prev) {
        const newOpp = WTTips.findNewOpponentWords(prev.nodes, cur.nodes, cur.you);
        if (newOpp.length) {
          tip('challenge', `【可以质疑】对手接出了「${newOpp[0].word}」。如果你认为关系不成立，点击词上的「质疑」标记，由裁定者按规则判定。`);
        }
      }
    }
    // 质疑出现
    if (cur.pendingChallenge && (!prev || !prev.pendingChallenge)) {
      const ch = cur.pendingChallenge;
      if (ch.adjudicatorId === cur.you) {
        tip('judge', '【请你裁定】对照本局规则，判断这条连接是否成立。裁定结果立即生效，计时已暂停。');
        openJudge();
      } else {
        const who = playerName(cur, ch.challengerId);
        toast(`${who} 发起了质疑，等待裁定…`);
      }
    }
    if (!cur.pendingChallenge && prev && prev.pendingChallenge) closeDialog('dlg-judge');
    if (cur.phase === 'ended' && (!prev || prev.phase !== 'ended')) {
      tip('score', '【结算】每个词得 1+深度 分，加固 +1，最长链另有奖励。点「回放本局」可以复盘整局。');
    }
  }

  // 教学提示：排队展示，关闭时才记为已读
  const tipQueue = WTTips.createTipQueue({
    isSeen: (key) => store.seenTips.includes(key),
    markSeen: (key) => store.addSeenTip(key),
    show: (text) => { $('tip-text').textContent = text; $('tip-box').classList.remove('hidden'); },
    hide: () => $('tip-box').classList.add('hidden'),
  });
  const tip = (key, text) => tipQueue.push(key, text);
  $('tip-ok').onclick = () => tipQueue.dismiss();

  function toast(text) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    $('toast-wrap').appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  // ---------- 渲染 ----------

  function showScreen(name) {
    for (const s of document.querySelectorAll('.screen')) s.classList.add('hidden');
    $(`screen-${name}`).classList.remove('hidden');
  }

  const isSpectating = () => !!(state && state.spectating);

  function playerName(s, id) {
    if (!id) return '中立';
    const p = s.players.find(p => p.id === id);
    return p ? p.name : '?';
  }
  function playerColor(s, id) {
    const p = s.players.find(p => p.id === id);
    return p ? p.color : '#999';
  }

  function render() {
    if (!state) return;
    if (state.phase === 'lobby') { renderLobby(); showScreen('lobby'); }
    else if (state.phase === 'playing') { renderGame(); showScreen('game'); }
    else if (state.phase === 'ended') { renderEnd(); showScreen('end'); }
  }

  function renderLobby() {
    $('lobby-code').textContent = state.code;
    $('lobby-count').textContent = state.players.length;
    $('lobby-players').innerHTML = state.players.map(p =>
      `<li><span class="dot" style="background:${p.color}"></span>${esc(p.name)}
       ${p.id === state.hostId ? '（房主）' : ''}
       ${p.id === state.you ? '（你）' : ''}
       ${p.connected ? '' : '<span class="offline">离线</span>'}</li>`).join('');
    const specs = state.spectators || [];
    $('lobby-spectators').innerHTML = specs.map(s =>
      `<li class="spectator">👁 ${esc(s.name)}${s.id === state.you ? '（你·观战）' : '（观战）'}
       ${s.connected ? '' : '<span class="offline">离线</span>'}</li>`).join('');
    $('rules-summary').innerHTML = rulesSummary(state.ruleSet);
    const isHost = state.you === state.hostId;
    $('btn-edit-rules').classList.toggle('hidden', !isHost);
    $('btn-start').classList.toggle('hidden', !isHost);
    $('btn-exit-spectate').classList.toggle('hidden', !state.spectating);
    $('lobby-wait').textContent = isHost
      ? (state.players.length < 2 ? '至少需要 2 名玩家才能开始' : '人齐了就点开始吧')
      : (state.spectating ? '你正在观战，对局开始后会自动收到局面' : '等待房主开始…');
  }

  function rulesSummary(r) {
    const names = r.allowedRelations.map(id => {
      const t = state.relationTypes.find(t => t.id === id);
      return t ? t.name : id;
    }).join('、');
    return `<ul>
      <li>允许的关系：${names}</li>
      <li>专有名词：${r.allowProperNouns ? '允许' : '不允许'}</li>
      <li>解释至少 ${r.minReasonLen} 字 · 每回合 ${r.turnSeconds} 秒 · ${r.apPerTurn} 行动点</li>
      <li>每人 ${r.rounds} 回合 · ${r.challengeTokens} 次质疑机会</li>
      <li>计分：词 = 1+深度 分，加固 +1，最长链 ×2 奖励</li>
    </ul>`;
  }

  function renderGame() {
    const t = state.turn;
    const spectator = !!state.spectating;
    const active = !spectator && t && t.playerId === state.you;
    $('turn-info').innerHTML = t
      ? `第 ${t.turnNumber} 回合 · 轮到 <b style="color:${playerColor(state, t.playerId)}">${esc(playerName(state, t.playerId))}</b>${active ? '（你）' : ''}`
      : '';
    $('ap-info').textContent = spectator
      ? '观战中 · 只读'
      : active
        ? `你的行动点：${t.apLeft} / ${state.ruleSet.apPerTurn}`
        : `你的质疑机会：${(state.players.find(p => p.id === state.you) || {}).tokensLeft ?? 0}`;

    $('spectator-banner').classList.toggle('hidden', !spectator);

    $('scoreboard').innerHTML = state.players.map(p => {
      const words = state.nodes.filter(n => n.ownerId === p.id).length;
      return `<span class="score-chip ${t && t.playerId === p.id ? 'active' : ''}">
        <span class="dot" style="background:${p.color}"></span>${esc(p.name)} · ${words} 词
        ${p.connected ? '' : '<span class="offline">离线</span>'}</span>`;
    }).join('') + ((state.spectators || []).length
      ? `<span class="score-chip spec">👁 ${state.spectators.length} 人观战</span>` : '');

    // 待裁定横幅：常显入口，防止弹窗被关掉后整局卡住（观战者不显示裁定入口）
    const ch = state.pendingChallenge;
    if (ch) {
      const iAmJudge = !spectator && ch.adjudicatorId === state.you;
      const node = state.nodes.find(n => n.id === ch.nodeId);
      $('challenge-banner-text').textContent = iAmJudge
        ? `有质疑等待你裁定${node ? `（目标：${node.word}）` : ''}，裁定前对局暂停`
        : spectator
          ? `${playerName(state, ch.challengerId)} 发起了质疑，等待 ${playerName(state, ch.adjudicatorId)} 裁定…`
          : `等待 ${playerName(state, ch.adjudicatorId)} 裁定质疑…`;
      $('btn-goto-judge').classList.toggle('hidden', !iAmJudge);
      $('challenge-banner').classList.remove('hidden');
      // 裁定者每次状态刷新都确保弹窗开着
      if (iAmJudge) openJudge();
    } else {
      $('challenge-banner').classList.add('hidden');
    }

    renderBoard($('board'), state.nodes, {
      selectable: active,
      showChallenge: !active && !spectator && state.phase === 'playing',
    });

    // 观战者：隐藏全部行动按钮，词链不可选
    $('action-row').classList.toggle('hidden', spectator);
    $('btn-play').disabled = !active || !selectedParent || (t && t.apLeft < 1) || !!state.pendingChallenge;
    $('btn-reinforce').disabled = !active || (t && t.apLeft < 1) || !!state.pendingChallenge;
    $('btn-reinforce').textContent = reinforceMode ? '取消加固' : '加固';
    $('btn-endturn').disabled = !active || !!state.pendingChallenge;
    $('btn-replay').classList.add('hidden');

    updateTimer();
  }

  function renderBoard(container, nodes, opts = {}) {
    // 按树形缩进展示
    const children = new Map();
    for (const n of nodes) {
      const key = n.parentId || '';
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(n);
    }
    const html = [];
    const walk = (parentId, depth) => {
      for (const n of children.get(parentId) || []) {
        html.push(nodeHtml(n, depth, opts));
        walk(n.id, depth + 1);
      }
    };
    walk('', 0);
    // 兜底：父节点缺失的孤儿（理论上不会出现）
    for (const n of nodes) {
      if (n.parentId && !nodes.some(p => p.id === n.parentId) && !html.some(h => h.includes(n.id))) {
        html.push(nodeHtml(n, 0, opts));
      }
    }
    container.innerHTML = html.join('');
    container.querySelectorAll('.node').forEach(el => {
      el.onclick = (e) => {
        if (e.target.classList.contains('challengeable')) return;
        onNodeClick(el.dataset.id);
      };
    });
    container.querySelectorAll('.challengeable').forEach(el => {
      el.onclick = () => { challengeNodeId = el.closest('.node').dataset.id; openChallengeConfirm(); };
    });
  }

  function nodeHtml(n, depth, opts) {
    const color = n.ownerId ? playerColor(state, n.ownerId) : '#999';
    const rel = n.relation ? (state.relationTypes.find(r => r.id === n.relation) || {}).name : '';
    const mine = n.ownerId === state.you;
    const canChallenge = opts.showChallenge && n.ownerId && !mine && !n.reinforced &&
      !state.pendingChallenge && (state.players.find(p => p.id === state.you) || {}).tokensLeft > 0;
    const badges = [];
    if (n.reinforced && n.parentId) badges.push('<span class="badge shield">已加固</span>');
    if (n.survivedAsRoot) badges.push('<span class="badge shield">幸存根</span>');
    if (canChallenge) badges.push('<span class="badge challengeable">质疑</span>');
    return `<div class="node ${n.ownerId ? '' : 'start'} ${selectedParent === n.id ? 'selected' : ''}"
      data-id="${n.id}" style="margin-left:${depth * 22}px; border-left-color:${color}">
      <span class="word">${esc(n.word)}</span>
      <div class="meta">${n.ownerId ? `${esc(playerName(state, n.ownerId))} · ${rel || ''} · ${esc(n.reason || '')}` : '起始词'}</div>
      <div class="badges">${badges.join('')}</div>
    </div>`;
  }

  function onNodeClick(nodeId) {
    if (isSpectating()) return;
    const t = state.turn;
    if (!t || t.playerId !== state.you) return;
    const node = state.nodes.find(n => n.id === nodeId);
    if (!node) return;
    if (reinforceMode) {
      if (node.ownerId !== state.you) return toast('只能加固自己的词');
      if (!node.parentId) return toast('起始词无需加固');
      if (node.reinforced) return toast('已经加固过了');
      send({ type: 'reinforce', nodeId });
      reinforceMode = false;
      return;
    }
    selectedParent = selectedParent === nodeId ? null : nodeId;
    render();
  }

  // ---------- 计时 ----------

  function updateTimer() {
    clearInterval(timerInterval);
    const tick = () => {
      if (!state || !state.turn) return;
      const t = state.turn;
      let remain;
      if (t.deadline) remain = Math.max(0, t.deadline - Date.now());
      else if (t.pausedRemaining != null) remain = t.pausedRemaining;
      else return;
      const total = state.ruleSet.turnSeconds * 1000;
      const pct = Math.min(100, remain / total * 100);
      $('timer-bar').style.width = pct + '%';
      $('timer-bar').classList.toggle('low', remain < 15000);
      $('timer-text').textContent = t.deadline ? `${Math.ceil(remain / 1000)}s` : '裁定中…';
    };
    tick();
    timerInterval = setInterval(tick, 500);
  }

  // ---------- 结算 ----------

  function renderEnd() {
    const scores = state.scores || [];
    const meWin = state.winner === state.you;
    $('btn-exit-spectate3').classList.toggle('hidden', !state.spectating);
    $('end-title').textContent = state.spectating
      ? '对局结束（观战中）'
      : state.winner
        ? `🏆 ${playerName(state, state.winner)} 获胜！${meWin ? '（是你）' : ''}` : '平局！';
    $('end-scores').innerHTML = `<table>
      <tr><th>玩家</th><th>词数</th><th>最长链</th><th>总分</th></tr>
      ${scores.map(s => `<tr>
        <td><span class="dot" style="background:${s.color}"></span> ${esc(s.name)}${s.playerId === state.you ? '（你）' : ''}</td>
        <td>${s.words}</td><td>${s.longestChain}</td><td><b>${s.total}</b></td>
      </tr>`).join('')}</table>`;
  }

  // ---------- 弹窗 ----------

  function openDialog(id) { $(id).showModal(); }
  function closeDialog(id) { const d = $(id); if (d.open) d.close(); }
  document.querySelectorAll('[data-close]').forEach(b =>
    b.onclick = () => b.closest('dialog').close());

  $('btn-play').onclick = () => {
    const parent = state.nodes.find(n => n.id === selectedParent);
    if (!parent) return toast('先点击选择一个要连接的词');
    $('play-parent').textContent = parent.word;
    $('play-word').value = '';
    $('play-reason').value = '';
    $('play-relation').innerHTML = state.ruleSet.allowedRelations.map(id => {
      const t = state.relationTypes.find(t => t.id === id);
      return `<option value="${id}">${t.name}（${t.example}）</option>`;
    }).join('');
    $('play-minlen').textContent = `解释至少 ${state.ruleSet.minReasonLen} 字` +
      (state.ruleSet.allowProperNouns ? '；允许专有名词' : '；不允许专有名词');
    openDialog('dlg-play');
  };

  $('play-submit').onclick = () => {
    send({ type: 'play', word: $('play-word').value, parentId: selectedParent,
      relation: $('play-relation').value, reason: $('play-reason').value });
    closeDialog('dlg-play');
    selectedParent = null;
  };

  $('btn-reinforce').onclick = () => {
    reinforceMode = !reinforceMode;
    if (reinforceMode) toast('点击你的一条未加固连接进行加固');
    render();
  };

  $('btn-endturn').onclick = () => send({ type: 'endTurn' });

  function openChallengeConfirm() {
    const n = state.nodes.find(x => x.id === challengeNodeId);
    if (!n) return;
    $('challenge-target').innerHTML =
      `目标：<b>${esc(n.word)}</b>（${esc(playerName(state, n.ownerId))}：${esc(n.reason)}）`;
    openDialog('dlg-challenge');
  }
  $('challenge-submit').onclick = () => {
    send({ type: 'challenge', nodeId: challengeNodeId });
    closeDialog('dlg-challenge');
  };

  function openJudge() {
    const ch = state && state.pendingChallenge;
    if (!ch) return;
    const node = state.nodes.find(n => n.id === ch.nodeId);
    if (!node) return;
    const rel = (state.relationTypes.find(r => r.id === node.relation) || {}).name || '';
    const parent = state.nodes.find(n => n.id === node.parentId);
    $('judge-detail').innerHTML =
      `<p><b>${esc(playerName(state, ch.challengerId))}</b> 质疑了
       <b>${esc(playerName(state, node.ownerId))}</b> 的连接：</p>
       <p style="margin:8px 0">「${parent ? esc(parent.word) : '?'}」—<b>${rel}</b>→「${esc(node.word)}」</p>
       <p>解释：${esc(node.reason)}</p>`;
    $('judge-rules').innerHTML = rulesSummary(state.ruleSet);
    if (!$('dlg-judge').open) openDialog('dlg-judge');
  }
  // 裁定未作出前不允许关闭弹窗（Esc / 取消），避免整局卡死
  $('dlg-judge').addEventListener('cancel', (e) => e.preventDefault());
  $('btn-goto-judge').onclick = () => openJudge();
  $('judge-uphold').onclick = () => { send({ type: 'resolve', verdict: 'uphold' }); closeDialog('dlg-judge'); };
  $('judge-reject').onclick = () => { send({ type: 'resolve', verdict: 'reject' }); closeDialog('dlg-judge'); };

  $('btn-rules-view').onclick = () => {
    $('rules-view').innerHTML = rulesSummary(state.ruleSet);
    openDialog('dlg-rules');
  };

  // ---------- 回放 ----------

  function openReplay() {
    renderReplayFrame();
    openDialog('dlg-replay');
  }
  function renderReplayFrame() {
    const f = replayFrames[replayIdx];
    $('replay-label').textContent = f.label;
    $('replay-pos').textContent = `${replayIdx + 1} / ${replayFrames.length}`;
    renderBoard($('replay-board'), f.nodes, {});
  }
  $('replay-prev').onclick = () => { if (replayIdx > 0) { replayIdx--; renderReplayFrame(); } };
  $('replay-next').onclick = () => { if (replayIdx < replayFrames.length - 1) { replayIdx++; renderReplayFrame(); } };
  $('btn-replay').onclick = () => send({ type: 'replay' });
  $('btn-replay2').onclick = () => send({ type: 'replay' });

  // ---------- 首页 / 大厅事件 ----------

  $('inp-name').value = store.name;
  $('btn-create').onclick = () => {
    const name = $('inp-name').value.trim() || '玩家';
    store.name = name;
    send({ type: 'createRoom', name });
  };
  $('btn-join').onclick = () => {
    const name = $('inp-name').value.trim() || '玩家';
    const code = $('inp-code').value.trim().toUpperCase();
    if (code.length !== 4) return ($('home-error').textContent = '请输入 4 位房间码');
    store.name = name;
    send({ type: 'joinRoom', name, roomCode: code });
  };
  $('btn-spectate').onclick = () => {
    const code = $('inp-code').value.trim().toUpperCase();
    if (code.length !== 4) return ($('home-error').textContent = '请输入 4 位房间码');
    // 观战身份是临时的、只读的；昵称可选，不写入本地
    send({ type: 'spectate', name: $('inp-name').value.trim() || '观战者', roomCode: code });
  };
  // 退出观战：丢弃临时观战 token，回到首页（不影响房间内对局）
  const exitSpectate = () => { store.token = null; location.reload(); };
  $('btn-exit-spectate').onclick = exitSpectate;
  $('btn-exit-spectate2').onclick = exitSpectate;
  $('btn-exit-spectate3').onclick = exitSpectate;

  // ---------- 规则编辑器 ----------
  // 打开时完整回填当前规则；保存前就地校验；等服务器确认（rulesSaved）后再关闭，
  // 失败时编辑器保持打开、错误就地显示，已填内容不丢失。

  function flashRulesCard() {
    const card = $('rules-card');
    card.classList.remove('flash');
    void card.offsetWidth; // 重新触发动画
    card.classList.add('flash');
  }

  function clearRuleErrors() {
    document.querySelectorAll('#rules-editor .field-error').forEach(el => { el.textContent = ''; });
    document.querySelectorAll('#rules-editor input').forEach(el => el.classList.remove('invalid'));
  }

  function showRuleError(errId, inputId, msg) {
    $(errId).textContent = msg;
    if (inputId) $(inputId).classList.add('invalid');
  }

  // 用当前生效的规则完整回填编辑器，并清掉上次遗留的错误提示
  function fillRulesEditor() {
    const r = state.ruleSet;
    $('rules-relations').innerHTML = state.relationTypes.map(t =>
      `<label><input type="checkbox" data-rel="${t.id}" ${r.allowedRelations.includes(t.id) ? 'checked' : ''}>
       ${t.name}（${t.example}）</label>`).join('');
    $('rule-proper').checked = r.allowProperNouns;
    for (const f of WTRules.NUMBER_FIELDS) $(f.id).value = r[f.key];
    clearRuleErrors();
  }

  // 收集输入并校验；通过则返回可提交的 ruleSet，否则就地标出错误并返回 null
  function validateRulesEditor() {
    clearRuleErrors();
    const input = {
      allowedRelations: [...document.querySelectorAll('[data-rel]:checked')].map(x => x.dataset.rel),
    };
    for (const f of WTRules.NUMBER_FIELDS) input[f.key] = $(f.id).value;
    const { errors, ruleSet } = WTRules.validateRuleSet(input);
    for (const [key, msg] of Object.entries(errors)) {
      if (key === 'allowedRelations') showRuleError('err-rule-relations', null, msg);
      else {
        const f = WTRules.NUMBER_FIELDS.find(x => x.key === key);
        showRuleError(`err-${f.id}`, f.id, msg);
      }
    }
    if (Object.keys(errors).length > 0) return null;
    ruleSet.allowProperNouns = $('rule-proper').checked;
    return ruleSet;
  }

  // 提交锁定只能由两种确定结果解除：服务器答复（rulesSaved / 带 setRules 上下文的 error），
  // 或连接断开（onclose，此次请求不会再有答复）。不能用定时器自动解除——
  // 网络延迟超过定时时长而服务器尚未确认时，锁会被误解除，导致重复提交。
  function setRulesSavePending(pending) {
    $('btn-save-rules').disabled = pending;
  }

  function onRulesSaved() {
    setRulesSavePending(false);
    $('rules-editor').classList.add('hidden');
    toast('规则已保存');
  }

  function onRulesSaveError(message) {
    setRulesSavePending(false);
    if ($('rules-editor').classList.contains('hidden')) $('rules-editor').classList.remove('hidden');
    showRuleError('err-rules-general', null, message);
  }

  $('btn-edit-rules').onclick = () => {
    const editor = $('rules-editor');
    if (editor.classList.contains('hidden')) {
      fillRulesEditor();
      editor.classList.remove('hidden');
    } else {
      editor.classList.add('hidden');
    }
  };
  $('btn-cancel-rules').onclick = () => $('rules-editor').classList.add('hidden');
  $('btn-save-rules').onclick = () => {
    if ($('btn-save-rules').disabled) return;
    const ruleSet = validateRulesEditor();
    if (!ruleSet) return; // 校验未通过：错误已就地标出，不发送
    setRulesSavePending(true);
    send({ type: 'setRules', ruleSet });
  };
  $('btn-start').onclick = () => send({ type: 'startGame' });
  $('btn-home').onclick = () => { store.token = null; location.reload(); };

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  connect();
})();
