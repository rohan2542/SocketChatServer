#!/usr/bin/env node

const net = require('net');

const PORT = process.env.PORT || 4000;
const IDLE_TIMEOUT_MS = 60000;

const clients = new Map();
const socketData = new Map();

function sendToSocket(socket, message) {
  try {
    socket.write(message + '\n');
  } catch (err) {
    console.error('[ERROR] Failed to send message:', err.message);
  }
}

function broadcast(message, excludeSocket = null) {
  for (const [username, socket] of clients.entries()) {
    if (socket !== excludeSocket) {
      sendToSocket(socket, message);
    }
  }
}

function sendPrivateMessage(fromUsername, toUsername, text) {
  const recipientSocket = clients.get(toUsername);
  
  if (!recipientSocket) {
    return false;
  }
  
  sendToSocket(recipientSocket, `DM ${fromUsername} ${text}`);
  return true;
}

function updateActivity(socket) {
  const data = socketData.get(socket);
  if (data) {
    data.lastActivity = Date.now();
  }
}

function removeUser(socket, notify = true) {
  const data = socketData.get(socket);
  
  if (data && data.username) {
    const username = data.username;
    clients.delete(username);
    
    if (notify) {
      broadcast(`INFO ${username} disconnected`);
      console.log(`[DISCONNECT] ${username}`);
    }
  }
  
  socketData.delete(socket);
}

function isValidUsername(username) {
  return username && 
         username.length > 0 && 
         username.length <= 20 &&
         /^[a-zA-Z0-9_-]+$/.test(username);
}

function handleLogin(socket, username) {
  const data = socketData.get(socket);
  
  if (data.username) {
    sendToSocket(socket, 'ERR already-logged-in');
    return;
  }
  
  if (!isValidUsername(username)) {
    sendToSocket(socket, 'ERR invalid-username');
    return;
  }
  
  if (clients.has(username)) {
    sendToSocket(socket, 'ERR username-taken');
    return;
  }
  
  data.username = username;
  clients.set(username, socket);
  
  sendToSocket(socket, 'OK');
  broadcast(`INFO ${username} joined`, socket);
  
  console.log(`[LOGIN] ${username} from ${socket.remoteAddress}:${socket.remotePort}`);
}

function handleMessage(socket, text) {
  const data = socketData.get(socket);
  
  if (!data.username) {
    sendToSocket(socket, 'ERR not-logged-in');
    return;
  }
  
  if (!text || text.trim().length === 0) {
    sendToSocket(socket, 'ERR empty-message');
    return;
  }
  
  const message = `MSG ${data.username} ${text.trim()}`;
  broadcast(message);
  
  console.log(`[MSG] ${data.username}: ${text.trim()}`);
}

function handleWho(socket) {
  const data = socketData.get(socket);
  
  if (!data.username) {
    sendToSocket(socket, 'ERR not-logged-in');
    return;
  }
  
  const usernames = Array.from(clients.keys());
  
  if (usernames.length === 0) {
    sendToSocket(socket, 'INFO no-users');
    return;
  }
  
  usernames.forEach(username => {
    sendToSocket(socket, `USER ${username}`);
  });
  
  console.log(`[WHO] ${data.username} requested user list`);
}

function handleDirectMessage(socket, targetUsername, text) {
  const data = socketData.get(socket);
  
  if (!data.username) {
    sendToSocket(socket, 'ERR not-logged-in');
    return;
  }
  
  if (!targetUsername || !text) {
    sendToSocket(socket, 'ERR invalid-dm-format');
    return;
  }
  
  if (targetUsername === data.username) {
    sendToSocket(socket, 'ERR cannot-dm-self');
    return;
  }
  
  const success = sendPrivateMessage(data.username, targetUsername, text.trim());
  
  if (success) {
    sendToSocket(socket, `DM-SENT ${targetUsername}`);
    console.log(`[DM] ${data.username} -> ${targetUsername}: ${text.trim()}`);
  } else {
    sendToSocket(socket, 'ERR user-not-found');
  }
}

function handlePing(socket) {
  sendToSocket(socket, 'PONG');
}

function processCommand(socket, line) {
  const trimmedLine = line.trim();
  
  if (!trimmedLine) {
    return;
  }
  
  updateActivity(socket);
  
  const parts = trimmedLine.split(' ');
  const command = parts[0].toUpperCase();
  
  switch (command) {
    case 'LOGIN':
      if (parts.length < 2) {
        sendToSocket(socket, 'ERR missing-username');
      } else {
        handleLogin(socket, parts[1]);
      }
      break;
      
    case 'MSG':
      if (parts.length < 2) {
        sendToSocket(socket, 'ERR empty-message');
      } else {
        const text = parts.slice(1).join(' ');
        handleMessage(socket, text);
      }
      break;
      
    case 'WHO':
      handleWho(socket);
      break;
      
    case 'DM':
      if (parts.length < 3) {
        sendToSocket(socket, 'ERR invalid-dm-format');
      } else {
        const targetUsername = parts[1];
        const text = parts.slice(2).join(' ');
        handleDirectMessage(socket, targetUsername, text);
      }
      break;
      
    case 'PING':
      handlePing(socket);
      break;
      
    default:
      sendToSocket(socket, `ERR unknown-command: ${command}`);
      break;
  }
}

function handleConnection(socket) {
  const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`[CONNECT] New connection from ${clientId}`);
  
  socketData.set(socket, {
    username: null,
    lastActivity: Date.now(),
    buffer: ''
  });
  
  const timeoutId = setInterval(() => {
    const data = socketData.get(socket);
    if (!data) {
      clearInterval(timeoutId);
      return;
    }
    
    const idleTime = Date.now() - data.lastActivity;
    
    if (idleTime > IDLE_TIMEOUT_MS) {
      console.log(`[TIMEOUT] ${data.username || clientId} idle for ${idleTime}ms`);
      sendToSocket(socket, 'ERR idle-timeout');
      removeUser(socket);
      socket.destroy();
      clearInterval(timeoutId);
    }
  }, 10000);
  
  socket.on('data', (chunk) => {
    const data = socketData.get(socket);
    if (!data) return;
    
    data.buffer += chunk.toString('utf8');
    
    let newlineIndex;
    while ((newlineIndex = data.buffer.indexOf('\n')) !== -1) {
      const line = data.buffer.substring(0, newlineIndex);
      data.buffer = data.buffer.substring(newlineIndex + 1);
      
      processCommand(socket, line);
    }
    
    if (data.buffer.length > 4096) {
      sendToSocket(socket, 'ERR message-too-long');
      data.buffer = '';
    }
  });
  
  socket.on('end', () => {
    clearInterval(timeoutId);
    removeUser(socket);
  });
  
  socket.on('error', (err) => {
    console.error(`[ERROR] ${clientId}:`, err.message);
    clearInterval(timeoutId);
    removeUser(socket, false);
  });
}

function startServer() {
  const server = net.createServer(handleConnection);
  
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[ERROR] Port ${PORT} is already in use`);
      process.exit(1);
    } else {
      console.error('[ERROR] Server error:', err.message);
    }
  });
  
  server.listen(PORT, () => {
    console.log('╔════════════════════════════════════════╗');
    console.log('║   Simple Socket Chat Server           ║');
    console.log('╚════════════════════════════════════════╝');
    console.log(`[SERVER] Listening on port ${PORT}`);
    console.log(`[INFO] Max idle time: ${IDLE_TIMEOUT_MS / 1000}s`);
    console.log(`[INFO] Connect using: nc localhost ${PORT}`);
    console.log('');
  });
  
  process.on('SIGINT', () => {
    console.log('\n[SHUTDOWN] Closing server...');
    
    broadcast('INFO server-shutting-down');
    
    for (const socket of socketData.keys()) {
      socket.destroy();
    }
    
    server.close(() => {
      console.log('[SHUTDOWN] Server closed');
      process.exit(0);
    });
  });
}

startServer();
