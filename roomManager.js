// roomManager.js
// Tracks rooms (lobbies), their mode/capacity, and connected peers.
// Assigns each peer a unique, ever-increasing integer ID per room
// (required by Godot's WebRTCMultiplayerPeer, and used client-side as the
// deterministic host-migration key: lowest connected ID = host).

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
    this.players = new Map(); // peerId -> { ws, playerName }
    this.nextPeerId = 1;
  }

  addPlayer(playerName, ws) {
    const peerId = this.nextPeerId++;
    this.players.set(peerId, { ws, playerName });
    return peerId;
  }

  removePlayer(peerId) {
    this.players.delete(peerId);
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
    const peerId = room.addPlayer(playerName, ws);
    this.rooms.set(code, room);

    return { ok: true, roomCode: code, peerId, mode, maxPlayers: room.maxPlayers };
  }

  joinRoom(roomCode, playerName, ws) {
    const room = this.rooms.get(roomCode);
    if (!room) return { ok: false, error: 'Room not found' };
    if (room.isFull()) return { ok: false, error: 'Room is full' };

    const existingPeers = Array.from(room.players.entries()).map(([id, p]) => ({
      peerId: id,
      playerName: p.playerName,
    }));

    const peerId = room.addPlayer(playerName, ws);

    return {
      ok: true,
      roomCode,
      peerId,
      mode: room.mode,
      maxPlayers: room.maxPlayers,
      existingPeers,
    };
  }

  removePeer(roomCode, peerId) {
    const room = this.rooms.get(roomCode);
    if (!room) return;
    room.removePlayer(peerId);
    if (room.isEmpty()) {
      this.rooms.delete(roomCode);
    }
  }

  relaySignal(roomCode, fromPeerId, targetPeerId, data) {
    const room = this.rooms.get(roomCode);
    if (!room) return;
    const target = room.players.get(targetPeerId);
    if (!target) return;
    if (target.ws.readyState === WebSocket.OPEN) {
      target.ws.send(JSON.stringify({ type: 'signal', from: fromPeerId, data }));
    }
  }

  broadcastExcept(roomCode, exceptPeerId, msg) {
    const room = this.rooms.get(roomCode);
    if (!room) return;
    const raw = JSON.stringify(msg);
    for (const [id, p] of room.players) {
      if (id !== exceptPeerId && p.ws.readyState === WebSocket.OPEN) {
        p.ws.send(raw);
      }
    }
  }
}

module.exports = { RoomManager, MODE_CAPACITY };
