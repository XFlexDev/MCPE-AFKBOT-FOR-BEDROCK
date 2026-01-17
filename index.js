import { createClient } from 'bedrock-protocol';
import dotenv from 'dotenv';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import dgram from 'dgram';
import https from 'https';

// ==== KEEP PROCESS ALIVE ====
process.on('uncaughtException', err => console.error('[FATAL]', err));
process.on('unhandledRejection', err => console.error('[PROMISE]', err));
setInterval(() => {}, 60000); // heartbeat

dotenv.config();

// Persistent auth
fs.mkdirSync('/data/auth', { recursive: true });
process.env.PRISMARINE_AUTH_DIR = '/data/auth';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Web
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.set('view engine', 'ejs');
app.set('views', join(__dirname, 'views'));
app.use(express.static(join(__dirname, 'public')));
app.use(express.json());

// BOT CONFIG (hardcoded)
const BOT_CONFIG = {
  host: 'play.sigmapallukka.xyz',
  port: 20465,
  username: 'SINUN_OIKEA_MICROSOFT_TILI@outlook.com',
  offline: false
};

const PORT = process.env.PORT || 3000;

// Telegram
const TELEGRAM_TOKEN = '8447340973:AAG2DVWC0KnsBlOkhRFVncXvmJo3N0LOIns';
const TELEGRAM_CHAT_ID = 'ME';
let lastTelegramAlert = 0;

function sendTelegramAlert(text) {
  const now = Date.now();
  if (now - lastTelegramAlert < 3600000) return;
  lastTelegramAlert = now;

  const data = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text });
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data)
    }
  });
  req.on('error', () => {});
  req.write(data);
  req.end();
}

let client = null;
let serverOnline = false;

let botStats = {
  status: 'Disconnected',
  uptime: 0,
  memory: 0,
  following: false,
  reconnectAttempts: 0,
  lastUpdate: Date.now(),
  chatMessages: []
};

app.get('/', (req, res) => {
  res.render('dashboard', { botConfig: BOT_CONFIG, stats: botStats });
});

io.on('connection', socket => {
  socket.emit('stats', botStats);
});

function updateStats() {
  const u = process.memoryUsage();
  botStats.memory = (u.heapUsed / 1024 / 1024).toFixed(2);
  botStats.lastUpdate = Date.now();
  io.emit('stats', botStats);
}
setInterval(updateStats, 1000);

// ==== PING WATCHDOG ====
function pingBedrock(host, port, timeout = 3000) {
  return new Promise(resolve => {
    const s = dgram.createSocket('udp4');
    const buf = Buffer.from([0x01]);
    const t = setTimeout(() => {
      s.close();
      resolve(false);
    }, timeout);

    s.send(buf, 0, buf.length, port, host, () => {});
    s.on('message', () => {
      clearTimeout(t);
      s.close();
      resolve(true);
    });
    s.on('error', () => {
      clearTimeout(t);
      s.close();
      resolve(false);
    });
  });
}

async function watchdog() {
  const alive = await pingBedrock(BOT_CONFIG.host, BOT_CONFIG.port);

  if (!alive) {
    if (serverOnline) {
      serverOnline = false;
      if (client) client.close();
      client = null;
    }
    sendTelegramAlert('Vittu servus taas räjähtäny 💔');
    return;
  }

  if (alive && !client) {
    serverOnline = true;
    createBedrockBot();
  }
}

setInterval(watchdog, 27000);

// ==== BOT CORE ====
function createBedrockBot() {
  console.log('[BEDROCK] Connecting...');
  botStats.status = 'Connecting...';
  updateStats();

  try {
    client = createClient(BOT_CONFIG);

    client.on('join', () => {
      botStats.status = 'Connected';
      botStats.uptime = Date.now();
      updateStats();
      startAFKMovement();
    });

    client.on('spawn', () => {
      botStats.status = 'In-Game';
      updateStats();
    });

    client.on('error', err => {
      botStats.status = 'Error';
      updateStats();
      console.error('[ERROR]', err);
    });

    client.on('disconnect', () => {
      botStats.status = 'Disconnected';
      updateStats();
      client = null;
    });

    client.on('close', () => {
      botStats.status = 'Disconnected';
      updateStats();
      client = null;
    });

  } catch (err) {
    console.error('[FATAL]', err);
    botStats.status = 'Fatal Error';
    updateStats();
  }
}

function startAFKMovement() {
  let moveInterval = setInterval(() => {
    if (!client || !client.entityId) return;
    try {
      client.queue('move_player', {
        runtime_id: client.entityId,
        position: {
          x: (Math.random() - 0.5) * 2,
          y: 0,
          z: (Math.random() - 0.5) * 2
        },
        pitch: Math.random() * 90 - 45,
        yaw: Math.random() * 360,
        head_yaw: Math.random() * 360,
        mode: 'normal',
        on_ground: true,
        riding_eid: 0n,
        tick: BigInt(Date.now())
      });
    } catch {}
  }, Math.random() * 15000 + 45000);

  if (client) {
    client.once('close', () => {
      if (moveInterval) clearInterval(moveInterval);
    });
  }
}

// ==== START ====
httpServer.listen(PORT, () => {
  console.log('[STARTUP] Bot starting up...');
  watchdog();
});

process.on('SIGINT', () => {
  if (client) client.close();
  httpServer.close();
  process.exit(0);
});
