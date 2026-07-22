'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const RATINGS_FILE = path.join(__dirname, 'ratings.json');
const MAX_ROOM_PLAYERS = 8;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: false },
  maxHttpBufferSize: 100_000,
});

app.use(express.static(PUBLIC_DIR));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

function loadRatings() {
  try {
    return JSON.parse(fs.readFileSync(RATINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

let ratings = loadRatings();
const profiles = new Map();
const rooms = new Map();

function saveRatings() {
  const temp = `${RATINGS_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(ratings, null, 2), 'utf8');
  fs.renameSync(temp, RATINGS_FILE);
}

function cleanName(value) {
  const name = String(value || 'Miner')
    .replace(/[<>\r\n]/g, '')
    .trim()
    .slice(0, 20);
  return name || 'Miner';
}

function cleanText(value) {
  return String(value || '')
    .replace(/[<>\r\n]/g, '')
    .trim()
    .slice(0, 160);
}

function ratingKey(name) {
  return cleanName(name).toLocaleLowerCase('ja-JP');
}

function getRating(name) {
  const key = ratingKey(name);
  if (!ratings[key]) ratings[key] = { name: cleanName(name), rating: 1000, games: 0 };
  return ratings[key];
}

function profileFor(socket) {
  if (!profiles.has(socket.id)) {
    const name = `Miner-${socket.id.slice(0, 4)}`;
    const record = getRating(name);
    profiles.set(socket.id, { name, rating: record.rating, games: record.games, roomCode: null });
  }
  return profiles.get(socket.id);
}

function createRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 200; attempt += 1) {
    let code = '';
    for (let i = 0; i < 6; i += 1) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    if (!rooms.has(code)) return code;
  }
  throw new Error('room code exhaustion');
}

function publicRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    npcCount: room.npcCount || 0,
    aiDifficulty: room.aiDifficulty || 3,
    players: [...room.playerIds]
      .map((socketId) => {
        const profile = profiles.get(socketId);
        return profile ? { id: socketId, name: profile.name, rating: profile.rating, games: profile.games } : null;
      })
      .filter(Boolean),
  };
}

function emitRoom(room) {
  io.to(room.code).emit('room_state', publicRoom(room));
}

function leaveRoom(socket, announce = true) {
  const profile = profileFor(socket);
  const code = profile.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  profile.roomCode = null;
  socket.leave(code);
  if (!room) return;

  room.playerIds.delete(socket.id);
  if (room.playerIds.size === 0) {
    rooms.delete(code);
    return;
  }
  if (room.hostId === socket.id) room.hostId = room.playerIds.values().next().value;
  if (announce) io.to(code).emit('system_message', { text: `${profile.name} が退出しました。` });
  emitRoom(room);
}

io.on('connection', (socket) => {
  const profile = profileFor(socket);
  socket.emit('profile', { name: profile.name, rating: profile.rating, games: profile.games });

  socket.on('set_profile', (payload = {}) => {
    const nextName = cleanName(payload.name);
    profile.name = nextName;
    const record = getRating(nextName);
    profile.rating = record.rating;
    profile.games = record.games;
    socket.emit('profile', { name: profile.name, rating: profile.rating, games: profile.games });
    if (profile.roomCode) {
      const room = rooms.get(profile.roomCode);
      if (room) emitRoom(room);
    }
  });

  socket.on('create_room', (payload = {}) => {
    leaveRoom(socket, false);
    profile.name = cleanName(payload.name || profile.name);
    const record = getRating(profile.name);
    profile.rating = record.rating;
    profile.games = record.games;
    const code = createRoomCode();
    const room = { code, hostId: socket.id, playerIds: new Set([socket.id]), started: false, npcCount: 3, aiDifficulty: 3 };
    rooms.set(code, room);
    profile.roomCode = code;
    socket.join(code);
    emitRoom(room);
    socket.emit('system_message', { text: `ルーム ${code} を作成しました。` });
  });

  socket.on('join_room', (payload = {}) => {
    const code = String(payload.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    const room = rooms.get(code);
    if (!room) return socket.emit('system_message', { text: 'そのルームは存在しません。' });
    if (room.started) return socket.emit('system_message', { text: 'そのルームは対戦中です。' });
    if (room.playerIds.size >= MAX_ROOM_PLAYERS) return socket.emit('system_message', { text: 'ルームが満員です。' });

    leaveRoom(socket, false);
    profile.name = cleanName(payload.name || profile.name);
    const record = getRating(profile.name);
    profile.rating = record.rating;
    profile.games = record.games;
    profile.roomCode = code;
    room.playerIds.add(socket.id);
    room.npcCount = Math.min(room.npcCount || 0, Math.max(0, MAX_ROOM_PLAYERS - room.playerIds.size));
    socket.join(code);
    io.to(code).emit('system_message', { text: `${profile.name} が参加しました。` });
    emitRoom(room);
  });

  socket.on('leave_room', () => leaveRoom(socket));

  socket.on('send_chat', (payload = {}) => {
    const text = cleanText(payload.text);
    if (!text || !profile.roomCode) return;
    io.to(profile.roomCode).emit('chat_message', { name: profile.name, text, at: Date.now() });
  });

  socket.on('set_room_config', (config = {}) => {
    const room = profile.roomCode ? rooms.get(profile.roomCode) : null;
    if (!room || room.hostId !== socket.id || room.started) return;
    const maxNpcs = Math.max(0, MAX_ROOM_PLAYERS - room.playerIds.size);
    room.npcCount = Math.max(0, Math.min(maxNpcs, Number(config.npcCount) || 0));
    room.aiDifficulty = Math.max(1, Math.min(5, Number(config.aiDifficulty) || 3));
    emitRoom(room);
  });

  socket.on('start_match', (config = {}) => {
    const room = profile.roomCode ? rooms.get(profile.roomCode) : null;
    if (!room || room.hostId !== socket.id) return;
    const maxNpcs = Math.max(0, MAX_ROOM_PLAYERS - room.playerIds.size);
    const npcCount = Math.max(0, Math.min(maxNpcs, Number(room.npcCount) || 0));
    const totalPlayers = room.playerIds.size + npcCount;
    if (totalPlayers < 2) return socket.emit('system_message', { text: '人間とNPCを合わせて2人以上必要です。' });
    room.started = true;
    io.to(room.code).emit('online_match_start', {
      roomCode: room.code,
      hostId: room.hostId,
      config: {
        stageKey: String(config.stageKey || 'classic').slice(0, 30),
        playerCount: totalPlayers,
        npcCount,
        aiDifficulty: Math.max(1, Math.min(5, Number(room.aiDifficulty) || 3)),
      },
      players: publicRoom(room).players,
    });
  });

  socket.on('report_result', (payload = {}) => {
    const room = profile.roomCode ? rooms.get(profile.roomCode) : null;
    if (!room || room.hostId !== socket.id || !room.started) return;
    const submitted = Array.isArray(payload.results) ? payload.results : [];
    const byName = new Map(submitted.map((result) => [cleanName(result.name).toLocaleLowerCase('ja-JP'), Boolean(result.won)]));

    for (const socketId of room.playerIds) {
      const participant = profiles.get(socketId);
      if (!participant) continue;
      const won = byName.get(participant.name.toLocaleLowerCase('ja-JP')) === true;
      const record = getRating(participant.name);
      const change = won ? 16 : -12;
      record.rating = Math.max(100, record.rating + change);
      record.games += 1;
      participant.rating = record.rating;
      participant.games = record.games;
      io.to(socketId).emit('rating_update', { rating: record.rating, games: record.games, change });
    }
    saveRatings();
    room.started = false;
    io.to(room.code).emit('system_message', { text: '対戦結果を受理し、レートを更新しました。' });
    emitRoom(room);
  });

  socket.on('disconnect', () => {
    leaveRoom(socket);
    profiles.delete(socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Mine Traitor online server: http://localhost:${PORT}`);
});
