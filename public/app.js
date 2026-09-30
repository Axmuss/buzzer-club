'use strict';
const SHAPES = [
  '<path d="M10 2.5 18.5 17.5h-17z"/>',
  '<path d="M10 1.5 18.5 10 10 18.5 1.5 10z"/>',
  '<circle cx="10" cy="10" r="7"/>',
  '<rect x="2.5" y="2.5" width="15" height="15" rx="2"/>',
];
const badge = j => `<span class="badge" aria-hidden="true"><svg viewBox="0 0 20 20">${SHAPES[j]}</svg></span>`;
const picks = n => `<span class="picks">${n} ${n === 1 ? 'pick' : 'picks'}</span>`;
const TIMES = [10, 15, 20, 30, 45];
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

function playerId() {
  let p = lsGet('bc-pid');
  if (!p || !/^[A-Za-z0-9_-]{8,64}$/.test(p)) {
    p = 'p' + (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2) + Date.now().toString(36));
    lsSet('bc-pid', p);
  }
  return p;
}

const S = {
  route: 'home', joinCode: '',
  nick: lsGet('bc-nick') || '',
  st: null, offset: 0, pending: null, timeUpKey: null,
  quizzes: null, quizErr: '',
  busy: false,
  token: lsGet('bc-admin') || '',
  admin: { quizzes: null, draft: null, confirmDel: null, err: '', importText: '', importErr: '', loginErr: '' },
};

/* ---------- connection ---------- */
const socket = io({ auth: { playerId: playerId() } });
function call(event, data) {
  return new Promise(resolve => {
    socket.timeout(8000).emit(event, data || {}, (err, r) => {
      resolve(err ? { error: "The game server didn't answer. Check your connection and try again." } : (r || {}));
    });
  });
}
socket.on('connect', () => {
  $('#conn').hidden = true;
  if (S.st) resume(S.st.code);
});
socket.on('disconnect', () => { $('#conn').hidden = false; });
socket.on('state', st => {
  const prevKey = S.st ? S.st.code + ':' + S.st.index : null;
  S.st = st;
  S.offset = st.serverNow - Date.now();
  if (prevKey !== st.code + ':' + st.index || st.you?.answer != null) S.pending = null;
  lsSet('bc-room', st.code);
  if (S.route !== 'builder') {
    S.route = 'room';
    S.joinCode = st.code;
    if (location.pathname !== '/join/' + st.code) history.replaceState(null, '', '/join/' + st.code);
  }
  if (st.status === 'final' && st.you?.isHost && !S.quizzes) loadQuizzes();
  render();
});
socket.on('closed', msg => {
  S.st = null; lsSet('bc-room', '');
  go('/');
  notice(msg || 'The host closed the game.');
});

async function resume(code) {
  const r = await call('room:resume', { code });
  if (r.error) {
    if (S.st && S.st.code === code) S.st = null;
    lsSet('bc-room', '');
    render();
  }
}

/* ---------- routing ---------- */
function go(path) { history.pushState(null, '', path); route(); }
function route() {
  notice('');
  const p = location.pathname;
  const m = p.match(/^\/join\/([A-Za-z0-9]{4})\/?$/);
  if (p.startsWith('/builder')) { S.route = 'builder'; loadAdmin(); }
  else if (m) {
    S.joinCode = m[1].toUpperCase();
    if (S.st && S.st.code === S.joinCode) S.route = 'room';
    else {
      S.route = 'join';
      if (lsGet('bc-room') === S.joinCode) resume(S.joinCode);
    }
  } else {
    S.route = S.st ? 'room' : 'home';
    if (S.st) history.replaceState(null, '', '/join/' + S.st.code);
    else loadQuizzes();
  }
  render();
}
window.addEventListener('popstate', route);

/* ---------- helpers ---------- */
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2200); }
function notice(msg) { const n = $('#notice'); n.textContent = msg; n.hidden = !msg; }
function needNick() {
  const n = (S.nick || '').replace(/\s+/g, ' ').trim();
  if (!n) { notice('Type your name first so the table knows who you are.'); const i = $('#nick'); if (i) i.focus(); return null; }
  notice(''); return n.slice(0, 20);
}
const serverNow = () => Date.now() + S.offset;
function timeLeftMs() { const st = S.st; return st && st.status === 'question' ? st.endsAt - serverNow() : 0; }
const inviteUrl = code => location.origin + '/join/' + code;

async function loadQuizzes() {
  try {
    const r = await fetch('/api/quizzes');
    if (!r.ok) throw new Error();
    S.quizzes = await r.json(); S.quizErr = '';
  } catch { S.quizErr = "Couldn't load the quizzes. Refresh the page to try again."; }
  render();
}

/* ---------- actions ---------- */
async function host(quizId) {
  const nick = needNick(); if (!nick || S.busy) return;
  S.busy = true; render();
  const r = await call('room:create', { quizId, nick });
  S.busy = false;
  if (r.error) notice(r.error);
  render();
}
async function join(code) {
  const nick = needNick(); if (!nick || S.busy) return;
  code = (code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(code)) { notice('Game codes have 4 letters or numbers.'); return; }
  S.busy = true; render();
  const r = await call('room:join', { code, nick });
  S.busy = false;
  if (r.error) notice(r.error);
  render();
}
async function act(event, data) {
  const r = await call(event, data);
  if (r.error) notice(r.error);
  return r;
}
async function answer(c) {
  const st = S.st;
  if (!st || st.status !== 'question' || st.you?.answer != null || S.pending || timeLeftMs() <= 0) return;
  S.pending = { key: st.code + ':' + st.index, c };
  render();
  const r = await call('game:answer', { c });
  if (r.error) { S.pending = null; notice(r.error); render(); }
}
async function leave() {
  await call('room:leave');
  S.st = null; lsSet('bc-room', '');
  go('/');
}
async function copyLink(btn) {
  const url = inviteUrl(S.st.code);
  try {
    await navigator.clipboard.writeText(url);
    btn.textContent = 'Copied'; toast('Link copied');
  } catch {
    const i = $('#share-link'); i.focus(); i.select();
    toast('Press Ctrl+C (or ⌘C) to copy');
  }
  setTimeout(() => { if (btn.isConnected) btn.textContent = 'Copy link'; }, 2000);
}

/* ---------- rendering ---------- */
function preserve(fn) {
  const a = document.activeElement;
  const id = a && a.id;
  let ss = null, se = null; try { ss = a.selectionStart; se = a.selectionEnd; } catch {}
  fn();
  if (id) { const n = document.getElementById(id); if (n && n !== document.activeElement) { n.focus(); try { if (ss != null) n.setSelectionRange(ss, se); } catch {} } }
}
function render() { preserve(() => { $('#app').innerHTML = view(); }); tick(); }
function view() {
  if (S.route === 'builder') return builderView();
  if (S.route === 'room' && S.st) return roomView(S.st);
  if (S.route === 'join') return joinView();
  return homeView();
}

function nickField(btn) {
  return `<div class="nick-row">
    <label class="field" for="nick"><span class="lbl">Your name at the table</span>
      <input id="nick" maxlength="20" autocomplete="nickname" placeholder="e.g. Maks" value="${esc(S.nick)}"></label>
    ${btn || ''}
  </div>`;
}

function homeView() {
  let cards;
  if (S.quizErr) cards = `<div class="empty">${esc(S.quizErr)}</div>`;
  else if (!S.quizzes) cards = `<div class="empty">Loading quizzes…</div>`;
  else if (!S.quizzes.length) cards = `<div class="empty"><strong>No quizzes yet.</strong><span>The quiz owner adds them in the Quiz builder.</span></div>`;
  else cards = `<div class="quiz-grid">${S.quizzes.map(q => `<article class="qcard">
      <h3>${esc(q.title)}</h3>
      <p>${esc(q.blurb)}</p>
      <div class="meta mono">${q.count} question${q.count === 1 ? '' : 's'} · about ${Math.max(1, Math.round(q.secs / 60))} min</div>
      <button class="btn primary" data-act="host" data-id="${esc(q.id)}" ${S.busy ? 'disabled' : ''}>Host this quiz</button>
    </article>`).join('')}</div>`;
  return `<div class="stack">
    <section class="stage">
      <p class="eyebrow">Live quiz for friends</p>
      <h1>Gather the table.</h1>
      <p class="sub">Host a quiz and send your friends the invite link, or type the code a friend sent you.</p>
      ${nickField()}
    </section>
    <div class="split">
      <section class="card">
        <h2>Join a game</h2>
        <div class="nick-row">
          <label class="field" for="join-code"><span class="lbl">Game code</span>
            <input id="join-code" class="code-input" maxlength="4" autocomplete="off" placeholder="K7X2" value="${esc(S.joinCode)}"></label>
          <button class="btn hot" data-act="join-code" ${S.busy ? 'disabled' : ''}>Join</button>
        </div>
      </section>
      <section class="card">
        <h2>Host a game</h2>
        <p class="sub">Pick a quiz below. You get a link to share, and you can play along too.</p>
      </section>
    </div>
    <div class="sec-head"><h2>Quizzes</h2></div>
    ${cards}
  </div>`;
}

function joinView() {
  return `<section class="stage">
    <p class="eyebrow">You're invited</p>
    <h1>Join game <span class="mono">${esc(S.joinCode)}</span></h1>
    <p class="sub">Type your name and hop into the lobby.</p>
    ${nickField(`<button class="btn hot" data-act="join" ${S.busy ? 'disabled' : ''}>Join the game</button>`)}
    <p class="hostline"><a href="/" data-link>Go to the home page instead</a></p>
  </section>`;
}

function roomView(st) {
  if (st.status === 'lobby') return lobbyView(st);
  if (st.status === 'question') return questionView(st);
  if (st.status === 'reveal') return revealView(st);
  if (st.status === 'final') return finalView(st);
  return '';
}

function roster(st) {
  return `<ul class="roster">${st.players.map(p => `<li class="${p.pubId === st.you?.pubId ? 'me' : ''} ${p.connected ? '' : 'away'}">${esc(p.nick)}${p.isHost ? '<span class="tag">host</span>' : ''}</li>`).join('')}</ul>`;
}
function hostName(st) { const h = st.players.find(p => p.isHost); return h ? h.nick : 'the host'; }
function guestLine(st) {
  if (st.you?.isHost) return '';
  const take = st.hostConnected ? '' : ` ${esc(hostName(st))} has lost connection. <button class="link" data-act="takeover">Take over hosting</button>`;
  return `<p class="hostline">Hosted by ${esc(hostName(st))}.${take} <button class="link" data-act="leave">Leave game</button></p>`;
}

function lobbyView(st) {
  const n = st.players.length;
  const isHost = st.you?.isHost;
  const share = isHost ? `<div class="share">
      <span class="lbl">Invite players with this link</span>
      <div class="share-row">
        <input id="share-link" readonly value="${esc(inviteUrl(st.code))}" aria-label="Invite link">
        <button class="btn" data-act="copy-link">Copy link</button>
      </div>
      <p class="hint">Anyone with the link can join this game. Friends can also type the code on the home page.</p>
    </div>` : '';
  return `<section class="stage">
    <p class="eyebrow">Lobby · ${esc(st.quizTitle)} · ${st.total} questions</p>
    <div class="row" style="justify-content:space-between">
      <h1>${n} ${n === 1 ? 'player' : 'players'} at the table</h1>
      <div><span class="lbl">Game code</span><div class="roomcode">${esc(st.code)}</div></div>
    </div>
    ${roster(st)}
    ${share}
    ${isHost
      ? `<div class="row"><button class="btn primary big" data-act="start">Start the quiz</button><button class="btn ghost" data-act="close">Close game</button></div>`
      : `<p class="sub">You're in. Waiting for ${esc(hostName(st))} to start.</p>${guestLine(st)}`}
  </section>`;
}

function questionView(st) {
  const q = st.question;
  const key = st.code + ':' + st.index;
  const mine = st.you?.answer ?? (S.pending && S.pending.key === key ? S.pending.c : null);
  const over = timeLeftMs() <= 0;
  const tiles = q.o.map((o, j) => {
    const picked = mine === j;
    const off = mine != null ? !picked : over;
    return `<button class="tile t${j} ${off ? 'off' : ''}" data-act="answer" data-c="${j}" ${mine != null || over ? 'disabled' : ''}>
      ${badge(j)}<span class="txt">${esc(o)}</span>
      ${picked ? '<span class="side"><span class="chip">Your answer</span></span>' : ''}</button>`;
  }).join('');
  const counts = `${st.answeredCount} of ${st.activeCount} answered.`;
  const status = mine != null ? `Locked in. ${counts}` : over ? `Time's up.` : counts;
  return `<section class="stage">
    <div class="qtop"><span class="eyebrow">Question ${st.index + 1} of ${st.total}</span><span id="tnum" class="timer mono" aria-label="Seconds left">${Math.max(0, Math.ceil(timeLeftMs() / 1000))}</span></div>
    <div class="bar" aria-hidden="true"><i id="tbar"></i></div>
    <h1 class="qtext">${esc(q.q)}</h1>
    <div class="tiles">${tiles}</div>
    <p class="status">${status}</p>
    ${guestLine(st)}
  </section>`;
}

function boardView(st, showDelta) {
  return `<ol class="board">${st.players.map((r, i) => `<li class="${r.pubId === st.you?.pubId ? 'me' : ''}">
    <span class="rank">${i + 1}</span><span class="nick">${esc(r.nick)}</span>
    <span class="delta ${r.last ? '' : 'zero'}">${showDelta ? '+' + r.last : ''}</span>
    <span class="total">${r.total}</span></li>`).join('')}</ol>`;
}

function revealView(st) {
  const q = st.question;
  const mine = st.you?.answer;
  const tiles = q.o.map((o, j) => {
    const right = j === st.correct, isMine = mine === j;
    const cls = right ? 'win' : isMine ? 'off mine-wrong' : 'off';
    const chip = right ? `<span class="chip good">✓ Correct</span>` : isMine ? `<span class="chip bad">Your answer</span>` : '';
    return `<div class="tile t${j} ${cls}">
      ${badge(j)}<span class="txt">${esc(o)}</span>
      <span class="side">${chip}${picks(st.counts[j])}</span></div>`;
  }).join('');
  const answerText = esc(q.o[st.correct]);
  const res = mine == null ? `<div class="result bad"><strong>No answer</strong><span>The answer was ${answerText}.</span></div>`
    : st.you.points ? `<div class="result good"><strong>Correct</strong><span>+${st.you.points} points</span></div>`
    : `<div class="result bad"><strong>Not this time</strong><span>The answer was ${answerText}.</span></div>`;
  const last = st.index + 1 >= st.total;
  return `<section class="stage">
    <p class="eyebrow">Question ${st.index + 1} of ${st.total} · the answer</p>
    <h1 class="qtext">${esc(q.q)}</h1>
    <div class="tiles">${tiles}</div>
    ${res}
    <h2>Leaderboard</h2>
    ${boardView(st, true)}
    ${st.you?.isHost
      ? `<div class="row"><button class="btn primary big" data-act="next">${last ? 'Show final results' : 'Next question'}</button></div>`
      : guestLine(st)}
  </section>`;
}

function finalView(st) {
  const rows = st.players;
  const top = rows.slice(0, 3);
  const pod = (r, place) => r ? `<div class="pod p${place}"><span class="who">${esc(r.nick)}</span><span class="pts">${r.total} pts</span><div class="block">${place}</div></div>` : `<div class="pod p${place}"></div>`;
  const headline = !rows.length ? 'Game over' : (rows.length > 1 && rows[0].total === rows[1].total ? "It's a tie at the top" : `${esc(rows[0].nick)} takes it`);
  const others = (S.quizzes || []).filter(q => q.id !== st.quizId);
  const hostControls = `<div class="row">
      <button class="btn primary big" data-act="rematch">Play again</button>
      <button class="btn ghost" data-act="close">Close game</button>
    </div>
    ${others.length ? `<div class="nick-row">
      <label class="field" for="next-quiz"><span class="lbl">Or play a different quiz with the same group</span>
        <select id="next-quiz">${others.map(q => `<option value="${esc(q.id)}">${esc(q.title)} (${q.count})</option>`).join('')}</select></label>
      <button class="btn" data-act="switch-quiz">Load this quiz</button>
    </div>` : ''}`;
  return `<section class="stage">
    <p class="eyebrow">Final results · ${esc(st.quizTitle)}</p>
    <h1>${headline}</h1>
    ${rows.length ? `<div class="podium">${pod(top[1], 2)}${pod(top[0], 1)}${pod(top[2], 3)}</div>` : ''}
    ${boardView(st, false)}
    ${st.you?.isHost ? hostControls : `<p class="sub">Waiting for ${esc(hostName(st))} to pick what's next.</p>${guestLine(st)}`}
  </section>`;
}

function tick() {
  const st = S.st;
  if (S.route !== 'room' || !st || st.status !== 'question') return;
  const left = timeLeftMs();
  const lim = st.question.t * 1000;
  const n = $('#tnum'), b = $('#tbar');
  if (n) { const s = Math.max(0, Math.ceil(left / 1000)); n.textContent = s; n.classList.toggle('low', s <= 5); }
  if (b) b.style.transform = `scaleX(${Math.max(0, Math.min(1, left / lim))})`;
  const key = st.code + ':' + st.index;
  if (left <= 0 && S.timeUpKey !== key) { S.timeUpKey = key; render(); }
}
setInterval(tick, 200);

/* ---------- builder ---------- */
async function api(method, url, body) {
  const r = await fetch(url, {
    method, headers: { 'content-type': 'application/json', 'x-admin-token': S.token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { S.token = ''; lsSet('bc-admin', ''); throw { auth: true, message: j.error }; }
  if (!r.ok) throw { message: j.error || 'Something went wrong. Try again.' };
  return j;
}
async function loadAdmin() {
  if (!S.token) return;
  try { S.admin.quizzes = await api('GET', '/api/admin/quizzes'); S.admin.err = ''; }
  catch (e) { S.admin.err = e.auth ? '' : e.message; }
  if (S.route === 'builder' && !S.admin.draft) render();
}
async function login() {
  const pw = ($('#admin-pw') || {}).value || '';
  if (!pw) { S.admin.loginErr = 'Type the builder password.'; render(); return; }
  try {
    const r = await fetch('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pw }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Could not log in.');
    S.token = j.token; lsSet('bc-admin', j.token); S.admin.loginErr = '';
    await loadAdmin();
  } catch (e) { S.admin.loginErr = e.message; }
  render();
}

function builderView() {
  if (!S.token) return `<section class="stage login">
      <p class="eyebrow">Quiz builder</p>
      <h1>Owner only</h1>
      <p class="sub">Type the builder password to add and edit quizzes.</p>
      <label class="field" for="admin-pw"><span class="lbl">Password</span><input id="admin-pw" type="password" autocomplete="current-password"></label>
      <div class="row"><button class="btn primary" data-act="login">Log in</button><a href="/" data-link class="hostline">Back to the game</a></div>
      <p class="err">${esc(S.admin.loginErr)}</p>
    </section>`;
  return S.admin.draft ? editorView() : adminListView();
}

function adminListView() {
  const A = S.admin;
  const rows = A.err ? `<div class="empty">${esc(A.err)}</div>`
    : !A.quizzes ? `<div class="empty">Loading quizzes…</div>`
    : !A.quizzes.length ? `<div class="empty"><strong>No quizzes yet.</strong><span>Start one and add as many questions as you like.</span></div>`
    : A.quizzes.map(q => {
      const n = q.questions.length;
      const confirm = A.confirmDel === q.id;
      return `<div class="qrow">
        <div><h3>${esc(q.title)}</h3><div class="meta">${n} question${n === 1 ? '' : 's'}${q.blurb ? ' · ' + esc(q.blurb) : ''}</div></div>
        <div class="row">${confirm
          ? `<span class="hint">Delete this quiz?</span><button class="btn small danger solid" data-act="del-yes" data-id="${esc(q.id)}">Delete</button><button class="btn small" data-act="del-no">Keep</button>`
          : `<button class="btn small" data-act="edit" data-id="${esc(q.id)}">Edit</button>
             <button class="btn small" data-act="dup" data-id="${esc(q.id)}">Duplicate</button>
             <button class="btn small danger" data-act="del" data-id="${esc(q.id)}">Delete</button>`}</div>
      </div>`;
    }).join('');
  return `<div class="stack">
    <div class="sec-head"><div><h1>Quiz builder</h1><p class="sub">Quizzes saved here appear on the home page for anyone to host.</p></div>
      <div class="row"><button class="btn primary" data-act="new-quiz">New quiz</button><button class="btn ghost small" data-act="logout">Log out</button></div></div>
    <div class="quiz-list">${rows}</div>
  </div>`;
}

function blankQ() { return { q: '', o: ['', '', '', ''], c: 0, t: 20 }; }

function editorView() {
  const d = S.admin.draft;
  const qs = d.questions.map((q, i) => `<li class="qed">
      <div class="qed-head">
        <span class="num">Q${i + 1}</span>
        <label class="hint" for="q${i}-t">Time</label>
        <select id="q${i}-t" data-f="t" data-i="${i}">${TIMES.map(t => `<option value="${t}" ${q.t === t ? 'selected' : ''}>${t}s</option>`).join('')}</select>
        <button class="btn small" data-act="up" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
        <button class="btn small" data-act="down" data-i="${i}" ${i === d.questions.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
        <button class="btn small danger" data-act="rm-q" data-i="${i}">Remove</button>
      </div>
      <textarea id="q${i}-q" data-f="q" data-i="${i}" rows="2" maxlength="300" placeholder="Type the question">${esc(q.q)}</textarea>
      <div class="opts">${q.o.map((o, j) => `<div class="opt t${j}">
        <input type="radio" name="c${i}" id="q${i}-c${j}" data-f="c" data-i="${i}" data-j="${j}" ${q.c === j ? 'checked' : ''} aria-label="Answer ${j + 1} is correct">
        ${badge(j)}
        <input id="q${i}-o${j}" data-f="o" data-i="${i}" data-j="${j}" value="${esc(o)}" placeholder="Answer ${j + 1}" maxlength="120">
      </div>`).join('')}</div>
    </li>`).join('');
  return `<div class="stack">
    <div class="ed-head"><button class="link" data-act="cancel-edit">← All quizzes</button>
      <div class="row"><button class="btn ghost" data-act="cancel-edit">Discard changes</button><button class="btn primary" data-act="save-quiz">Save quiz</button></div></div>
    <div class="ed-grid">
      <label class="field" for="d-title"><span class="lbl">Quiz title</span><input id="d-title" data-f="title" maxlength="60" value="${esc(d.title)}" placeholder="e.g. Friday Night Trivia"></label>
      <label class="field" for="d-blurb"><span class="lbl">Short description</span><input id="d-blurb" data-f="blurb" maxlength="120" value="${esc(d.blurb)}" placeholder="What is it about?"></label>
    </div>
    <details class="import">
      <summary>Paste questions from Claude</summary>
      <p class="hint">Ask Claude for quiz questions "as Buzzer Club JSON", paste the reply here, and they are added to the end of this quiz.</p>
      <textarea id="import-text" data-f="import" rows="5" placeholder='{"questions":[{"q":"Question?","o":["A","B","C","D"],"c":0}]}'>${esc(S.admin.importText)}</textarea>
      <div class="row"><button class="btn" data-act="import">Add these questions</button><span class="err">${esc(S.admin.importErr)}</span></div>
    </details>
    <p class="hint">Tick the circle next to the correct answer. Every question needs four answers.</p>
    <ol class="qlist">${qs}</ol>
    <button class="btn wide" data-act="add-q">Add a question</button>
    <p id="ed-err" class="err" role="alert"></p>
  </div>`;
}

function openEditor(q, copy) {
  S.admin.draft = q ? {
    id: copy ? rid('quiz-') : q.id,
    title: copy ? q.title + ' (copy)' : q.title,
    blurb: q.blurb || '',
    questions: q.questions.map(x => ({ q: x.q, o: x.o.slice(), c: x.c, t: x.t })),
  } : { id: rid('quiz-'), title: '', blurb: '', questions: [blankQ()] };
  S.admin.importText = ''; S.admin.importErr = '';
  render(); window.scrollTo(0, 0);
}

async function saveQuiz() {
  const d = S.admin.draft, err = $('#ed-err');
  const questions = d.questions
    .map(q => ({ q: q.q.trim(), o: q.o.map(o => o.trim()), c: q.c, t: q.t }))
    .filter(q => q.q || q.o.some(Boolean));
  if (!d.title.trim()) { err.textContent = 'Give the quiz a title.'; $('#d-title').focus(); return; }
  const bad = questions.findIndex(q => !q.q || q.o.some(o => !o));
  if (!questions.length) { err.textContent = 'Add at least one question.'; return; }
  if (bad >= 0) { err.textContent = `Question ${bad + 1} needs its text and all four answers.`; return; }
  try {
    await api('PUT', '/api/admin/quizzes/' + encodeURIComponent(d.id), { title: d.title, blurb: d.blurb, questions });
    S.admin.draft = null; S.quizzes = null;
    toast('Quiz saved');
    await loadAdmin(); render();
  } catch (e) {
    if (e.auth) { render(); notice('Your builder login expired. Log in again, then save. Your edits are kept.'); }
    else err.textContent = e.message;
  }
}

function importQuestions() {
  const A = S.admin;
  try {
    const text = A.importText.trim();
    const start = text.indexOf('{'), startArr = text.indexOf('[');
    const from = start < 0 ? startArr : startArr < 0 ? start : Math.min(start, startArr);
    const parsed = JSON.parse(text.slice(from, Math.max(text.lastIndexOf('}'), text.lastIndexOf(']')) + 1));
    const list = (Array.isArray(parsed) ? parsed : parsed.questions || [])
      .filter(x => x && typeof x.q === 'string' && Array.isArray(x.o) && x.o.length === 4 && Number.isInteger(x.c) && x.c >= 0 && x.c < 4)
      .map(x => ({ q: x.q, o: x.o.map(String), c: x.c, t: TIMES.includes(x.t) ? x.t : 20 }));
    if (!list.length) throw new Error();
    A.draft.questions = A.draft.questions.filter(q => q.q.trim() || q.o.some(o => o.trim())).concat(list);
    A.importText = ''; A.importErr = '';
    toast(`Added ${list.length} question${list.length === 1 ? '' : 's'}`);
  } catch {
    A.importErr = "That text isn't in the expected format. Paste the whole JSON reply from Claude.";
  }
  render();
}

/* ---------- events ---------- */
document.addEventListener('click', e => {
  const link = e.target.closest('a[data-link]');
  if (link && !e.ctrlKey && !e.metaKey && !e.shiftKey) { e.preventDefault(); go(link.getAttribute('href')); return; }
  const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
  const a = b.dataset.act, id = b.dataset.id, i = +b.dataset.i;
  const d = S.admin.draft;
  switch (a) {
    case 'host': host(id); break;
    case 'join': join(S.joinCode); break;
    case 'join-code': join(($('#join-code') || {}).value); break;
    case 'copy-link': copyLink(b); break;
    case 'start': act('game:start'); break;
    case 'answer': answer(+b.dataset.c); break;
    case 'next': act('game:next'); break;
    case 'rematch': act('game:rematch'); break;
    case 'switch-quiz': act('game:quiz', { quizId: $('#next-quiz').value }); break;
    case 'close': act('room:close'); break;
    case 'takeover': act('room:takeover').then(r => { if (!r.error) toast("You're the host now"); }); break;
    case 'leave': leave(); break;
    case 'login': login(); break;
    case 'logout': S.token = ''; lsSet('bc-admin', ''); S.admin.quizzes = null; render(); break;
    case 'new-quiz': openEditor(null); break;
    case 'edit': openEditor(S.admin.quizzes.find(q => q.id === id), false); break;
    case 'dup': openEditor(S.admin.quizzes.find(q => q.id === id), true); break;
    case 'del': S.admin.confirmDel = id; render(); break;
    case 'del-no': S.admin.confirmDel = null; render(); break;
    case 'del-yes':
      S.admin.confirmDel = null;
      api('DELETE', '/api/admin/quizzes/' + encodeURIComponent(id))
        .then(() => { toast('Quiz deleted'); S.quizzes = null; return loadAdmin(); })
        .catch(err => { notice(err.message || 'Could not delete the quiz.'); render(); });
      break;
    case 'cancel-edit': S.admin.draft = null; render(); break;
    case 'save-quiz': saveQuiz(); break;
    case 'import': importQuestions(); break;
    case 'add-q': d.questions.push(blankQ()); render(); { const t = $(`#q${d.questions.length - 1}-q`); if (t) t.focus(); } break;
    case 'rm-q': d.questions.splice(i, 1); if (!d.questions.length) d.questions.push(blankQ()); render(); break;
    case 'up': [d.questions[i - 1], d.questions[i]] = [d.questions[i], d.questions[i - 1]]; render(); break;
    case 'down': [d.questions[i + 1], d.questions[i]] = [d.questions[i], d.questions[i + 1]]; render(); break;
  }
});

function onField(e) {
  const t = e.target;
  if (t.id === 'nick') { S.nick = t.value; lsSet('bc-nick', t.value); return; }
  if (t.id === 'join-code') { S.joinCode = t.value.toUpperCase(); return; }
  const f = t.dataset.f; if (!f) return;
  if (f === 'import') { S.admin.importText = t.value; return; }
  const d = S.admin.draft; if (!d) return;
  const i = +t.dataset.i, j = +t.dataset.j;
  if (f === 'title' || f === 'blurb') d[f] = t.value;
  else if (f === 'q') d.questions[i].q = t.value;
  else if (f === 'o') d.questions[i].o[j] = t.value;
  else if (f === 't') d.questions[i].t = +t.value;
  else if (f === 'c' && t.checked) d.questions[i].c = j;
}
document.addEventListener('input', onField);
document.addEventListener('change', onField);
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'admin-pw') login();
  else if (e.target.id === 'join-code') join(e.target.value);
  else if (e.target.id === 'nick' && S.route === 'join') join(S.joinCode);
  else if (e.target.id === 'nick' && S.route === 'room' && !S.st) join(S.joinCode);
});

route();
