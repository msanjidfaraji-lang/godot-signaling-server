// roomManager.js
// Tracks rooms (lobbies), their mode/capacity, and connected players.
// The server forwards all messages between players in a room.
//
// Each player gets a unique, ever-increasing integer ID per room,
// used to address messages to a specific player and to determine host
// (lowest connected ID = host, if your game needs an authoritative host).
//
// Mode definitions (capacity, teams, maps) live in gameModes.js — shared
// with matchmakingManager.js so manual rooms and matchmade rooms use the
// exact same mode rules.

const WebSocket = require('ws');
const { GAME_MODES } = require('./gameModes');

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

class Room {
  constructor(code, mode) {
    this.code = code;
    this.mode = mode;
    this.maxPlayers = GAME_MODES[mode].totalPlayers;
    this.players = new Map(); // playerId -> { ws, playerName }
    this.nextPlayerId = 1;
    // Populated once a match actually starts — via matchmaking
    // (matchmakingManager.js) or a manual 'start_match' (server.js).
    this.map = null;
    this.teamMap = null; // playerId -> teamIndex
  }

  addPlayer(playerName, ws) {
    const playerId = this.nextPlayerId++;
    this.players.set(playerId, { ws, playerName });
    return playerId;
  }

  removePlayer(playerId) {
    this.players.delete(playerId);
  }

  isFull() {
    return this.players.size >= this.maxPlayers;
  }

  isEmpty() {
    return this.players.size === 0;
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map(); // roomCode -> Room
  }

  createRoom(mode, playerName, ws) {
    if (!GAME_MODES[mode]) {
      return { ok: false, error: `Unknown mode: ${mode}` };
    }
    let code;
    do {
      code = generateRoomCode();
    } while (this.rooms.has(code));

    const room = new Room(code, mode);
    const playerId = room.addPlayer(playerName, ws);
    this.rooms.set(code, room);

    return { ok: true, roomCode: code, playerId, mode, maxPlayers: room.maxPlayers };
  }

  joinRoom(roomCode, playerName, ws) {
    const room = this.rooms.get(roomCode);
    if (!room) return { ok: false, error: 'Room not found' };
    if (room.isFull()) return { ok: false, error: 'Room is full' };

    const existingPlayers = Array.from(room.players.entries()).map(([id, p]) => ({
      playerId: id,
      playerName: p.playerName,
    }));

    const playerId = room.addPlayer(playerName, ws);

    return {
      ok: true,
      roomCode,
      playerId,
      mode: room.mode,
      maxPlayers: room.maxPlayers,
      existingPlayers,
    };
  }

  removePlayer(roomCode, playerId) {
    const room = this.rooms.get(roomCode);
    if (!room) return;
    room.removePlayer(playerId);
    if (room.isEmpty()) {
      this.rooms.delete(roomCode);
    }
  }

  getRoom(roomCode) {
    return this.rooms.get(roomCode);
  }

  // Send a message to one specific player in a room.
  sendToPlayer(roomCode, targetPlayerId, msg) {
    const room = this.rooms.get(roomCode);
    if (!room) return;
    const target = room.players.get(targetPlayerId);
    if (!target) return;
    if (target.ws.readyState === WebSocket.OPEN) {
      target.ws.send(JSON.stringify(msg));
    }
  }

  // Send a message to every player in a room except one (e.g. the sender).
  broadcastExcept(roomCode, exceptPlayerId, msg) {
    const room = this.rooms.get(roomCode);
    if (!room) return;
    const raw = JSON.stringify(msg);
    for (const [id, p] of room.players) {
      if (id !== exceptPlayerId && p.ws.readyState === WebSocket.OPEN) {
        p.ws.send(raw);
      }
    }
  }

  // Send a message to every player in a room, including the sender.
  broadcastAll(roomCode, msg) {
    const room = this.rooms.get(roomCode);
    if (!room) return;
    const raw = JSON.stringify(msg);
    for (const [, p] of room.players) {
      if (p.ws.readyState === WebSocket.OPEN) {
        p.ws.send(raw);
      }
    }
  }
}

module.exports = { RoomManager };
