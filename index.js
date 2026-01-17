import { createClient } from 'bedrock-protocol';
import dotenv from 'dotenv';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

dotenv.config();

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

// Bot configuration — AINOA MUUTETTU KOHTA
const BOT_CONFIG = {
  host: process.env.HOST,
  port: Number(process.env.PORT),
  username: process.env.EMAIL,
  offline: false,
  version: '1.21.111'
};

const PORT = process.env.PORT || 3000;

let client;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 50;
let isFollowing = false;
let followTarget = null;
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

// Socket.IO connection
io.on('connection', (socket) => {
  console.log('[WEB] Client connected to dashboard');
  socket.emit('stats', botStats);
  
  socket.on('disconnect', () => {
    console.log('[WEB] Client disconnected from dashboard');
  });
});

// Update stats and broadcast
function updateStats() {
  const usage = process.memoryUsage();
  botStats.memory = (usage.heapUsed / 1024 / 1024).toFixed(2);
  botStats.following = isFollowing;
  botStats.reconnectAttempts = reconnectAttempts;
  botStats.lastUpdate = Date.now();
  
  io.emit('stats', botStats);
}

setInterval(updateStats, 1000);

// Bot functions
function createBedrockBot() {
  console.log(`[BEDROCK] Connecting to server (Attempt ${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS})...`);
  
  botStats.status = 'Connecting...';
  updateStats();
  
  try {
    client = createClient(BOT_CONFIG);
    
    client.on('join', () => {
      console.log('[SUCCESS] Bot joined the server!');
      reconnectAttempts = 0;
      botStats.status = 'Connected';
      botStats.uptime = Date.now();
      updateStats();
      
      startAFKMovement();
      
      setTimeout(() => {
        sendChat('Bot active!');
      }, 2000);
    });
    
    client.on('spawn', () => {
      console.log('[SPAWN] Bot spawned in world');
      botStats.status = 'In-Game';
      updateStats();
    });
    
    client.on('text', (packet) => {
      if (packet.type === 'chat' && packet.message) {
        console.log(`[CHAT] ${packet.message}`);
        
        botStats.chatMessages.unshift({
          message: packet.message,
          timestamp: new Date().toLocaleTimeString()
        });
        
        if (botStats.chatMessages.length > 50) {
          botStats.chatMessages = botStats.chatMessages.slice(0, 50);
        }
        
        io.emit('chat', botStats.chatMessages);
      }
    });
    
    client.on('error', (err) => {
      console.error('[ERROR]', err.message || err.code);
      botStats.status = 'Error: ' + (err.message || err.code);
      updateStats();
    });
    
    client.on('disconnect', (packet) => {
      console.log('[DISCONNECT]', packet?.message || 'Connection closed');
      botStats.status = 'Disconnected';
      updateStats();
      stopFollowing();
      handleReconnect();
    });
    
    client.on('close', () => {
      console.log('[CLOSE] Connection closed');
      botStats.status = 'Disconnected';
      updateStats();
      handleReconnect();
    });
    
  } catch (err) {
    console.error('[FATAL]', err.message);
    botStats.status = 'Fatal Error';
    updateStats();
    handleReconnect();
  }
}

function sendChat(message) {
  try {
    if (client && client.queue) {
      client.queue('text', {
        type: 'chat',
        needs_translation: false,
        source_name: client.username,
        message: message,
        xuid: '',
        platform_chat_id: ''
      });
    }
  } catch (err) {
    console.error('[CHAT ERROR]', err.message);
  }
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
    } catch (err) {
      console.error('[MOVEMENT ERROR]', err.message);
    }
  }, Math.random() * 15000 + 45000);
  
  client.once('close', () => {
    if (moveInterval) clearInterval(moveInterval);
  });
}

function stopFollowing() {
  if (!isFollowing) return;
  isFollowing = false;
  followTarget = null;
  console.log('[FOLLOW] Stopped following');
  updateStats();
}

function handleReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.log('[FATAL] Max reconnection attempts reached.');
    botStats.status = 'Stopped';
    updateStats();
    return;
  }
  
  reconnectAttempts++;
  const delay = Math.min(reconnectAttempts * 5000, 60000);
  
  console.log(`[RECONNECT] Retrying in ${delay / 1000} seconds...`);
  botStats.status = `Reconnecting in ${delay / 1000}s...`;
  updateStats();
  
  setTimeout(() => {
    createBedrockBot();
  }, delay);
}

// Start server
httpServer.listen(PORT, () => {
  console.log(`[WEB] Dashboard running at http://localhost:${PORT}`);
  console.log('[STARTUP] Bot starting up...');
  createBedrockBot();
});

process.on('SIGINT', () => {
  console.log('[SHUTDOWN] Shutting down gracefully...');
  if (client) client.close();
  httpServer.close();
  process.exit(0);
});
