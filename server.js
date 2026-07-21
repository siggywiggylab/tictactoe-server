// server.js — the "referee" for the game.
// It keeps the true copy of every game's board, decides whose turn it is,
// runs matchmaking, and tells connected browsers what just happened.

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

// ---- Player identity: nickname + persistent ID, no passwords ----
const players = {};

// ---- Matchmaking queue: sockets waiting for an opponent ----
let queue = [];

// ---- Active games ----
const rooms = {};
const socketToRoom = {};
let nextRoomId = 1;

function freshGame(playerX, playerO) {
  return {
    board: Array(9).fill(null),
    currentPlayer: 'X',
    gameOver: false,
    winner: null,
    winLine: null,
    sockets: { X: playerX.socketId, O: playerO.socketId },
    names: { X: playerX.nickname, O: playerO.nickname }
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
    names: room.names
  });
}

function tryMatchmake() {
  while (queue.length >= 2) {
    const playerX = queue.shift();
    const playerO = queue.shift();

    const roomId = `room-${nextRoomId++}`;
    rooms[roomId] = freshGame(playerX, playerO);
    socketToRoom[playerX.socketId] = roomId;
    socketToRoom[playerO.socketId] = roomId;

    const socketX = io.sockets.sockets.get(playerX.socketId);
    const socketO = io.sockets.sockets.get(playerO.socketId);
    if (socketX) socketX.join(roomId);
    if (socketO) socketO.join(roomId);

    if (socketX) socketX.emit('matchFound', { role: 'X', opponent: playerO.nickname });
    if (socketO) socketO.emit('matchFound', { role: 'O', opponent: playerX.nickname });

    sendRoomState(roomId);
  }
}

io.on('connection', (socket) => {
  let myPersistentId = null;
  let myNickname = null;

  socket.on('identify', ({ persistentId, nickname }) => {
    myPersistentId = persistentId;
    myNickname = (nickname || 'Player').slice(0, 16);
    players[persistentId] = { nickname: myNickname };
  });

  socket.on('findMatch', () => {
    if (!myPersistentId) return;
    if (queue.some(p => p.socketId === socket.id)) return;

    queue.push({ socketId: socket.id, persistentId: myPersistentId, nickname: myNickname });
    socket.emit('queued');
    tryMatchmake();
  });

  socket.on('cancelFindMatch', () => {
    queue = queue.filter(p => p.socketId !== socket.id);
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
      room.winner = null;
    } else {
      room.currentPlayer = room.currentPlayer === 'X' ? 'O' : 'X';
    }

    sendRoomState(roomId);
  });

  socket.on('leaveRoom', () => {
    const roomId = socketToRoom[socket.id];
    if (roomId) {
      socket.leave(roomId);
      delete socketToRoom[socket.id];
      const room = rooms[roomId];
      if (room && !room.gameOver) {
        io.to(roomId).emit('opponentLeft');
      }
      const stillIn = io.sockets.adapter.rooms.get(roomId);
      if (!stillIn || stillIn.size === 0) {
        delete rooms[roomId];
      }
    }
  });

  socket.on('disconnect', () => {
    queue = queue.filter(p => p.socketId !== socket.id);

    const roomId = socketToRoom[socket.id];
    if (roomId && rooms[roomId]) {
      const room = rooms[roomId];
      if (!room.gameOver) {
        io.to(roomId).emit('opponentLeft');
      }
      delete socketToRoom[socket.id];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
