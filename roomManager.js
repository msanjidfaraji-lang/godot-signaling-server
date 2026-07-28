// roomManager.js
// Tracks rooms (lobbies), their mode/capacity, and connected players.
// This is a plain relay architecture: the server itself forwards all
// messages between players in a room. There is no WebRTC handshake and
// no peer-to-peer connection — every message goes client -> server -> client(s).
//
// Each player still gets a unique, ever-increasing integer ID per room,
// used to address messages to a specific player and to determine host
// (lowest connected ID = host, if your game needs an authoritative host).

const WebSocket = require('ws');

const MODE_CAPACITY = {
  '1v1': 2,
  '2v2': 4,
  '4v4': 8,
  '6p': 6,
  '8p': 8,
};

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
    this.maxPlayers = MODE_CAPACITY[mode];
    this.players = new Map(); // playerId -> { ws, playerName }
    this.nextPlayerId = 1;
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
    if (!MODE_CAPACITY[mode]) {
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

module.exports = { RoomManager, MODE_CAPACITY };
