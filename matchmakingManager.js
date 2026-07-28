// matchmakingManager.js
// Automatic matchmaking queues, one per game mode (e.g. '1v1', '2v2', ...).
//
// STRATEGY (current): quick-fill / FIFO — the first `capacity` players
// waiting for a mode get matched together as soon as they're available.
//
// FUTURE (skill-based): every queue entry already carries a `rating`
// field (defaulted to DEFAULT_RATING if the client doesn't send one).
// To switch to skill-based matching later, you only need to change how
// `_tryFillMode()` selects a group from the queue — e.g. sort by rating
// and take the closest cluster of `capacity` size, or bucket into rating
// bands. Nothing in the wire protocol (find_match / match_found /
// matchmaking_cancelled) needs to change for that.
//
// TIMEOUT: if a queued player waits longer than QUEUE_TIMEOUT_MS without
// being matched, they are individually removed from the queue and sent
// matchmaking_cancelled with reason 'timeout' (client returns them to menu).

const WebSocket = require('ws');
const { MODE_CAPACITY } = require('./roomManager');

const DEFAULT_RATING = 1000;
const QUEUE_TIMEOUT_MS = 30000; // 30s waiting -> cancelled
const TICK_MS = 1000; // how often we check queues for fills/timeouts

class MatchmakingManager {
  constructor(roomManager) {
    this.roomManager = roomManager;
    this.queues = new Map(); // mode -> [{ ws, playerName, rating, joinedAt }]
    this._tickHandle = setInterval(() => this._tick(), TICK_MS);
  }

  // Call when the interval is no longer needed (e.g. graceful shutdown/tests).
  stop() {
    clearInterval(this._tickHandle);
  }

  // Adds a connection to the queue for `mode`. A ws can only be in one
  // queue at a time — re-queuing (e.g. picking a different mode) bumps
  // it out of whatever queue it was previously in.
  //
  // `onMatch(roomCode, playerId)`, if given, is invoked (locally, not
  // over the socket) the moment this connection gets matched — lets the
  // caller update its own per-connection bookkeeping (e.g. server.js's
  // roomCode/playerId closure vars) without polling.
  findMatch(ws, mode, playerName, rating = DEFAULT_RATING, onMatch = null) {
    if (!MODE_CAPACITY[mode]) {
      return { ok: false, error: `Unknown mode: ${mode}` };
    }
    this.cancel(ws, 'requeued');

    if (!this.queues.has(mode)) this.queues.set(mode, []);
    const queue = this.queues.get(mode);
    queue.push({ ws, playerName: playerName || 'Player', rating, joinedAt: Date.now(), onMatch });

    this._notifyQueueStatus(mode);
    this._tryFillMode(mode);
    return { ok: true };
  }

  // Removes ws from whatever queue it's in, if any. Sends
  // matchmaking_cancelled with `reason` unless silent is true (used on
  // disconnect, where there's no socket left to notify).
  cancel(ws, reason = 'cancelled_by_user', silent = false) {
    for (const [mode, queue] of this.queues) {
      const idx = queue.findIndex((e) => e.ws === ws);
      if (idx !== -1) {
        queue.splice(idx, 1);
        if (!silent) this._send(ws, { type: 'matchmaking_cancelled', reason });
        this._notifyQueueStatus(mode);
        return true;
      }
    }
    return false;
  }

  _tick() {
    const now = Date.now();
    for (const mode of this.queues.keys()) {
      const queue = this.queues.get(mode);
      for (let i = queue.length - 1; i >= 0; i--) {
        if (now - queue[i].joinedAt > QUEUE_TIMEOUT_MS) {
          const [expired] = queue.splice(i, 1);
          this._send(expired.ws, { type: 'matchmaking_cancelled', reason: 'timeout' });
        }
      }
      this._notifyQueueStatus(mode);
      this._tryFillMode(mode);
    }
  }

  _tryFillMode(mode) {
    const capacity = MODE_CAPACITY[mode];
    const queue = this.queues.get(mode);
    if (!queue) return;

    // FIFO quick-fill. Swap this line for rating-aware selection to add
    // skill-based matchmaking later.
    while (queue.length >= capacity) {
      const group = queue.splice(0, capacity);
      this._createMatch(mode, group);
    }
  }

  _createMatch(mode, group) {
    const rm = this.roomManager;
    const first = group[0];
    const created = rm.createRoom(mode, first.playerName, first.ws);
    if (!created.ok) {
      // Shouldn't happen (mode validated on entry) but fail safe.
      group.forEach((e) => this._send(e.ws, { type: 'error', message: created.error }));
      return;
    }
    const roomCode = created.roomCode;

    for (let i = 1; i < group.length; i++) {
      rm.joinRoom(roomCode, group[i].playerName, group[i].ws);
    }

    const room = rm.getRoom(roomCode);
    const roster = Array.from(room.players.entries()).map(([id, p]) => ({
      playerId: id,
      playerName: p.playerName,
    }));

    // Room player IDs are assigned 1..capacity in the same order players
    // were added, which is the same order as `group` — so group[i] got
    // playerId i+1. This lets us notify each entry's own onMatch without
    // re-searching the room for its socket.
    group.forEach((entry, i) => {
      const id = i + 1;
      if (typeof entry.onMatch === 'function') entry.onMatch(roomCode, id);
      this._send(entry.ws, {
        type: 'match_found',
        roomCode,
        playerId: id,
        mode,
        maxPlayers: room.maxPlayers,
        players: roster.filter((r) => r.playerId !== id),
      });
    });
  }

  _notifyQueueStatus(mode) {
    const capacity = MODE_CAPACITY[mode];
    const queue = this.queues.get(mode) || [];
    queue.forEach((entry, idx) => {
      this._send(entry.ws, {
        type: 'searching',
        mode,
        playersFound: queue.length,
        playersNeeded: capacity,
        queuePosition: idx + 1,
      });
    });
  }

  _send(ws, msg) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }
}

module.exports = { MatchmakingManager, DEFAULT_RATING, QUEUE_TIMEOUT_MS };
