const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const QRCode = require('qrcode');
const os = require('os');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;
const ADMIN_PASSWORD = '1234';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/pedir', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pedir.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// --- BASE DE DATOS SQLITE ---
const db = new Database('karaoke.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    device_id TEXT PRIMARY KEY,
    singer TEXT NOT NULL,
    norm_singer TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    singer TEXT NOT NULL,
    video_id TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    sort_order REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    queue_id INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    score INTEGER NOT NULL,
    UNIQUE(queue_id, device_id)
  );
`);

let appState = {
  showQR: true,
  showSidebar: true,
  showRanking: false,
  showTicker: true,
  autoPlay: true,
  isPlaying: true
};

const lastReactionTime = {};
const lastTickerTime = {};

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

const LOCAL_IP = getLocalIP();
const GUEST_URL = `http://${LOCAL_IP}:${PORT}/pedir`;

function extractVideoId(url) {
  if (!url) return null;
  const regExp = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?|shorts)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i;
  const match = url.trim().match(regExp);
  return match ? match[1] : null;
}

async function getYoutubeMetadata(videoId) {
  try {
    const oembedRes = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
    if (!oembedRes.ok) {
      return { ok: false, reason: 'El video no existe, es privado o tiene bloqueada la reproducción fuera de YouTube.' };
    }
    const data = await oembedRes.json();
    return { ok: true, title: data.title };
  } catch (e) {
    return { ok: false, reason: 'No se pudo verificar el video en YouTube.' };
  }
}

function getPendingQueue() {
  return db.prepare("SELECT * FROM queue WHERE status = 'pending' ORDER BY sort_order ASC, id ASC").all();
}

function calculateInitialSortOrder(deviceId, singer) {
  const pending = getPendingQueue();
  if (pending.length === 0) return 100;

  const normSinger = singer.trim().toLowerCase();

  const pastCount = db.prepare(`
    SELECT COUNT(*) as count FROM queue 
    WHERE status IN ('played', 'playing') AND (device_id = ? OR LOWER(TRIM(singer)) = ?)
  `).get(deviceId, normSinger).count;

  const currentPendingCount = pending.filter(
    item => item.device_id === deviceId || item.singer.trim().toLowerCase() === normSinger
  ).length;

  const newSongRound = pastCount + currentPendingCount;

  const playedRows = db.prepare(`
    SELECT device_id, LOWER(TRIM(singer)) as norm_singer, COUNT(*) as count 
    FROM queue WHERE status IN ('played', 'playing') GROUP BY device_id, norm_singer
  `).all();

  const pastMap = {};
  for (const r of playedRows) {
    pastMap[r.device_id || r.norm_singer] = r.count;
  }

  const userTurn = {};
  const pendingWithRound = pending.map(item => {
    const key = item.device_id || item.singer.trim().toLowerCase();
    const round = (pastMap[key] || 0) + (userTurn[key] || 0);
    userTurn[key] = (userTurn[key] || 0) + 1;
    return { ...item, round };
  });

  let insertAfterIndex = -1;
  for (let i = 0; i < pendingWithRound.length; i++) {
    if (pendingWithRound[i].round <= newSongRound) {
      insertAfterIndex = i;
    }
  }

  if (insertAfterIndex === -1) return pending[0].sort_order - 10;
  if (insertAfterIndex === pending.length - 1) return pending[pending.length - 1].sort_order + 10;

  return (pending[insertAfterIndex].sort_order + pending[insertAfterIndex + 1].sort_order) / 2;
}

// Ponderación: 0.8x si tiene 4 seguidos iguales con 5 o 1
function getVoterWeightsMap() {
  const allVotes = db.prepare("SELECT device_id, score FROM votes ORDER BY id ASC").all();
  const byUser = {};
  for (const v of allVotes) {
    if (!byUser[v.device_id]) byUser[v.device_id] = [];
    byUser[v.device_id].push(v.score);
  }

  const weights = {};
  for (const [devId, scores] of Object.entries(byUser)) {
    if (scores.length >= 4) {
      const lastFour = scores.slice(-4);
      const allOnes = lastFour.every(s => s === 1);
      const allFives = lastFour.every(s => s === 5);
      weights[devId] = (allOnes || allFives) ? 0.8 : 1.0;
    } else {
      weights[devId] = 1.0;
    }
  }
  return weights;
}

function computeWeightedSongScore(queueId, weightsMap) {
  const votes = db.prepare("SELECT device_id, score FROM votes WHERE queue_id = ?").all(queueId);
  if (votes.length === 0) return { avg: 0, count: 0 };

  let weightedSum = 0;
  let totalWeight = 0;
  for (const v of votes) {
    const w = weightsMap[v.device_id] || 1.0;
    weightedSum += v.score * w;
    totalWeight += w;
  }
  const avg = totalWeight > 0 ? weightedSum / totalWeight : 0;
  return {
    avg: Number(avg.toFixed(1)),
    count: votes.length
  };
}

function getFullState() {
  let current = db.prepare("SELECT * FROM queue WHERE status = 'playing' ORDER BY id ASC LIMIT 1").get();
  const pending = getPendingQueue();

  if (!current && pending.length > 0) {
    const nextSong = pending.shift();
    db.prepare("UPDATE queue SET status = 'playing' WHERE id = ?").run(nextSong.id);
    current = { ...nextSong, status: 'playing' };
    appState.isPlaying = appState.autoPlay;
  }

  let currentScore = { avg: 0, count: 0 };
  if (current) {
    const weights = getVoterWeightsMap();
    currentScore = computeWeightedSongScore(current.id, weights);
  }

  return {
    current,
    currentScore,
    pending,
    appState,
    guestUrl: GUEST_URL
  };
}

function getRankingAndWrapped() {
  const weights = getVoterWeightsMap();
  const songs = db.prepare("SELECT id, device_id, singer, title FROM queue WHERE status IN ('played', 'playing')").all();

  const ranking = songs.map(s => {
    const stats = computeWeightedSongScore(s.id, weights);
    return {
      ...s,
      avg_score: stats.avg,
      vote_count: stats.count
    };
  }).sort((a, b) => {
    if (b.avg_score !== a.avg_score) return b.avg_score - a.avg_score;
    return b.vote_count - a.vote_count;
  });

  const users = db.prepare("SELECT device_id, singer FROM users").all();
  const userNameMap = {};
  for (const u of users) userNameMap[u.device_id] = u.singer;

  const queueNames = db.prepare("SELECT DISTINCT device_id, singer FROM queue").all();
  for (const q of queueNames) {
    if (!userNameMap[q.device_id]) userNameMap[q.device_id] = q.singer;
  }

  const voterStats = db.prepare(`
    SELECT 
      device_id,
      AVG(score) as avg_given,
      COUNT(*) as total_votes,
      SUM(CASE WHEN score = 5 THEN 1 ELSE 0 END) as fives_given
    FROM votes
    GROUP BY device_id
    HAVING total_votes >= 2
  `).all();

  let hater = null;
  let generous = null;

  if (voterStats.length > 0) {
    const sortedHater = [...voterStats].sort((a, b) => a.avg_given - b.avg_given)[0];
    hater = {
      name: userNameMap[sortedHater.device_id] || 'Anónimo',
      detail: `Promedio ${Number(sortedHater.avg_given).toFixed(1)} ⭐ (${sortedHater.total_votes} votos)`
    };

    const sortedGenerous = [...voterStats].sort((a, b) => {
      if (b.fives_given !== a.fives_given) return b.fives_given - a.fives_given;
      return b.avg_given - a.avg_given;
    })[0];
    generous = {
      name: userNameMap[sortedGenerous.device_id] || 'Anónimo',
      detail: `${sortedGenerous.fives_given} cincos regalados (Prom. ${Number(sortedGenerous.avg_given).toFixed(1)} ⭐)`
    };
  }

  const singerCounts = db.prepare(`
    SELECT device_id, singer, COUNT(*) as sang_count
    FROM queue
    WHERE status IN ('played', 'playing')
    GROUP BY device_id
    ORDER BY sang_count DESC
    LIMIT 1
  `).get();

  const mostActive = singerCounts ? {
    name: userNameMap[singerCounts.device_id] || singerCounts.singer,
    detail: `${singerCounts.sang_count} ${singerCounts.sang_count === 1 ? 'tema cantado' : 'temas cantados'}`
  } : null;

  const votedSongs = ranking.filter(r => r.vote_count > 0);
  const lowestSong = votedSongs.length > 1 ? votedSongs[votedSongs.length - 1] : null;

  return {
    ranking,
    wrapped: {
      hater,
      generous,
      mostActive,
      lowestSong: lowestSong ? {
        name: lowestSong.singer,
        detail: `"${lowestSong.title}" (${lowestSong.avg_score} ⭐)`
      } : null
    }
  };
}

// --- API ---
app.get('/api/qr', async (req, res) => {
  try {
    const qrDataUrl = await QRCode.toDataURL(GUEST_URL, {
      margin: 1,
      width: 220,
      color: { dark: '#000000', light: '#FFFFFF' }
    });
    res.json({ qr: qrDataUrl, url: GUEST_URL });
  } catch (err) {
    res.status(500).json({ error: 'Error generando QR' });
  }
});

app.post('/api/register-user', (req, res) => {
  const { deviceId, singer } = req.body;
  if (!deviceId || !singer || !singer.trim()) {
    return res.status(400).json({ ok: false, error: 'Ingresá un nombre válido.' });
  }

  const cleanSinger = singer.trim().slice(0, 25);
  const normSinger = cleanSinger.toLowerCase();

  const taken = db.prepare("SELECT * FROM users WHERE norm_singer = ? AND device_id != ?").get(normSinger, deviceId);
  if (taken) {
    return res.status(409).json({
      ok: false,
      error: `El nombre "${cleanSinger}" ya lo está usando otra persona. ¡Agregale tu apellido o un apodo!`
    });
  }

  db.prepare(`
    INSERT INTO users (device_id, singer, norm_singer)
    VALUES (?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET singer = excluded.singer, norm_singer = excluded.norm_singer
  `).run(deviceId, cleanSinger, normSinger);

  db.prepare("UPDATE queue SET singer = ? WHERE device_id = ? AND status = 'pending'").run(cleanSinger, deviceId);
  io.emit('state_update', getFullState());

  res.json({ ok: true, singer: cleanSinger });
});

app.post('/api/check-song', async (req, res) => {
  const { url } = req.body;
  const videoId = extractVideoId(url);

  if (!videoId) {
    return res.status(400).json({ ok: false, error: 'Ese link de YouTube no parece válido.' });
  }

  const existing = db.prepare("SELECT * FROM queue WHERE video_id = ? AND status IN ('pending', 'playing')").get(videoId);
  if (existing) {
    return res.status(409).json({
      ok: false,
      error: `¡Esa canción ya está en la cola! La pidió ${existing.singer}.`
    });
  }

  const meta = await getYoutubeMetadata(videoId);
  if (!meta.ok) {
    return res.status(400).json({ ok: false, error: meta.reason });
  }

  const hasKaraokeWord = /karaoke|instrumental|pista|lyrics|letra/i.test(meta.title);

  res.json({
    ok: true,
    videoId,
    title: meta.title,
    isKaraokeLikely: hasKaraokeWord
  });
});

app.post('/api/add-song', (req, res) => {
  const { singer, videoId, title, deviceId } = req.body;
  if (!singer || !videoId || !title || !deviceId) {
    return res.status(400).json({ ok: false, error: 'Faltan datos.' });
  }

  const cleanSinger = singer.trim().slice(0, 25);
  const normSinger = cleanSinger.toLowerCase();

  const taken = db.prepare("SELECT * FROM users WHERE norm_singer = ? AND device_id != ?").get(normSinger, deviceId);
  if (taken) {
    return res.status(409).json({ ok: false, error: `El nombre "${cleanSinger}" ya está en uso.` });
  }

  db.prepare(`
    INSERT INTO users (device_id, singer, norm_singer)
    VALUES (?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET singer = excluded.singer, norm_singer = excluded.norm_singer
  `).run(deviceId, cleanSinger, normSinger);

  const existing = db.prepare("SELECT * FROM queue WHERE video_id = ? AND status IN ('pending', 'playing')").get(videoId);
  if (existing) {
    return res.status(409).json({ ok: false, error: `Ya la agregó ${existing.singer} recién.` });
  }

  const sortOrder = calculateInitialSortOrder(deviceId, cleanSinger);
  const info = db.prepare(
    "INSERT INTO queue (device_id, singer, video_id, title, sort_order) VALUES (?, ?, ?, ?, ?)"
  ).run(deviceId, cleanSinger, videoId, title, sortOrder);

  const newId = Number(info.lastInsertRowid);
  const state = getFullState();

  let position = 0;
  if (state.current && state.current.id === newId) {
    position = 0;
  } else {
    const idx = state.pending.findIndex(item => item.id === newId);
    position = idx + 1;
  }

  io.emit('new_song_popup', { singer: cleanSinger, title, position });
  io.emit('state_update', state);

  res.json({ ok: true, id: newId, position });
});

app.post('/api/vote', (req, res) => {
  const { queueId, deviceId, score } = req.body;
  const numScore = Number(score);

  if (!queueId || !deviceId || numScore < 1 || numScore > 5) {
    return res.status(400).json({ ok: false, error: 'Voto inválido.' });
  }

  const song = db.prepare("SELECT device_id FROM queue WHERE id = ?").get(queueId);
  if (song && song.device_id === deviceId) {
    return res.status(403).json({ ok: false, error: '¡No vale autovotarse mientras cantás!' });
  }

  try {
    db.prepare("INSERT INTO votes (queue_id, device_id, score) VALUES (?, ?, ?)").run(queueId, deviceId, numScore);
    io.emit('state_update', getFullState());
    res.json({ ok: true });
  } catch (err) {
    res.status(409).json({ ok: false, error: 'Ya votaste en esta canción.' });
  }
});

app.post('/api/react', (req, res) => {
  const { deviceId, emoji } = req.body;
  const allowed = ['🔥', '👏', '🍅', '💀'];
  if (!deviceId || !allowed.includes(emoji)) {
    return res.status(400).json({ ok: false });
  }

  const now = Date.now();
  if (lastReactionTime[deviceId] && now - lastReactionTime[deviceId] < 3500) {
    return res.status(429).json({ ok: false, error: 'Esperá unos segundos.' });
  }
  lastReactionTime[deviceId] = now;

  io.emit('live_reaction', { emoji });
  res.json({ ok: true });
});

app.post('/api/ticker', (req, res) => {
  const { deviceId, singer, text } = req.body;
  if (!appState.showTicker) {
    return res.status(403).json({ ok: false, error: 'La cartelera está desactivada.' });
  }
  if (!deviceId || !text || !text.trim()) {
    return res.status(400).json({ ok: false, error: 'Escribí un mensaje.' });
  }

  const now = Date.now();
  if (lastTickerTime[deviceId] && now - lastTickerTime[deviceId] < 12000) {
    const wait = Math.ceil((12000 - (now - lastTickerTime[deviceId])) / 1000);
    return res.status(429).json({ ok: false, error: `Esperá ${wait}s para mandar otro mensaje.` });
  }
  lastTickerTime[deviceId] = now;

  const cleanAuthor = (singer || 'Anónimo').trim().slice(0, 20);
  const cleanText = text.trim().slice(0, 75);

  io.emit('ticker_message', { author: cleanAuthor, text: cleanText });
  res.json({ ok: true });
});

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) res.json({ ok: true });
  else res.status(401).json({ ok: false, error: 'Clave incorrecta' });
});

// --- SOCKETS ---
io.on('connection', (socket) => {
  socket.emit('state_update', getFullState());

  socket.on('next_song', () => {
    const current = db.prepare("SELECT * FROM queue WHERE status = 'playing'").get();
    if (current) {
      db.prepare("UPDATE queue SET status = 'played' WHERE id = ?").run(current.id);
    }
    const nextList = getPendingQueue();
    if (nextList.length > 0) {
      db.prepare("UPDATE queue SET status = 'playing' WHERE id = ?").run(nextList[0].id);
    }
    appState.isPlaying = appState.autoPlay;
    io.emit('state_update', getFullState());
  });

  socket.on('prev_song', () => {
    const lastPlayed = db.prepare("SELECT * FROM queue WHERE status = 'played' ORDER BY id DESC LIMIT 1").get();
    if (!lastPlayed) return;

    const current = db.prepare("SELECT * FROM queue WHERE status = 'playing'").get();
    if (current) {
      const firstPending = getPendingQueue()[0];
      const topOrder = firstPending ? firstPending.sort_order - 10 : 100;
      db.prepare("UPDATE queue SET status = 'pending', sort_order = ? WHERE id = ?").run(topOrder, current.id);
    }
    db.prepare("UPDATE queue SET status = 'playing' WHERE id = ?").run(lastPlayed.id);
    appState.isPlaying = appState.autoPlay;
    io.emit('state_update', getFullState());
  });

  socket.on('admin_action', (data) => {
    if (data.password !== ADMIN_PASSWORD) return;

    switch (data.action) {
      case 'toggle_play':
        appState.isPlaying = !appState.isPlaying;
        io.emit('player_command', appState.isPlaying ? 'play' : 'pause');
        io.emit('state_update', getFullState());
        break;

      case 'toggle_autoplay':
        appState.autoPlay = !appState.autoPlay;
        io.emit('state_update', getFullState());
        break;

      case 'restart_video':
        appState.isPlaying = true;
        io.emit('player_command', 'restart');
        io.emit('state_update', getFullState());
        break;

      case 'toggle_qr':
        appState.showQR = !appState.showQR;
        io.emit('state_update', getFullState());
        break;

      case 'toggle_sidebar':
        appState.showSidebar = !appState.showSidebar;
        io.emit('state_update', getFullState());
        break;

      case 'toggle_ticker':
        appState.showTicker = !appState.showTicker;
        io.emit('state_update', getFullState());
        break;

      case 'clear_ticker':
        io.emit('clear_ticker');
        break;

      case 'dj_sound':
        io.emit('play_dj_sound', { sound: data.sound });
        break;

      case 'toggle_ranking': {
        appState.showRanking = !appState.showRanking;
        const payload = appState.showRanking ? getRankingAndWrapped() : { ranking: [], wrapped: {} };
        io.emit('ranking_update', { show: appState.showRanking, ...payload });
        io.emit('state_update', getFullState());
        break;
      }

      case 'move_song': {
        const pending = getPendingQueue();
        const idx = pending.findIndex(item => item.id === data.id);
        if (idx === -1) break;

        const targetIdx = data.direction === 'up' ? idx - 1 : idx + 1;
        if (targetIdx < 0 || targetIdx >= pending.length) break;

        const temp = pending[idx];
        pending[idx] = pending[targetIdx];
        pending[targetIdx] = temp;

        const updateStmt = db.prepare("UPDATE queue SET sort_order = ? WHERE id = ?");
        const tx = db.transaction((items) => {
          items.forEach((item, i) => updateStmt.run((i + 1) * 100, item.id));
        });
        tx(pending);

        io.emit('state_update', getFullState());
        break;
      }

      case 'delete_song':
        db.prepare("DELETE FROM queue WHERE id = ?").run(data.id);
        io.emit('state_update', getFullState());
        break;

      case 'reset_all':
        db.prepare("DELETE FROM votes").run();
        db.prepare("DELETE FROM queue").run();
        db.prepare("DELETE FROM users").run();
        appState.showRanking = false;
        io.emit('ranking_update', { show: false, ranking: [], wrapped: {} });
        io.emit('clear_ticker');
        io.emit('state_update', getFullState());
        break;
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n==================================================');
  console.log('🎤 KARAOKE PARTY SERVER INICIADO');
  console.log(`📺 Pantalla Principal (TV): http://localhost:${PORT}`);
  console.log(`📱 Celulares (Invitados):   ${GUEST_URL}`);
  console.log(`🎛️  Control Remoto (Admin):  http://${LOCAL_IP}:${PORT}/admin (Clave: ${ADMIN_PASSWORD})`);
  console.log('==================================================\n');
});