'use strict';
const SHAPES = [
  '<path d="M10 2.5 18.5 17.5h-17z"/>',
  '<path d="M10 1.5 18.5 10 10 18.5 1.5 10z"/>',
  '<circle cx="10" cy="10" r="7"/>',
  '<rect x="2.5" y="2.5" width="15" height="15" rx="2"/>',
];
const badge = j => `<span class="badge" aria-hidden="true"><svg viewBox="0 0 20 20">${SHAPES[j]}</svg></span>`;
const picks = n => `<span class="picks">${t('picks', { n })}</span>`;
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

function savedAvatar() {
  let a = lsGet('bc-avatar');
  if (!AVATARS.includes(a)) { a = AVATARS[Math.floor(Math.random() * AVATARS.length)]; lsSet('bc-avatar', a); }
  return a;
}

const S = {
  route: 'home', joinCode: '',
  nick: lsGet('bc-nick') || '',
  avatar: savedAvatar(), avOpen: false,
  st: null, offset: 0, pending: null, timeUpKey: null,
  quizzes: null, quizErr: false,
  busy: false,
  token: lsGet('bc-admin') || '',
  admin: { quizzes: null, draft: null, confirmDel: null, err: '', importText: '', importErr: false, loginErr: '' },
};

// Server replies carry a short code; show the player's language when we know it, else the server's English text.
function errText(r) {
  if (r.code && I18N.en['err.' + r.code]) return t('err.' + r.code, { c: r.gameCode || '' });
  return r.error;
}

/* ---------- language ---------- */
function setLang(l) {
  if (!LANGS.includes(l) || l === LANG) return;
  LANG = l; lsSet('bc-lang', l);
  notice('');
  applyStatic(); render();
}
function applyStatic() {
  document.documentElement.lang = LANG;
  $('#conn').textContent = t('conn.reconnecting');
  $('#foot-scoring').textContent = t('foot.scoring');
  $('#foot-builder').textContent = t('foot.builder');
  $('#lang').setAttribute('aria-label', t('lang.label'));
  for (const b of document.querySelectorAll('[data-lang]')) b.setAttribute('aria-pressed', b.dataset.lang === LANG);
}

/* ---------- connection ---------- */
const socket = io({ auth: { playerId: playerId() } });
function call(event, data) {
  return new Promise(resolve => {
    socket.timeout(8000).emit(event, data || {}, (err, r) => {
      resolve(err ? { error: t('err.connection') } : (r || {}));
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
socket.on('closed', () => {
  S.st = null; lsSet('bc-room', '');
  go('/');
  notice(t('closed'));
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
function toast(msg) { const el = $('#toast'); el.textContent = msg; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 2200); }
function notice(msg) { const n = $('#notice'); n.textContent = msg; n.hidden = !msg; }
function needNick() {
  const n = (S.nick || '').replace(/\s+/g, ' ').trim();
  if (!n) { notice(t('needNick')); const i = $('#nick'); if (i) i.focus(); return null; }
  notice(''); return n.slice(0, 20);
}
const serverNow = () => Date.now() + S.offset;
function timeLeftMs() { const st = S.st; return st && st.status === 'question' ? st.endsAt - serverNow() : 0; }
const inviteUrl = code => location.origin + '/join/' + code;

async function loadQuizzes() {
  try {
    const r = await fetch('/api/quizzes');
    if (!r.ok) throw new Error();
    S.quizzes = await r.json(); S.quizErr = false;
  } catch { S.quizErr = true; }
  render();
}

/* ---------- actions ---------- */
async function host(quizId) {
  const nick = needNick(); if (!nick || S.busy) return;
  S.busy = true; render();
  const r = await call('room:create', { quizId, nick, avatar: S.avatar });
  S.busy = false;
  if (r.error) notice(errText(r));
  render();
}
async function join(code) {
  const nick = needNick(); if (!nick || S.busy) return;
  code = (code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(code)) { notice(t('badCode')); return; }
  S.busy = true; render();
  const r = await call('room:join', { code, nick, avatar: S.avatar });
  S.busy = false;
  if (r.error) notice(errText(r));
  render();
}
async function act(event, data) {
  const r = await call(event, data);
  if (r.error) notice(errText(r));
  return r;
}
async function answer(c) {
  const st = S.st;
  if (!st || st.status !== 'question' || st.you?.answer != null || S.pending || timeLeftMs() <= 0) return;
  S.pending = { key: st.code + ':' + st.index, c };
  render();
  const r = await call('game:answer', { c });
  if (r.error) { S.pending = null; notice(errText(r)); render(); }
}
async function leave() {
  await call('room:leave');
  S.st = null; lsSet('bc-room', '');
  go('/');
}
async function chooseAvatar(a) {
  if (!AVATARS.includes(a)) return;
  S.avatar = a; lsSet('bc-avatar', a);
  render();
  if (S.route === 'room' && S.st) {
    S.avOpen = false;
    await act('player:avatar', { avatar: a });
  }
}
async function copyLink(btn) {
  const url = inviteUrl(S.st.code);
  try {
    await navigator.clipboard.writeText(url);
    btn.textContent = t('copied'); toast(t('linkCopied'));
  } catch {
    const i = $('#share-link'); i.focus(); i.select();
    toast(t('pressCopy'));
  }
  setTimeout(() => { if (btn.isConnected) btn.textContent = t('copyLink'); }, 2000);
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

function nickField() {
  return `<div class="nick-row">
    <label class="field" for="nick"><span class="lbl">${t('nick.label')}</span>
      <input id="nick" maxlength="20" autocomplete="nickname" placeholder="${esc(t('nick.ph'))}" value="${esc(S.nick)}"></label>
  </div>`;
}

const av = (a, cls = '') => `<span class="av ${cls}" aria-hidden="true">${esc(a || '🙂')}</span>`;
function avatarPicker() {
  return `<div class="field"><span class="lbl" id="av-label">${t('avatar.label')}</span>
    <div class="avatar-grid" role="group" aria-labelledby="av-label">${AVATARS.map((a, i) =>
      `<button type="button" class="av-btn" id="av-${i}" data-act="avatar" data-av="${esc(a)}" aria-pressed="${a === S.avatar}" aria-label="${esc(t('avatar.n', { n: i + 1 }))}">${a}</button>`).join('')}</div>
  </div>`;
}

function homeView() {
  let cards;
  if (S.quizErr) cards = `<div class="empty">${t('quizLoadErr')}</div>`;
  else if (!S.quizzes) cards = `<div class="empty">${t('loadingQuizzes')}</div>`;
  else if (!S.quizzes.length) cards = `<div class="empty"><strong>${t('noQuizzes')}</strong><span>${t('noQuizzesHint')}</span></div>`;
  else cards = `<div class="quiz-grid">${S.quizzes.map(q => `<article class="qcard">
      <h3>${esc(q.title)}</h3>
      <p>${esc(q.blurb)}</p>
      <div class="meta mono">${t('questions', { n: q.count })} · ${t('aboutMin', { n: Math.max(1, Math.round(q.secs / 60)) })}</div>
      <button class="btn primary" data-act="host" data-id="${esc(q.id)}" ${S.busy ? 'disabled' : ''}>${t('hostThis')}</button>
    </article>`).join('')}</div>`;
  return `<div class="stack">
    <section class="stage">
      <p class="eyebrow">${t('home.eyebrow')}</p>
      <h1>${t('home.h1')}</h1>
      <p class="sub">${t('home.sub')}</p>
      ${nickField()}
      ${avatarPicker()}
    </section>
    <div class="split">
      <section class="card">
        <h2>${t('join.h2')}</h2>
        <div class="nick-row">
          <label class="field" for="join-code"><span class="lbl">${t('code.label')}</span>
            <input id="join-code" class="code-input" maxlength="4" autocomplete="off" placeholder="K7X2" value="${esc(S.joinCode)}"></label>
          <button class="btn hot" data-act="join-code" ${S.busy ? 'disabled' : ''}>${t('join.btn')}</button>
        </div>
      </section>
      <section class="card">
        <h2>${t('host.h2')}</h2>
        <p class="sub">${t('host.sub')}</p>
      </section>
    </div>
    <div class="sec-head"><h2>${t('quizzes.h2')}</h2></div>
    ${cards}
  </div>`;
}

function joinView() {
  return `<section class="stage">
    <p class="eyebrow">${t('invite.eyebrow')}</p>
    <h1>${t('invite.h1')} <span class="mono">${esc(S.joinCode)}</span></h1>
    <p class="sub">${t('invite.sub')}</p>
    ${nickField()}
    ${avatarPicker()}
    <div class="row"><button class="btn hot big" data-act="join" ${S.busy ? 'disabled' : ''}>${t('joinGame')}</button></div>
    <p class="hostline"><a href="/" data-link>${t('goHome')}</a></p>
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
  return `<ul class="roster">${st.players.map(p => `<li class="${p.pubId === st.you?.pubId ? 'me' : ''} ${p.connected ? '' : 'away'}">${av(p.avatar)}<span class="rname">${esc(p.nick)}</span>${p.isHost ? `<span class="tag">${t('hostTag')}</span>` : ''}</li>`).join('')}</ul>`;
}
function hostName(st) { const h = st.players.find(p => p.isHost); return esc(h ? h.nick : '—'); }
function guestLine(st) {
  if (st.you?.isHost) return '';
  const take = st.hostConnected ? '' : ` ${t('hostLost', { name: hostName(st) })} <button class="link" data-act="takeover">${t('takeover')}</button>`;
  return `<p class="hostline">${t('hostedBy', { name: hostName(st) })}${take} <button class="link" data-act="leave">${t('leave')}</button></p>`;
}

function lobbyView(st) {
  const n = st.players.length;
  const isHost = st.you?.isHost;
  const share = isHost ? `<div class="share">
      <span class="lbl">${t('invite.label')}</span>
      <div class="share-row">
        <input id="share-link" readonly value="${esc(inviteUrl(st.code))}" aria-label="${esc(t('invite.aria'))}">
        <button class="btn" data-act="copy-link">${t('copyLink')}</button>
      </div>
      <p class="hint">${t('invite.hint')}</p>
    </div>` : '';
  return `<section class="stage">
    <p class="eyebrow">${t('lobby')} · ${esc(st.quizTitle)} · ${t('questions', { n: st.total })}</p>
    <div class="row" style="justify-content:space-between">
      <h1>${t('atTable', { n })}</h1>
      <div><span class="lbl">${t('code.label')}</span><div class="roomcode">${esc(st.code)}</div></div>
    </div>
    ${roster(st)}
    <div class="row"><button class="link" data-act="toggle-avatars" aria-expanded="${S.avOpen}">${S.avOpen ? t('doneChoosing') : t('changeAvatar')}</button></div>
    ${S.avOpen ? avatarPicker() : ''}
    ${share}
    ${isHost
      ? `<div class="row"><button class="btn primary big" data-act="start">${t('start')}</button><button class="btn ghost" data-act="close">${t('closeGame')}</button></div>`
      : `<p class="sub">${t('waitStart', { name: hostName(st) })}</p>${guestLine(st)}`}
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
      ${picked ? `<span class="side"><span class="chip">${t('yourAnswer')}</span></span>` : ''}</button>`;
  }).join('');
  const counts = t('answered', { a: st.answeredCount, b: st.activeCount });
  const status = mine != null ? `${t('lockedIn')} ${counts}` : over ? t('timeUp') : counts;
  return `<section class="stage">
    <div class="qtop"><span class="eyebrow">${t('qOf', { i: st.index + 1, n: st.total })}</span><span id="tnum" class="timer mono" aria-label="${esc(t('secondsLeft'))}">${Math.max(0, Math.ceil(timeLeftMs() / 1000))}</span></div>
    <div class="bar" aria-hidden="true"><i id="tbar"></i></div>
    <h1 class="qtext">${esc(q.q)}</h1>
    <div class="tiles">${tiles}</div>
    <p class="status">${status}</p>
    ${guestLine(st)}
  </section>`;
}

function boardView(st, showDelta) {
  return `<ol class="board">${st.players.map((r, i) => `<li class="${r.pubId === st.you?.pubId ? 'me' : ''}">
    <span class="rank">${i + 1}</span>${av(r.avatar)}<span class="nick">${esc(r.nick)}</span>
    <span class="delta ${r.last ? '' : 'zero'}">${showDelta ? '+' + r.last : ''}</span>
    <span class="total">${r.total}</span></li>`).join('')}</ol>`;
}

function revealView(st) {
  const q = st.question;
  const mine = st.you?.answer;
  const tiles = q.o.map((o, j) => {
    const right = j === st.correct, isMine = mine === j;
    const cls = right ? 'win' : isMine ? 'off mine-wrong' : 'off';
    const chip = right ? `<span class="chip good">${t('correctChip')}</span>` : isMine ? `<span class="chip bad">${t('yourAnswer')}</span>` : '';
    return `<div class="tile t${j} ${cls}">
      ${badge(j)}<span class="txt">${esc(o)}</span>
      <span class="side">${chip}${picks(st.counts[j])}</span></div>`;
  }).join('');
  const answerWas = t('answerWas', { a: esc(q.o[st.correct]) });
  const res = mine == null ? `<div class="result bad"><strong>${t('noAnswer')}</strong><span>${answerWas}</span></div>`
    : st.you.points ? `<div class="result good"><strong>${t('correct')}</strong><span>${t('points', { n: st.you.points })}</span></div>`
    : `<div class="result bad"><strong>${t('notThisTime')}</strong><span>${answerWas}</span></div>`;
  const last = st.index + 1 >= st.total;
  return `<section class="stage">
    <p class="eyebrow">${t('qOf', { i: st.index + 1, n: st.total })} · ${t('theAnswer')}</p>
    <h1 class="qtext">${esc(q.q)}</h1>
    <div class="tiles">${tiles}</div>
    ${res}
    <h2>${t('leaderboard')}</h2>
    ${boardView(st, true)}
    ${st.you?.isHost
      ? `<div class="row"><button class="btn primary big" data-act="next">${last ? t('showFinal') : t('next')}</button></div>`
      : guestLine(st)}
  </section>`;
}

function finalView(st) {
  const rows = st.players;
  const top = rows.slice(0, 3);
  const pod = (r, place) => r
    ? `<div class="pod p${place}">${av(r.avatar, 'big')}<span class="who">${esc(r.nick)}</span><span class="pts">${t('pts', { n: r.total })}</span><div class="block">${place}</div></div>`
    : `<div class="pod p${place}"></div>`;
  const headline = !rows.length ? t('gameOver')
    : rows.length > 1 && rows[0].total === rows[1].total ? t('tie')
    : t('takesIt', { name: esc(rows[0].nick) });
  const others = (S.quizzes || []).filter(q => q.id !== st.quizId);
  const hostControls = `<div class="row">
      <button class="btn primary big" data-act="rematch">${t('playAgain')}</button>
      <button class="btn ghost" data-act="close">${t('closeGame')}</button>
    </div>
    ${others.length ? `<div class="nick-row">
      <label class="field" for="next-quiz"><span class="lbl">${t('otherQuiz')}</span>
        <select id="next-quiz">${others.map(q => `<option value="${esc(q.id)}">${esc(q.title)} (${q.count})</option>`).join('')}</select></label>
      <button class="btn" data-act="switch-quiz">${t('loadQuiz')}</button>
    </div>` : ''}`;
  return `<section class="stage">
    <p class="eyebrow">${t('finalResults')} · ${esc(st.quizTitle)}</p>
    <h1>${headline}</h1>
    ${rows.length ? `<div class="podium">${pod(top[1], 2)}${pod(top[0], 1)}${pod(top[2], 3)}</div>` : ''}
    ${boardView(st, false)}
    ${st.you?.isHost ? hostControls : `<p class="sub">${t('waitNext', { name: hostName(st) })}</p>${guestLine(st)}`}
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
  if (!r.ok) throw { message: j.error || t('b.genericErr') };
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
  if (!pw) { S.admin.loginErr = 'b.needPw'; render(); return; }
  try {
    const r = await fetch('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pw }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(r.status === 401 ? 'b.wrongPw' : r.status === 503 ? 'b.off' : 'b.loginFail');
    S.token = j.token; lsSet('bc-admin', j.token); S.admin.loginErr = '';
    await loadAdmin();
  } catch (e) { S.admin.loginErr = e.message.startsWith('b.') ? e.message : 'b.loginFail'; }
  render();
}

function builderView() {
  if (!S.token) return `<section class="stage login">
      <p class="eyebrow">${t('b.title')}</p>
      <h1>${t('b.ownerOnly')}</h1>
      <p class="sub">${t('b.loginSub')}</p>
      <label class="field" for="admin-pw"><span class="lbl">${t('b.password')}</span><input id="admin-pw" type="password" autocomplete="current-password"></label>
      <div class="row"><button class="btn primary" data-act="login">${t('b.login')}</button><a href="/" data-link class="hostline">${t('b.back')}</a></div>
      <p class="err">${S.admin.loginErr ? t(S.admin.loginErr) : ''}</p>
    </section>`;
  return S.admin.draft ? editorView() : adminListView();
}

function adminListView() {
  const A = S.admin;
  const rows = A.err ? `<div class="empty">${esc(A.err)}</div>`
    : !A.quizzes ? `<div class="empty">${t('loadingQuizzes')}</div>`
    : !A.quizzes.length ? `<div class="empty"><strong>${t('noQuizzes')}</strong><span>${t('b.emptySub')}</span></div>`
    : A.quizzes.map(q => {
      const confirm = A.confirmDel === q.id;
      return `<div class="qrow">
        <div><h3>${esc(q.title)}</h3><div class="meta">${t('questions', { n: q.questions.length })}${q.blurb ? ' · ' + esc(q.blurb) : ''}</div></div>
        <div class="row">${confirm
          ? `<span class="hint">${t('b.delQ')}</span><button class="btn small danger solid" data-act="del-yes" data-id="${esc(q.id)}">${t('b.delete')}</button><button class="btn small" data-act="del-no">${t('b.keep')}</button>`
          : `<button class="btn small" data-act="edit" data-id="${esc(q.id)}">${t('b.edit')}</button>
             <button class="btn small" data-act="dup" data-id="${esc(q.id)}">${t('b.dup')}</button>
             <button class="btn small danger" data-act="del" data-id="${esc(q.id)}">${t('b.delete')}</button>`}</div>
      </div>`;
    }).join('');
  return `<div class="stack">
    <div class="sec-head"><div><h1>${t('b.title')}</h1><p class="sub">${t('b.sub')}</p></div>
      <div class="row"><button class="btn primary" data-act="new-quiz">${t('b.new')}</button><button class="btn ghost small" data-act="logout">${t('b.logout')}</button></div></div>
    <div class="quiz-list">${rows}</div>
  </div>`;
}

function blankQ() { return { q: '', o: ['', '', '', ''], c: 0, t: 20 }; }

function editorView() {
  const d = S.admin.draft;
  const qs = d.questions.map((q, i) => `<li class="qed">
      <div class="qed-head">
        <span class="num">${i + 1}</span>
        <label class="hint" for="q${i}-t">${t('b.time')}</label>
        <select id="q${i}-t" data-f="t" data-i="${i}">${TIMES.map(s => `<option value="${s}" ${q.t === s ? 'selected' : ''}>${t('b.sec', { n: s })}</option>`).join('')}</select>
        <button class="btn small" data-act="up" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="${esc(t('b.up'))}">↑</button>
        <button class="btn small" data-act="down" data-i="${i}" ${i === d.questions.length - 1 ? 'disabled' : ''} aria-label="${esc(t('b.down'))}">↓</button>
        <button class="btn small danger" data-act="rm-q" data-i="${i}">${t('b.remove')}</button>
      </div>
      <textarea id="q${i}-q" data-f="q" data-i="${i}" rows="2" maxlength="300" placeholder="${esc(t('b.qph'))}">${esc(q.q)}</textarea>
      <div class="opts">${q.o.map((o, j) => `<div class="opt t${j}">
        <input type="radio" name="c${i}" id="q${i}-c${j}" data-f="c" data-i="${i}" data-j="${j}" ${q.c === j ? 'checked' : ''} aria-label="${esc(t('b.correctAria', { n: j + 1 }))}">
        ${badge(j)}
        <input id="q${i}-o${j}" data-f="o" data-i="${i}" data-j="${j}" value="${esc(o)}" placeholder="${esc(t('b.ansPh', { n: j + 1 }))}" maxlength="120">
      </div>`).join('')}</div>
    </li>`).join('');
  return `<div class="stack">
    <div class="ed-head"><button class="link" data-act="cancel-edit">${t('b.all')}</button>
      <div class="row"><button class="btn ghost" data-act="cancel-edit">${t('b.discard')}</button><button class="btn primary" data-act="save-quiz">${t('b.save')}</button></div></div>
    <div class="ed-grid">
      <label class="field" for="d-title"><span class="lbl">${t('b.qTitle')}</span><input id="d-title" data-f="title" maxlength="60" value="${esc(d.title)}" placeholder="${esc(t('b.qTitlePh'))}"></label>
      <label class="field" for="d-blurb"><span class="lbl">${t('b.blurb')}</span><input id="d-blurb" data-f="blurb" maxlength="120" value="${esc(d.blurb)}" placeholder="${esc(t('b.blurbPh'))}"></label>
    </div>
    <details class="import">
      <summary>${t('b.importSum')}</summary>
      <p class="hint">${esc(t('b.importHint'))}</p>
      <textarea id="import-text" data-f="import" rows="5" placeholder='{"questions":[{"q":"Question?","o":["A","B","C","D"],"c":0}]}'>${esc(S.admin.importText)}</textarea>
      <div class="row"><button class="btn" data-act="import">${t('b.importBtn')}</button><span class="err">${S.admin.importErr ? t('b.importErr') : ''}</span></div>
    </details>
    <p class="hint">${t('b.tickHint')}</p>
    <ol class="qlist">${qs}</ol>
    <button class="btn wide" data-act="add-q">${t('b.addQ')}</button>
    <p id="ed-err" class="err" role="alert"></p>
  </div>`;
}

function openEditor(q, copy) {
  S.admin.draft = q ? {
    id: copy ? rid('quiz-') : q.id,
    title: copy ? q.title + ' ' + t('b.copySuffix') : q.title,
    blurb: q.blurb || '',
    questions: q.questions.map(x => ({ q: x.q, o: x.o.slice(), c: x.c, t: x.t })),
  } : { id: rid('quiz-'), title: '', blurb: '', questions: [blankQ()] };
  S.admin.importText = ''; S.admin.importErr = false;
  render(); window.scrollTo(0, 0);
}

async function saveQuiz() {
  const d = S.admin.draft, err = $('#ed-err');
  const questions = d.questions
    .map(q => ({ q: q.q.trim(), o: q.o.map(o => o.trim()), c: q.c, t: q.t }))
    .filter(q => q.q || q.o.some(Boolean));
  if (!d.title.trim()) { err.textContent = t('b.errTitle'); $('#d-title').focus(); return; }
  const bad = questions.findIndex(q => !q.q || q.o.some(o => !o));
  if (!questions.length) { err.textContent = t('b.errNone'); return; }
  if (bad >= 0) { err.textContent = t('b.errQ', { n: bad + 1 }); return; }
  try {
    await api('PUT', '/api/admin/quizzes/' + encodeURIComponent(d.id), { title: d.title, blurb: d.blurb, questions });
    S.admin.draft = null; S.quizzes = null;
    toast(t('b.saved'));
    await loadAdmin(); render();
  } catch (e) {
    if (e.auth) { render(); notice(t('b.expired')); }
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
    A.importText = ''; A.importErr = false;
    toast(t('b.added', { n: list.length }));
  } catch {
    A.importErr = true;
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
    case 'lang': setLang(b.dataset.lang); break;
    case 'host': host(id); break;
    case 'join': join(S.joinCode); break;
    case 'join-code': join(($('#join-code') || {}).value); break;
    case 'copy-link': copyLink(b); break;
    case 'avatar': chooseAvatar(b.dataset.av); break;
    case 'toggle-avatars': S.avOpen = !S.avOpen; render(); break;
    case 'start': act('game:start'); break;
    case 'answer': answer(+b.dataset.c); break;
    case 'next': act('game:next'); break;
    case 'rematch': act('game:rematch'); break;
    case 'switch-quiz': act('game:quiz', { quizId: $('#next-quiz').value }); break;
    case 'close': act('room:close'); break;
    case 'takeover': act('room:takeover').then(r => { if (!r.error) toast(t('hostNow')); }); break;
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
        .then(() => { toast(t('b.deleted')); S.quizzes = null; return loadAdmin(); })
        .catch(err => { notice(err.message || t('b.delFail')); render(); });
      break;
    case 'cancel-edit': S.admin.draft = null; render(); break;
    case 'save-quiz': saveQuiz(); break;
    case 'import': importQuestions(); break;
    case 'add-q': d.questions.push(blankQ()); render(); { const el = $(`#q${d.questions.length - 1}-q`); if (el) el.focus(); } break;
    case 'rm-q': d.questions.splice(i, 1); if (!d.questions.length) d.questions.push(blankQ()); render(); break;
    case 'up': [d.questions[i - 1], d.questions[i]] = [d.questions[i], d.questions[i - 1]]; render(); break;
    case 'down': [d.questions[i + 1], d.questions[i]] = [d.questions[i], d.questions[i + 1]]; render(); break;
  }
});

function onField(e) {
  const el = e.target;
  if (el.id === 'nick') { S.nick = el.value; lsSet('bc-nick', el.value); return; }
  if (el.id === 'join-code') { S.joinCode = el.value.toUpperCase(); return; }
  const f = el.dataset.f; if (!f) return;
  if (f === 'import') { S.admin.importText = el.value; return; }
  const d = S.admin.draft; if (!d) return;
  const i = +el.dataset.i, j = +el.dataset.j;
  if (f === 'title' || f === 'blurb') d[f] = el.value;
  else if (f === 'q') d.questions[i].q = el.value;
  else if (f === 'o') d.questions[i].o[j] = el.value;
  else if (f === 't') d.questions[i].t = +el.value;
  else if (f === 'c' && el.checked) d.questions[i].c = j;
}
document.addEventListener('input', onField);
document.addEventListener('change', onField);
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'admin-pw') login();
  else if (e.target.id === 'join-code') join(e.target.value);
  else if (e.target.id === 'nick' && S.route === 'join') join(S.joinCode);
});

applyStatic();
route();
