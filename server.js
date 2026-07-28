// server.js
// WebSocket relay server for Godot multiplayer.
// Deploy this on Render.com as a Web Service.
//
// Every player connects to this server over WebSocket, and all game
// traffic is relayed through it: client -> server -> other client(s).
// The server is on the path for every message (fine for turn-based /
// low-rate games; for high-frequency real-time state you may want to
// throttle or batch on the client before sending).
//
// Two ways to get into a room:
//   1. Manual: create_room / join_room with a room code (unchanged).
//   2. Matchmaking: find_match with just a mode — the server queues the
//      player and auto-creates/joins a room once enough players are
//      waiting (see matchmakingManager.js). Quick-fill (FIFO) for now,
//      structured so skill-based matching can be added later.

const http = require('http');
const WebSocket = require('ws');
const { RoomManager } = require('./roomManager');
const { MatchmakingManager } = require('./matchmakingManager');

const PORT = process.env.PORT || 10000;

// Basic HTTP server so Render's health check gets a 200 response.
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Relay server is running.\n');
});

const wss = new WebSocket.Server({ server: httpServer });
const roomManager = new RoomManager();
const matchmakingManager = new MatchmakingManager(roomManager);

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

wss.on('connection', (ws) => {
  // Each connection is a candidate player until it creates/joins a room
  // (manually or via matchmaking).
  let roomCode = null;
  let playerId = null;

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
        playerId = result.playerId;
        send(ws, {
          type: 'room_created',
          roomCode,
          playerId,
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
        playerId = result.playerId;

        send(ws, {
          type: 'room_joined',
          roomCode,
          playerId,
          mode: result.mode,
          maxPlayers: result.maxPlayers,
          existingPlayers: result.existingPlayers, // [{playerId, playerName}, ...]
        });

        // Tell every existing player that a new player joined.
        roomManager.broadcastExcept(roomCode, playerId, {
          type: 'player_joined',
          playerId,
          playerName: msg.playerName || 'Player',
        });
        break;
      }

      // Enter the matchmaking queue for a mode.
      // msg = { type: 'find_match', mode, playerName, rating? }
      // The server replies with periodic 'searching' updates, then a
      // 'match_found' once a full room is assembled (this plays the same
      // role as room_created/room_joined but for every matched player
      // at once).
      case 'find_match': {
        const result = matchmakingManager.findMatch(
          ws,
          msg.mode,
          msg.playerName || 'Player',
          msg.rating,
          (matchedRoomCode, matchedPlayerId) => {
            // Wires this connection into the same roomCode/playerId
            // bookkeeping used by the manual create/join flow, so
            // send/broadcast/leave_room/close-cleanup work identically
            // for matchmade players.
            roomCode = matchedRoomCode;
            playerId = matchedPlayerId;
          }
        );
        if (!result.ok) {
          send(ws, { type: 'error', message: result.error });
        }
        break;
      }

      // Leave the matchmaking queue voluntarily (before a match is found).
      case 'cancel_matchmaking': {
        matchmakingManager.cancel(ws, 'cancelled_by_user');
        break;
      }

      // Relay an arbitrary game-data payload to ONE specific player in the room.
      // msg = { type: 'send', target: <playerId>, data: {...} }
      case 'send': {
        if (!roomCode || playerId === null) return;
        roomManager.sendToPlayer(roomCode, msg.target, {
          type: 'data',
          from: playerId,
          data: msg.data,
        });
        break;
      }

      // Relay an arbitrary game-data payload to every OTHER player in the room.
      // msg = { type: 'broadcast', data: {...} }
      case 'broadcast': {
        if (!roomCode || playerId === null) return;
        roomManager.broadcastExcept(roomCode, playerId, {
          type: 'data',
          from: playerId,
          data: msg.data,
        });
        break;
      }

      case 'leave_room': {
        if (roomCode && playerId !== null) {
          roomManager.removePlayer(roomCode, playerId);
          roomManager.broadcastExcept(roomCode, playerId, { type: 'player_left', playerId });
        }
        roomCode = null;
        playerId = null;
        break;
      }

      default:
        send(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
    }
  });

  // A match found via matchmaking sets roomCode/playerId here too (via
  // the onMatch callback above), so leave/close cleanup works the same
  // either way — no polling needed.
  ws.on('close', () => {
    matchmakingManager.cancel(ws, 'disconnected', true);
    if (roomCode && playerId !== null) {
      roomManager.removePlayer(roomCode, playerId);
      roomManager.broadcastExcept(roomCode, playerId, { type: 'player_left', playerId });
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Relay server listening on port ${PORT}`);
});
