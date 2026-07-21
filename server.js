// server.js — the "referee" for the game.
// It keeps the true copy of every game's board, decides whose turn it is,
// runs matchmaking, tracks ELO, and tells connected browsers what just happened.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const winPatterns = [
  [0,1,2],[3,4,5],[6,7,8],
  [0,3,6],[1,4,7],[2,5,8],
  [0,4,8],[2,4,6]
];

function checkWinner(board) {
  for (const [a, b, c] of winPatterns) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a], line: [a, b, c] };
    }
  }
  return null;
}

// ---- Player identity + rating: nickname + persistent ID, no passwords ----
// key: persistentId -> { nickname, elo }
const STARTING_ELO = 1200;
const K_FACTOR = 32;
const players = {};

function getOrCreatePlayer(persistentId, nickname) {
  if (!players[persistentId]) {
    players[persistentId] = { nickname, elo: STARTING_ELO };
  } else {
    players[persistentId].nickname = nickname;
  }
  return players[persistentId];
}

// score: 1 = win, 0.5 = draw, 0 = loss
function updateElo(ratingA, ratingB, scoreA) {
  const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  const newA = Math.round(ratingA + K_FACTOR * (scoreA - expectedA));
  return newA;
}

// ---- Matchmaking queues, separate for casual and ranked ----
const queues = { casual: [], ranked: [] };

// ---- Active games ----
const rooms = {};
const socketToRoom = {};
let nextRoomId = 1;

function freshGame(mode, playerX, playerO) {
  return {
    mode,
    board: Array(9).fill(null),
    currentPlayer: 'X',
    gameOver: false,
    winner: null,     // 'X' | 'O' | null(draw) — only meaningful once gameOver
    winLine: null,
    reason: null,     // 'forfeit' if someone left/disconnected mid-game
    sockets: { X: playerX.socketId, O: playerO.socketId },
    names: { X: playerX.nickname, O: playerO.nickname },
    persistentIds: { X: playerX.persistentId, O: playerO.persistentId },
    eloChange: null   // filled in once the game ends, if ranked
  };
}

function applyEloIfRanked(room) {
  if (room.mode !== 'ranked' || room.eloChange) return;

  const pX = players[room.persistentIds.X];
  const pO = players[room.persistentIds.O];
  if (!pX || !pO) return;

  let scoreX;
  if (room.winner === 'X') scoreX = 1;
  else if (room.winner === 'O') scoreX = 0;
  else scoreX = 0.5; // draw

  const oldX = pX.elo, oldO = pO.elo;
  const newX = updateElo(oldX, oldO, scoreX);
  const newO = updateElo(oldO, oldX, 1 - scoreX);

  pX.elo = newX;
  pO.elo = newO;

  room.eloChange = {
    X: { old: oldX, new: newX },
    O: { old: oldO, new: newO }
  };
}

function sendRoomState(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  io.to(roomId).emit('state', {
    board: room.board,
    currentPlayer: room.currentPlayer,
    gameOver: room.gameOver,
    winner: room.winner,
    winLine: room.winLine,
    reason: room.reason,
    names: room.names,
    mode: room.mode,
    eloChange: room.eloChange
  });
}

function tryMatchmake(mode) {
  const queue = queues[mode];
  while (queue.length >= 2) {
    const playerX = queue.shift();
    const playerO = queue.shift();

    const roomId = `room-${nextRoomId++}`;
    rooms[roomId] = freshGame(mode, playerX, playerO);
    socketToRoom[playerX.socketId] = roomId;
    socketToRoom[playerO.socketId] = roomId;

    const socketX = io.sockets.sockets.get(playerX.socketId);
    const socketO = io.sockets.sockets.get(playerO.socketId);
    if (socketX) socketX.join(roomId);
    if (socketO) socketO.join(roomId);

    const eloX = players[playerX.persistentId].elo;
    const eloO = players[playerO.persistentId].elo;

    if (socketX) socketX.emit('matchFound', { role: 'X', opponent: playerO.nickname, mode, myElo: eloX, opponentElo: eloO });
    if (socketO) socketO.emit('matchFound', { role: 'O', opponent: playerX.nickname, mode, myElo: eloO, opponentElo: eloX });

    sendRoomState(roomId);
  }
}

function endGameAsForfeit(roomId, leavingSocketId) {
  const room = rooms[roomId];
  if (!room || room.gameOver) return;

  const leaverRole = room.sockets.X === leavingSocketId ? 'X' : room.sockets.O === leavingSocketId ? 'O' : null;
  if (!leaverRole) return;
  const winnerRole = leaverRole === 'X' ? 'O' : 'X';

  room.gameOver = true;
  room.winner = winnerRole;
  room.winLine = null;
  room.reason = 'forfeit';

  applyEloIfRanked(room);
  sendRoomState(roomId);
}

io.on('connection', (socket) => {
  let myPersistentId = null;
  let myNickname = null;

  socket.on('identify', ({ persistentId, nickname }) => {
    myPersistentId = persistentId;
    myNickname = (nickname || 'Player').slice(0, 16);
    const player = getOrCreatePlayer(myPersistentId, myNickname);
    socket.emit('identified', { nickname: player.nickname, elo: player.elo });
  });

  socket.on('findMatch', (mode) => {
    if (!myPersistentId) return;
    if (mode !== 'casual' && mode !== 'ranked') return;

    const alreadyQueued = queues.casual.some(p => p.socketId === socket.id) ||
                           queues.ranked.some(p => p.socketId === socket.id);
    if (alreadyQueued) return;

    queues[mode].push({ socketId: socket.id, persistentId: myPersistentId, nickname: myNickname });
    socket.emit('queued', { mode });
    tryMatchmake(mode);
  });

  socket.on('cancelFindMatch', () => {
    queues.casual = queues.casual.filter(p => p.socketId !== socket.id);
    queues.ranked = queues.ranked.filter(p => p.socketId !== socket.id);
  });

  socket.on('makeMove', (cellIndex) => {
    const roomId = socketToRoom[socket.id];
    const room = rooms[roomId];
    if (!room) return;

    const myRole = room.sockets.X === socket.id ? 'X' : room.sockets.O === socket.id ? 'O' : null;

    if (!myRole) return;
    if (room.gameOver) return;
    if (myRole !== room.currentPlayer) return;
    if (room.board[cellIndex]) return;
    if (cellIndex < 0 || cellIndex > 8) return;

    room.board[cellIndex] = myRole;

    const winInfo = checkWinner(room.board);
    if (winInfo) {
      room.gameOver = true;
      room.winner = winInfo.winner;
      room.winLine = winInfo.line;
    } else if (room.board.every(c => c)) {
      room.gameOver = true;
      room.winner = null; // draw
    } else {
      room.currentPlayer = room.currentPlayer === 'X' ? 'O' : 'X';
    }

    if (room.gameOver) applyEloIfRanked(room);
    sendRoomState(roomId);
  });

  socket.on('leaveRoom', () => {
    const roomId = socketToRoom[socket.id];
    if (roomId) {
      const room = rooms[roomId];
      if (room && !room.gameOver) {
        endGameAsForfeit(roomId, socket.id);
      }
      socket.leave(roomId);
      delete socketToRoom[socket.id];

      const stillIn = io.sockets.adapter.rooms.get(roomId);
      if (!stillIn || stillIn.size === 0) {
        delete rooms[roomId];
      }
    }
  });

  socket.on('disconnect', () => {
    queues.casual = queues.casual.filter(p => p.socketId !== socket.id);
    queues.ranked = queues.ranked.filter(p => p.socketId !== socket.id);

    const roomId = socketToRoom[socket.id];
    if (roomId && rooms[roomId]) {
      if (!rooms[roomId].gameOver) {
        endGameAsForfeit(roomId, socket.id);
      }
      delete socketToRoom[socket.id];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
