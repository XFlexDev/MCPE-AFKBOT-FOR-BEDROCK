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

dotenv.config();

// Persistent auth dir (Fly volume)
fs.mkdirSync('/data/auth', { recursive: true });
process.env.PRISMARINE_AUTH_DIR = '/data/auth';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Express & Socket.IO setup
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.set('view engine', 'ejs');
app.set('views', join(__dirname, 'views'));
app.use(express.static(join(__dirname, 'public')));
app.use(express.json());

// Bot configuration
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
  if (now - lastTelegramAlert < 60 * 60 * 1000) return; // max kerran tunnissa
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

let client;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 50;
let isFollowing = false;
let followTarget = null;
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

// Web routes
app.get('/', (req, res) => {
  res.render('dashboard', { 
    botConfig: BOT_CONFIG,
    stats: botStats
  });
});

app.post('/api/command', (req, res) => {
  const { command } = req.body;
  
  if (!client) {
    return res.json({ success: false, message: 'Bot not connected' });
  }
  
  switch(command) {
    case 'stop':
      stopFollowing();
      res.json({ success: true, message: 'Stopped following' });
      break;
    case 'teamup':
      performTeamupGesture();
      res.json({ success: true, message: 'Performing teamup gesture' });
      break;
    case 'disconnect':
      if (client) client.close();
      res.json({ success: true, message: 'Disconnecting bot' });
      break;
    case 'reconnect':
      reconnectAttempts = 0;
      createBedrockBot();
      res.json({ success: true, message: 'Reconnecting...' });
      break;
    default:
      res.json({ success: false, message: 'Unknown command' });
  }
});

app.post('/api/chat', (req, res) => {
  const { message } = req.body;
  if (client && message) {
    sendChat(message);
    res.json({ success: true });
  } else {
    res.json({ success: false, message: 'Bot not connected or no message' });
  }
});

io.on('connection', (socket) => {
  socket.emit('stats', botStats);
});

function updateStats() {
  const usage = process.memoryUsage();
  botStats.memory = (usage.heapUsed / 1024 / 1024).toFixed(2);
  botStats.following = isFollowing;
  botStats.reconnectAttempts = reconnectAttempts;
  botStats.lastUpdate = Date.now();
  io.emit('stats', botStats);
}

setInterval(updateStats, 1000);

// --- Bedrock ping watchdog ---

function pingBedrock(host, port, timeout = 3000) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const buf = Buffer.from([0x01]);

    const timer = setTimeout(() => {
      socket.close();
      resolve(false);
    }, timeout);

    socket.send(buf, 0, buf.length, port, host, () => {});
    socket.on('message', () => {
      clearTimeout(timer);
      socket.close();
      resolve(true);
    });
    socket.on('error', () => {
      clearTimeout(timer);
      socket.close();
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

// 3 minuutin välein
setInterval(watchdog, 180_000);

// --- Bot core ---

function createBedrockBot() {
  console.log('[BEDROCK] Connecting...');
  botStats.status = 'Connecting...';
  updateStats();

  try {
    client = createClient(BOT_CONFIG);

    client.on('join', () => {
      reconnectAttempts = 0;
      botStats.status = 'Connected';
      botStats.uptime = Date.now();
      updateStats();
      startAFKMovement();
    });

    client.on('spawn', () => {
      botStats.status = 'In-Game';
      updateStats();
    });

    client.on('error', (err) => {
      botStats.status = 'Error';
      updateStats();
    });

    client.on('disconnect', () => {
      botStats.status = 'Disconnected';
      updateStats();
      stopFollowing();
      client = null;
    });

    client.on('close', () => {
      botStats.status = 'Disconnected';
      updateStats();
      client = null;
    });

  } catch (err) {
    botStats.status = 'Fatal Error';
    updateStats();
  }
}

function sendChat(message) {
  try {
    if (!client || !client.queue) return;
    if (typeof message !== 'string' || message.length === 0) return;

    client.queue('text', {
      type: 'chat',
      needs_translation: false,
      source_name: client.username,
      message: String(message),
      xuid: '',
      platform_chat_id: ''
    });
  } catch (_) {}
}

function startAFKMovement() {
  let moveInterval = setInterval(() => {
    if (!client || !client.entityId || isFollowing) return;

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
    } catch (_) {}
  }, Math.random() * 15000 + 45000);

  if (client) {
    client.once('close', () => {
      if (moveInterval) clearInterval(moveInterval);
    });
  }
}

function stopFollowing() {
  if (!isFollowing) return;
  isFollowing = false;
  followTarget = null;
  updateStats();
}

// Start server
httpServer.listen(PORT, () => {
  console.log('[STARTUP] Bot starting up...');
  watchdog();
});

process.on('SIGINT', () => {
  if (client) client.close();
  httpServer.close();
  process.exit(0);
});
