// gameModes.js
// Single source of truth for game mode definitions — replaces the
// MODE_CAPACITY object that used to live in roomManager.js, and ports
// over the GAME_MODES dict from the old standalone GameServer.gd
// (team count + map pool per mode), now that map/team assignment
// happens here on the Node relay instead of in a Godot dedicated server.
//
// Rename note: modes are now named 1v1 / 2v2 / 4v4 / ffa_6 / ffa_8
// (matching GameServer.gd's naming) instead of the old 6p / 8p — update
// any client UI code that hardcodes those old mode strings.

const GAME_MODES = {
  '1v1':   { totalPlayers: 2, teams: 2, maps: ['duel_arena', 'duel_canyon'] },
  '2v2':   { totalPlayers: 4, teams: 2, maps: ['small_valley', 'twin_towers'] },
  '4v4':   { totalPlayers: 8, teams: 2, maps: ['big_base', 'harbor'] },
  'ffa_6': { totalPlayers: 6, teams: 6, maps: ['ffa_island'] },
  'ffa_8': { totalPlayers: 8, teams: 8, maps: ['ffa_desert'] },
};

// Block assignment: first (totalPlayers/teams) joiners -> team 0, next
// block -> team 1, etc. Requires a full, ordered roster (1..totalPlayers)
// — exactly what matchmaking produces. Mirrors GameServer.gd's _assign_teams.
function assignTeams(mode, playerIdsInOrder) {
  const { totalPlayers, teams } = GAME_MODES[mode];
  const teamSize = totalPlayers / teams;
  const teamMap = {};
  playerIdsInOrder.forEach((id, i) => {
    teamMap[id] = Math.floor(i / teamSize);
  });
  return teamMap;
}

// Round-robin assignment: works for any player count, not just a full
// roster. Used for manually-created rooms (start_match), since a private
// lobby might start with fewer than totalPlayers.
function assignTeamsRoundRobin(mode, playerIds) {
  const { teams } = GAME_MODES[mode];
  const teamMap = {};
  playerIds.forEach((id, i) => {
    teamMap[id] = i % teams;
  });
  return teamMap;
}

function pickMap(mode) {
  const maps = GAME_MODES[mode].maps;
  return maps[Math.floor(Math.random() * maps.length)];
}

module.exports = { GAME_MODES, assignTeams, assignTeamsRoundRobin, pickMap };
