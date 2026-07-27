// server.js
// WebSocket signaling server for Godot P2P (WebRTC) multiplayer.
// Deploy this on Render.com as a Web Service.
// It ONLY relays room/lobby info and WebRTC handshake data
// (offer / answer / ICE candidates). No game data ever passes through it —
// once peers connect, everything goes directly P2P.

const http = require('http');
const WebSocket = require('ws');
const { RoomManager } = require('./roomManager');

const PORT = process.env.PORT || 10000;

// Basic HTTP server so Render's health check gets a 200 response.
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Signaling server is running.\n');
});

const wss = new WebSocket.Server({ server: httpServer });
const roomManager = new RoomManager();

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

wss.on('connection', (ws) => {
  // Each connection is a candidate player until it creates/joins a room.
  let roomCode = null;
  let peerId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      send(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    switch (msg.type) {
      case 'create_room': {
        const result = roomManager.createRoom(msg.mode, msg.playerName || 'Player', ws);
        if (!result.ok) {
          send(ws, { type: 'error', message: result.error });
          return;
        }
        roomCode = result.roomCode;
        peerId = result.peerId;
        send(ws, {
          type: 'room_created',
          roomCode,
          peerId,
          mode: result.mode,
          maxPlayers: result.maxPlayers,
        });
        break;
      }

      case 'join_room': {
        const result = roomManager.joinRoom(msg.roomCode, msg.playerName || 'Player', ws);
        if (!result.ok) {
          send(ws, { type: 'error', message: result.error });
          return;
        }
        roomCode = result.roomCode;
        peerId = result.peerId;

        send(ws, {
          type: 'room_joined',
          roomCode,
          peerId,
          mode: result.mode,
          maxPlayers: result.maxPlayers,
          existingPeers: result.existingPeers, // [{peerId, playerName}, ...]
        });

        // Tell every EXISTING peer that a new peer joined, so THEY create
        // the WebRTC offer. The joiner never initiates — this avoids
        // offer/answer collisions without needing any extra coordination.
        roomManager.broadcastExcept(roomCode, peerId, {
          type: 'peer_joined',
          peerId,
          playerName: msg.playerName || 'Player',
        });
        break;
      }

      case 'signal': {
        // Relay a WebRTC offer/answer/ICE candidate to a specific peer.
        if (!roomCode || peerId === null) return;
        roomManager.relaySignal(roomCode, peerId, msg.target, msg.data);
        break;
      }

      case 'leave_room': {
        if (roomCode && peerId !== null) {
          roomManager.removePeer(roomCode, peerId);
          roomManager.broadcastExcept(roomCode, peerId, { type: 'peer_left', peerId });
        }
        roomCode = null;
        peerId = null;
        break;
      }

      default:
        send(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
    }
  });

  ws.on('close', () => {
    if (roomCode && peerId !== null) {
      roomManager.removePeer(roomCode, peerId);
      roomManager.broadcastExcept(roomCode, peerId, { type: 'peer_left', peerId });
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Signaling server listening on port ${PORT}`);
});
