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
  autoPlay: true,
  isPlaying: true
};

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

// Obtiene la cola ordenada por sort_order (respeta tanto prioridad inicial como movimientos del admin)
function getPendingQueue() {
  return db.prepare("SELECT * FROM queue WHERE status = 'pending' ORDER BY sort_order ASC, id ASC").all();
}

// Calcula el sort_order justo (Round-Robin) al insertar una canción nueva
function calculateInitialSortOrder(deviceId, singer) {
  const pending = getPendingQueue();
  if (pending.length === 0) return 100;

  const normSinger = singer.trim().toLowerCase();

  // Cuántas canciones ya cantó/está cantando este usuario
  const pastCount = db.prepare(`
    SELECT COUNT(*) as count FROM queue 
    WHERE status IN ('played', 'playing') AND (device_id = ? OR LOWER(TRIM(singer)) = ?)
  `).get(deviceId, normSinger).count;

  // Cuántas tiene actualmente en espera
  const currentPendingCount = pending.filter(
    item => item.device_id === deviceId || item.singer.trim().toLowerCase() === normSinger
  ).length;

  const newSongRound = pastCount + currentPendingCount;

  // Calcular la ronda de cada canción existente en la cola
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

  // Insertar después de la última canción que tenga ronda <= newSongRound
  let insertAfterIndex = -1;
  for (let i = 0; i < pendingWithRound.length; i++) {
    if (pendingWithRound[i].round <= newSongRound) {
      insertAfterIndex = i;
    }
  }

  if (insertAfterIndex === -1) {
    return pending[0].sort_order - 10;
  }
  if (insertAfterIndex === pending.length - 1) {
    return pending[pending.length - 1].sort_order + 10;
  }

  const prevOrder = pending[insertAfterIndex].sort_order;
  const nextOrder = pending[insertAfterIndex + 1].sort_order;
  return (prevOrder + nextOrder) / 2;
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
    const stats = db.prepare("SELECT AVG(score) as avg, COUNT(*) as count FROM votes WHERE queue_id = ?").get(current.id);
    currentScore = {
      avg: stats.avg ? Number(stats.avg.toFixed(1)) : 0,
      count: stats.count || 0
    };
  }

  return {
    current,
    currentScore,
    pending,
    appState,
    guestUrl: GUEST_URL
  };
}

function getRanking() {
  const rows = db.prepare(`
    SELECT 
      q.id, q.singer, q.title,
      COALESCE(AVG(v.score), 0) as avg_score,
      COUNT(v.id) as vote_count
    FROM queue q
    LEFT JOIN votes v ON q.id = v.queue_id
    WHERE q.status IN ('played', 'playing')
    GROUP BY q.id
    ORDER BY avg_score DESC, vote_count DESC
  `).all();

  return rows.map(r => ({
    ...r,
    avg_score: Number(r.avg_score.toFixed(1))
  }));
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

// Registrar o actualizar nombre evitando duplicados
app.post('/api/register-user', (req, res) => {
  const { deviceId, singer } = req.body;
  if (!deviceId || !singer || !singer.trim()) {
    return res.status(400).json({ ok: false, error: 'Ingresá un nombre válido.' });
  }

  const cleanSinger = singer.trim().slice(0, 25);
  const normSinger = cleanSinger.toLowerCase();

  // Verificar si otro dispositivo ya reservó ese nombre
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

  // Actualizar también su nombre en canciones pendientes si se lo cambió
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

  // Asegurar registro del nombre único
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

  try {
    db.prepare("INSERT INTO votes (queue_id, device_id, score) VALUES (?, ?, ?)").run(queueId, deviceId, numScore);
    io.emit('state_update', getFullState());
    res.json({ ok: true });
  } catch (err) {
    res.status(409).json({ ok: false, error: 'Ya votaste en esta canción.' });
  }
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

      case 'toggle_ranking':
        appState.showRanking = !appState.showRanking;
        io.emit('ranking_update', { show: appState.showRanking, ranking: getRanking() });
        io.emit('state_update', getFullState());
        break;

      case 'move_song': {
        const pending = getPendingQueue();
        const idx = pending.findIndex(item => item.id === data.id);
        if (idx === -1) break;

        const targetIdx = data.direction === 'up' ? idx - 1 : idx + 1;
        if (targetIdx < 0 || targetIdx >= pending.length) break;

        // Intercambiar en el array y renumerar limpiamente todos los sort_order
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
        io.emit('ranking_update', { show: false, ranking: [] });
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