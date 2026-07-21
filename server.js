// server.js — the "referee" for the game.
// It keeps the ONE true copy of the board, decides whose turn it is,
// and tells every connected browser what just happened.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve the HTML/CSS/JS files inside the "public" folder to anyone who visits
app.use(express.static('public'));

// ---- Game state lives here, on the server, not in the browser ----
const winPatterns = [
  [0,1,2],[3,4,5],[6,7,8],
  [0,3,6],[1,4,7],[2,5,8],
  [0,4,8],[2,4,6]
];

function freshGame() {
  return {
    board: Array(9).fill(null),
    currentPlayer: 'X',
    gameOver: false,
    winner: null,
    winLine: null,
    players: {}   // maps socket.id -> 'X' or 'O'
  };
}

let game = freshGame();

function checkWinner(board) {
  for (const [a, b, c] of winPatterns) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a], line: [a, b, c] };
    }
  }
  return null;
}

// Sends the current game state to everyone connected
function broadcastState() {
  io.emit('state', game);
}

io.on('connection', (socket) => {
  console.log('A player connected:', socket.id);

  const assignedX = Object.values(game.players).includes('X');
  const assignedO = Object.values(game.players).includes('O');

  let role = 'spectator';
  if (!assignedX) {
    role = 'X';
  } else if (!assignedO) {
    role = 'O';
  }

  if (role !== 'spectator') {
    game.players[socket.id] = role;
  }

  socket.emit('assigned', role);
  socket.emit('state', game);

  socket.on('makeMove', (cellIndex) => {
    const playerRole = game.players[socket.id];

    if (!playerRole) return;
    if (game.gameOver) return;
    if (playerRole !== game.currentPlayer) return;
    if (game.board[cellIndex]) return;
    if (cellIndex < 0 || cellIndex > 8) return;

    game.board[cellIndex] = playerRole;

    const winInfo = checkWinner(game.board);
    if (winInfo) {
      game.gameOver = true;
      game.winner = winInfo.winner;
      game.winLine = winInfo.line;
    } else if (game.board.every(c => c)) {
      game.gameOver = true;
      game.winner = null;
    } else {
      game.currentPlayer = game.currentPlayer === 'X' ? 'O' : 'X';
    }

    broadcastState();
  });

  socket.on('requestReset', () => {
    game = freshGame();
    broadcastState();
  });

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    delete game.players[socket.id];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
