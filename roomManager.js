extends Node
# Autoload name: NetworkManager
#
# FULLY SERVER-AUTHORITATIVE client connector.
# No P2P, no WebRTC, no host migration — the dedicated relay server
# (server.js, running on Render.com) owns all room/player state and
# forwards every message between clients. This script:
#   1. Connects to that server over a raw WebSocket (wss://...)
#   2. Sends/receives plain JSON messages matching the server's protocol
#      (create_room / join_room / find_match / cancel_matchmaking /
#      send / broadcast / leave_room)
#   3. Emits signals the UI/game layer can react to
#
# Two ways to get into a room:
#   - Manual: create_room(mode, name) / join_room(code, name) with a
#     room code, for private lobbies with friends.
#   - Matchmaking: find_match(mode, name) — queues the player on the
#     server and auto-assembles a room once enough players are waiting
#     for that mode. Quick-fill (join order) for now; a `rating` param
#     is already wired through so skill-based matching can be added on
#     the server later without changing this client.
#
# NOTE: this uses the low-level WebSocketPeer, NOT WebSocketMultiplayerPeer.
# WebSocketMultiplayerPeer implements Godot's own multiplayer/RPC wire
# protocol, which requires a Godot peer on the other end. Our server is a
# plain Node.js `ws` server exchanging hand-rolled JSON, so RPCs
# (rpc_id / @rpc) cannot be used here — all communication goes through
# send_data() / receive signals below instead.

signal connected_to_server
signal connection_failed
signal disconnected_from_server

signal room_created(room_code: String, player_id: int, mode: String, max_players: int)
signal room_joined(room_code: String, player_id: int, mode: String, max_players: int, existing_players: Array)
signal player_joined(player_id: int, player_name: String)
signal player_left(player_id: int)
signal data_received(from_player_id: int, data: Variant)
signal error_received(message: String)

# --- Matchmaking signals ---
# Emitted right after find_match() sends the request (queue entered).
signal matchmaking_started(mode: String)
# Emitted periodically while queued so the UI can show e.g. "2/4 players found".
signal searching_update(players_found: int, players_needed: int, queue_position: int)
# Emitted once a full room is auto-assembled. `players` is every OTHER
# player in the match: [{playerId, playerName}, ...] (mirrors room_joined's existing_players).
signal match_found(room_code: String, player_id: int, mode: String, max_players: int, players: Array)
# Emitted if matchmaking ends without a match: reason is "timeout"
# (server gave up waiting — return the player to the menu),
# "cancelled_by_user" (they called cancel_matchmaking()), or
# "requeued" (they started searching a different mode before this one filled).
signal matchmaking_cancelled(reason: String)

# Change this to your real Render URL once deployed, e.g.:
# "wss://godot-game-server.onrender.com"
const SERVER_URL := "wss://godot-signaling-server-19c9.onrender.com"

var socket := WebSocketPeer.new()
var my_id: int = -1
var current_room_code: String = ""
var current_mode: String = ""

var _last_state := WebSocketPeer.STATE_CLOSED

func _process(_delta: float) -> void:
	if socket.get_ready_state() != WebSocketPeer.STATE_CONNECTING and socket.get_ready_state() != WebSocketPeer.STATE_OPEN and socket.get_ready_state() != WebSocketPeer.STATE_CLOSING:
		if socket.get_ready_state() == WebSocketPeer.STATE_CLOSED and _last_state != WebSocketPeer.STATE_CLOSED:
			_on_state_closed()
		return

	socket.poll()
	var state := socket.get_ready_state()

	if state != _last_state:
		if state == WebSocketPeer.STATE_OPEN:
			_on_connected()
		elif state == WebSocketPeer.STATE_CLOSED:
			_on_state_closed()
		_last_state = state

	if state == WebSocketPeer.STATE_OPEN:
		while socket.get_available_packet_count() > 0:
			var packet := socket.get_packet()
			_handle_message(packet.get_string_from_utf8())

func connect_to_server(url: String = SERVER_URL) -> void:
	var err := socket.connect_to_url(url)
	if err != OK:
		push_error("NetworkManager: failed to start connection (error %d)" % err)
		connection_failed.emit()
		return
	_last_state = WebSocketPeer.STATE_CONNECTING

func _on_connected() -> void:
	print("NetworkManager: connected to server")
	connected_to_server.emit()

func _on_state_closed() -> void:
	var code := socket.get_close_code()
	print("NetworkManager: connection closed (code %d)" % code)
	if my_id == -1:
		connection_failed.emit()
	else:
		disconnected_from_server.emit()
	my_id = -1
	current_room_code = ""
	current_mode = ""

func is_connected_to_server() -> bool:
	return socket.get_ready_state() == WebSocketPeer.STATE_OPEN

func get_my_id() -> int:
	return my_id

func _send(msg: Dictionary) -> void:
	if not is_connected_to_server():
		push_warning("NetworkManager: tried to send while not connected")
		return
	socket.send_text(JSON.stringify(msg))

# --- Public API used by UI (mode-select screen etc.) ---

func create_room(mode: String, player_name: String) -> void:
	current_mode = mode
	_send({"type": "create_room", "mode": mode, "playerName": player_name})

func join_room(room_code: String, player_name: String) -> void:
	_send({"type": "join_room", "roomCode": room_code, "playerName": player_name})

func send_to_player(target_player_id: int, data: Variant) -> void:
	_send({"type": "send", "target": target_player_id, "data": data})

func broadcast(data: Variant) -> void:
	_send({"type": "broadcast", "data": data})

func leave_room() -> void:
	if current_room_code != "":
		_send({"type": "leave_room"})
	current_room_code = ""
	current_mode = ""

# Enter the matchmaking queue for `mode`. Listen for searching_update
# (progress), match_found (success), and matchmaking_cancelled (timeout
# or user cancel) to drive your "Finding Match..." screen.
#
# `rating` is unused by the server today (quick-fill/FIFO matching) but
# is sent along so skill-based matching can be turned on server-side
# later with no client changes.
func find_match(mode: String, player_name: String, rating: float = 1000.0) -> void:
	current_mode = mode
	_send({"type": "find_match", "mode": mode, "playerName": player_name, "rating": rating})
	matchmaking_started.emit(mode)

# Leave the matchmaking queue before a match has been found.
func cancel_matchmaking() -> void:
	_send({"type": "cancel_matchmaking"})

# --- Incoming message handling ---

func _handle_message(raw: String) -> void:
	var parsed = JSON.parse_string(raw)
	if parsed == null or typeof(parsed) != TYPE_DICTIONARY:
		push_warning("NetworkManager: received malformed message: %s" % raw)
		return

	match parsed.get("type", ""):
		"room_created":
			current_room_code = parsed["roomCode"]
			my_id = parsed["playerId"]
			room_created.emit(parsed["roomCode"], parsed["playerId"], parsed["mode"], parsed["maxPlayers"])

		"room_joined":
			current_room_code = parsed["roomCode"]
			my_id = parsed["playerId"]
			room_joined.emit(
				parsed["roomCode"],
				parsed["playerId"],
				parsed["mode"],
				parsed["maxPlayers"],
				parsed.get("existingPlayers", [])
			)

		"player_joined":
			player_joined.emit(parsed["playerId"], parsed.get("playerName", "Player"))

		"player_left":
			player_left.emit(parsed["playerId"])

		"searching":
			searching_update.emit(
				parsed.get("playersFound", 0),
				parsed.get("playersNeeded", 0),
				parsed.get("queuePosition", 0)
			)

		"match_found":
			current_room_code = parsed["roomCode"]
			my_id = parsed["playerId"]
			match_found.emit(
				parsed["roomCode"],
				parsed["playerId"],
				parsed["mode"],
				parsed["maxPlayers"],
				parsed.get("players", [])
			)

		"matchmaking_cancelled":
			current_mode = ""
			matchmaking_cancelled.emit(parsed.get("reason", ""))

		"data":
			data_received.emit(parsed["from"], parsed.get("data"))

		"error":
			push_warning("NetworkManager: server error: %s" % parsed.get("message", ""))
			error_received.emit(parsed.get("message", ""))

		_:
			push_warning("NetworkManager: unknown message type: %s" % raw)
