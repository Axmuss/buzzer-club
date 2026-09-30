'use strict';
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const storage = require('./storage');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const ADMIN_TOKEN = ADMIN_PASSWORD
  ? crypto.createHmac('sha256', ADMIN_PASSWORD).update('buzzer-club-admin-v1').digest('hex')
  : null;
const TIMES = [10, 15, 20, 30, 45];
const MAX_PLAYERS = 50;
const ROOM_IDLE_MS = 30 * 60 * 1000;
const GRACE_MS = 300;
const PUBLIC = path.join(__dirname, 'public');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- HTTP: pages and the quiz builder API ---------------- */

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC));

const sameSecret = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(503).json({ error: 'The quiz builder is switched off. Set ADMIN_PASSWORD on the server to turn it on.' });
  if (!sameSecret(req.get('x-admin-token') || '', ADMIN_TOKEN)) return res.status(401).json({ error: 'Log in again.' });
  next();
}

function cleanQuiz(body) {
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const title = str(body && body.title, 60);
  if (!title) return { error: 'Give the quiz a title.' };
  const blurb = str(body.blurb, 120);
  const list = Array.isArray(body.questions) ? body.questions : [];
  if (!list.length) return { error: 'Add at least one question.' };
  if (list.length > 100) return { error: 'A quiz can have at most 100 questions.' };
  const questions = [];
  for (let i = 0; i < list.length; i++) {
    const x = list[i] || {};
    const q = str(x.q, 300);
    const o = Array.isArray(x.o) ? x.o.slice(0, 4).map(s => str(s, 120)) : [];
    if (!q || o.length !== 4 || o.some(s => !s)) return { error: `Question ${i + 1} needs its text and all four answers.` };
    if (!Number.isInteger(x.c) || x.c < 0 || x.c > 3) return { error: `Question ${i + 1} needs a correct answer.` };
    questions.push({ q, o, c: x.c, t: TIMES.includes(x.t) ? x.t : 20 });
  }
  return { quiz: { title, blurb, questions } };
}

const byTitle = (a, b) => a.title.localeCompare(b.title);
const summary = q => ({
  id: q.id, title: q.title, blurb: q.blurb || '', count: q.questions.length,
  secs: q.questions.reduce((s, x) => s + x.t + 10, 0),
});

app.get('/healthz', (req, res) => res.send('ok'));

app.get('/api/quizzes', async (req, res, next) => {
  try { res.json((await storage.list()).sort(byTitle).map(summary)); } catch (e) { next(e); }
});

app.post('/api/admin/login', async (req, res) => {
  if (!ADMIN_TOKEN) return res.status(503).json({ error: 'The quiz builder is switched off. Set ADMIN_PASSWORD on the server to turn it on.' });
  const pw = String((req.body && req.body.password) || '');
  if (!sameSecret(pw, ADMIN_PASSWORD)) {
    await sleep(700); // slows down password guessing
    return res.status(401).json({ error: 'That password is not right.' });
  }
  res.json({ token: ADMIN_TOKEN });
});

app.get('/api/admin/quizzes', requireAdmin, async (req, res, next) => {
  try { res.json((await storage.list()).sort(byTitle)); } catch (e) { next(e); }
});

app.put('/api/admin/quizzes/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!/^[A-Za-z0-9_-]{1,60}$/.test(id)) return res.status(400).json({ error: 'That quiz id is not valid.' });
    const r = cleanQuiz(req.body);
    if (r.error) return res.status(400).json({ error: r.error });
    await storage.save({ id, ...r.quiz, updatedAt: Date.now() });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.delete('/api/admin/quizzes/:id', requireAdmin, async (req, res, next) => {
  try { await storage.remove(req.params.id); res.json({ ok: true }); } catch (e) { next(e); }
});

// The page handles these routes itself.
app.get(['/join/:code', '/builder'], (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'The server hit a problem. Try again.' });
});

/* ---------------- Live game over Socket.IO ---------------- */

const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 8000 });
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const cleanNick = n => (typeof n === 'string' ? n.replace(/\s+/g, ' ').trim().slice(0, 20) : '');
const cleanCode = c => (typeof c === 'string' ? c.trim().toUpperCase() : '');
const isConnected = p => p.sockets.size > 0;

function newCode() {
  let code;
  do code = Array.from({ length: 4 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  while (rooms.has(code));
  return code;
}

function pointsFor(q, ans) {
  if (!ans || ans.c !== q.c) return 0;
  return Math.round(500 + 500 * Math.max(0, 1 - ans.ms / (q.t * 1000)));
}

function standings(room) {
  const upto = room.status === 'question' || room.status === 'lobby' ? room.index - 1 : room.index;
  return [...room.players.values()].map(p => {
    let total = 0, last = 0;
    for (let i = 0; i <= upto; i++) {
      const pts = pointsFor(room.quiz.questions[i], p.answers[i]);
      total += pts;
      if (i === upto) last = pts;
    }
    return {
      pubId: p.pubId, nick: p.nick, connected: isConnected(p), isHost: p.id === room.hostId,
      answered: room.status === 'question' && p.answers[room.index] !== undefined, total, last,
    };
  }).sort((a, b) => b.total - a.total || a.nick.localeCompare(b.nick));
}

// Each player gets their own view: the correct answer is only sent after the reveal.
function view(room, pid) {
  const me = room.players.get(pid);
  const q = room.index >= 0 ? room.quiz.questions[room.index] : null;
  const showQ = !!q && room.status !== 'lobby';
  const revealed = showQ && (room.status === 'reveal' || room.status === 'final');
  let counts = null;
  if (revealed) {
    counts = [0, 0, 0, 0];
    for (const p of room.players.values()) { const a = p.answers[room.index]; if (a) counts[a.c]++; }
  }
  const active = [...room.players.values()].filter(isConnected);
  const host = room.players.get(room.hostId);
  const myAns = me && showQ ? me.answers[room.index] : undefined;
  return {
    code: room.code, status: room.status, quizId: room.quiz.id, quizTitle: room.quiz.title,
    total: room.quiz.questions.length, index: room.index,
    serverNow: Date.now(), endsAt: room.endsAt,
    hostConnected: !!host && isConnected(host),
    you: me ? { pubId: me.pubId, isHost: pid === room.hostId, answer: myAns ? myAns.c : null, points: revealed ? pointsFor(q, myAns) : 0 } : null,
    players: standings(room),
    question: showQ ? { q: q.q, o: q.o, t: q.t } : null,
    correct: revealed ? q.c : null,
    counts,
    answeredCount: room.status === 'question' ? active.filter(p => p.answers[room.index] !== undefined).length : 0,
    activeCount: active.length,
  };
}

function broadcast(room) {
  room.lastActive = Date.now();
  for (const p of room.players.values()) {
    for (const sid of p.sockets) io.to(sid).emit('state', view(room, p.id));
  }
}

function deleteRoom(room) {
  clearTimeout(room.timer);
  rooms.delete(room.code);
}

function startQuestion(room, index) {
  clearTimeout(room.timer);
  const q = room.quiz.questions[index];
  room.status = 'question';
  room.index = index;
  room.qStart = Date.now();
  room.endsAt = room.qStart + q.t * 1000;
  room.timer = setTimeout(() => reveal(room), q.t * 1000 + GRACE_MS);
  broadcast(room);
}

function reveal(room) {
  if (room.status !== 'question') return;
  clearTimeout(room.timer);
  room.status = 'reveal';
  broadcast(room);
}

function revealIfEveryoneAnswered(room) {
  if (room.status !== 'question') return;
  const active = [...room.players.values()].filter(isConnected);
  if (active.length && active.every(p => p.answers[room.index] !== undefined)) reveal(room);
}

function resetForNewRound(room) {
  clearTimeout(room.timer);
  for (const [id, p] of room.players) {
    if (!isConnected(p) && id !== room.hostId) room.players.delete(id);
    else p.answers = {};
  }
  room.status = 'lobby';
  room.index = -1;
  room.endsAt = 0;
}

function snapshotQuiz(quiz) {
  return { id: quiz.id, title: quiz.title, questions: quiz.questions.map(q => ({ ...q, o: q.o.slice() })) };
}

io.on('connection', socket => {
  const pid = socket.handshake.auth && socket.handshake.auth.playerId;
  if (typeof pid !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(pid)) { socket.disconnect(true); return; }

  const currentRoom = () => {
    const room = rooms.get(socket.data.code);
    return room && room.players.has(pid) ? room : null;
  };
  const hostRoom = () => { const r = currentRoom(); return r && r.hostId === pid ? r : null; };

  function detach() {
    const room = rooms.get(socket.data.code);
    if (room) {
      const p = room.players.get(pid);
      if (p) p.sockets.delete(socket.id);
      socket.leave(room.code);
      revealIfEveryoneAnswered(room);
      broadcast(room);
    }
    socket.data.code = null;
  }

  function attach(room, nick) {
    if (socket.data.code && socket.data.code !== room.code) detach();
    let p = room.players.get(pid);
    if (!p) {
      p = { id: pid, pubId: crypto.randomBytes(6).toString('hex'), nick, answers: {}, sockets: new Set() };
      room.players.set(pid, p);
    } else if (nick) {
      p.nick = nick;
    }
    p.sockets.add(socket.id);
    socket.join(room.code);
    socket.data.code = room.code;
  }

  // Every event replies through its acknowledgement: {ok:true, ...} or {error}.
  const on = (event, fn) => socket.on(event, async (data, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try { reply((await fn(data && typeof data === 'object' ? data : {})) || { ok: true }); }
    catch (e) { console.error(event, e); reply({ error: 'The server hit a problem. Try again.' }); }
  });

  on('room:create', async ({ quizId, nick }) => {
    nick = cleanNick(nick);
    if (!nick) return { error: 'Type your name first.' };
    const quiz = typeof quizId === 'string' ? await storage.get(quizId) : null;
    if (!quiz || !quiz.questions.length) return { error: 'That quiz is no longer available.' };
    const room = {
      code: newCode(), quiz: snapshotQuiz(quiz), status: 'lobby', index: -1, hostId: pid,
      players: new Map(), qStart: 0, endsAt: 0, timer: null, lastActive: Date.now(),
    };
    rooms.set(room.code, room);
    attach(room, nick);
    broadcast(room);
    return { ok: true, code: room.code };
  });

  on('room:join', async ({ code, nick }) => {
    nick = cleanNick(nick);
    code = cleanCode(code);
    if (!nick) return { error: 'Type your name first.' };
    const room = rooms.get(code);
    if (!room) return { error: `There's no game with code ${code || '…'} right now. Check the link with your host.` };
    if (!room.players.has(pid) && room.players.size >= MAX_PLAYERS) return { error: 'This game is full.' };
    attach(room, nick);
    broadcast(room);
    return { ok: true, code };
  });

  on('room:resume', async ({ code }) => {
    const room = rooms.get(cleanCode(code));
    if (!room || !room.players.has(pid)) return { error: 'gone' };
    attach(room, '');
    broadcast(room);
    return { ok: true, code: room.code };
  });

  on('room:leave', async () => {
    const room = currentRoom();
    if (!room) return;
    socket.leave(room.code);
    socket.data.code = null;
    room.players.delete(pid);
    if (!room.players.size) { deleteRoom(room); return; }
    if (room.hostId === pid) {
      const next = [...room.players.values()].find(isConnected) || room.players.values().next().value;
      room.hostId = next.id;
    }
    revealIfEveryoneAnswered(room);
    broadcast(room);
  });

  on('game:start', async () => {
    const room = hostRoom();
    if (!room || room.status !== 'lobby') return { error: 'Only the host can start the game.' };
    startQuestion(room, 0);
  });

  on('game:answer', async ({ c }) => {
    const room = currentRoom();
    if (!room || room.status !== 'question') return { error: 'Too late for this question.' };
    const p = room.players.get(pid);
    const now = Date.now();
    if (p.answers[room.index] !== undefined) return { error: 'You already answered.' };
    if (!Number.isInteger(c) || c < 0 || c > 3) return { error: 'Pick one of the four answers.' };
    if (now > room.endsAt + GRACE_MS) return { error: 'Time is up for this question.' };
    p.answers[room.index] = { c, ms: Math.min(now - room.qStart, room.endsAt - room.qStart) };
    broadcast(room);
    revealIfEveryoneAnswered(room);
  });

  on('game:next', async () => {
    const room = hostRoom();
    if (!room || room.status !== 'reveal') return;
    if (room.index + 1 < room.quiz.questions.length) startQuestion(room, room.index + 1);
    else { room.status = 'final'; broadcast(room); }
  });

  on('game:rematch', async () => {
    const room = hostRoom();
    if (!room || room.status !== 'final') return;
    resetForNewRound(room);
    broadcast(room);
  });

  on('game:quiz', async ({ quizId }) => {
    const room = hostRoom();
    if (!room || (room.status !== 'final' && room.status !== 'lobby')) return { error: 'You can change the quiz between games.' };
    const quiz = typeof quizId === 'string' ? await storage.get(quizId) : null;
    if (!quiz || !quiz.questions.length) return { error: 'That quiz is no longer available.' };
    room.quiz = snapshotQuiz(quiz);
    resetForNewRound(room);
    broadcast(room);
  });

  on('room:close', async () => {
    const room = hostRoom();
    if (!room) return;
    io.to(room.code).emit('closed', 'The host closed the game.');
    for (const s of await io.in(room.code).fetchSockets()) { s.leave(room.code); s.data.code = null; }
    deleteRoom(room);
  });

  on('room:takeover', async () => {
    const room = currentRoom();
    if (!room) return;
    const host = room.players.get(room.hostId);
    if (host && isConnected(host)) return { error: 'The host is still here.' };
    room.hostId = pid;
    broadcast(room);
  });

  socket.on('disconnect', () => detach());
});

// Forget games nobody has been connected to for a while.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const anyone = [...room.players.values()].some(isConnected);
    if (!anyone && now - room.lastActive > ROOM_IDLE_MS) deleteRoom(room);
  }
}, 60 * 1000).unref();

storage.init().then(name => {
  server.listen(PORT, () => {
    console.log(`Buzzer Club running on http://localhost:${PORT}`);
    console.log(`Quiz storage: ${name}`);
    if (!ADMIN_PASSWORD) console.log('ADMIN_PASSWORD is not set, so the quiz builder is switched off.');
  });
}).catch(err => {
  console.error('Could not load quizzes:', err);
  process.exit(1);
});
