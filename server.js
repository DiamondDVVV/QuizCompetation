const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { Server } = require('socket.io');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// Add this line to serve static files from public folder
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

// Also make sure your server.js reads questions from questions.json
let QUESTIONS = [];
try {
  // server.js - L:20 (Updated)
const fileContent = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'questions.json'), 'utf8'));
QUESTIONS = fileContent.questions;
} catch(e) {
  console.warn('No questions.json found in /public folder', e);
}

const PORT = process.env.PORT || 3000;
const rooms = {};

function makeCode(len=4){
  const letters = "ABCDEFGHJKMNPQRSTUVWXYZ";
  let s=''; for(let i=0;i<len;i++) s+=letters.charAt(Math.floor(Math.random()*letters.length));
  return s;
}

function createRoom(){
  let code;
  do { code = makeCode(4); } while(rooms[code]);
  rooms[code] = {
    hostId: null,
    players: {}, // socketId -> {id,name,avatar,score}
    currentQuestionIndex: -1,
    roundActive: false,
    answers: {}, // socketId -> answer index
    autoLeaderboard: false,
    autoQuestionTimer: 5
  };
  return code;
}

function evaluateAnswers(roomCode){
  const room = rooms[roomCode];
  if(!room) return {};
  const q = QUESTIONS[room.currentQuestionIndex];
  if(!q) return {};
  const correct = Number(q.correct);
  const perPlayer = {};
  for(const sid in room.answers){
    const ans = Number(room.answers[sid]);
    const p = room.players[sid];
    if(!p) continue;
    const got = (ans === correct);
    perPlayer[sid] = { id: sid, name: p.name, avatar: p.avatar||null, correct: got };
    if(got){
      p.score = (p.score||0) + (Number(q.points)||100);
    }
  }
  // clear answers for next question
  room.answers = {};
  return perPlayer;
}

io.on('connection', socket => {
  console.log('conn', socket.id);

  socket.on('createRoom', ()=>{
    const code = createRoom();
    socket.join(code);
    rooms[code].hostId = socket.id;
    socket.emit('roomCreated', { code });
    io.to(code).emit('state', rooms[code]);
  });

  socket.on('hostJoin', ({code})=>{
    if(!code || !rooms[code]) return socket.emit('errorRoom');
    socket.join(code);
    rooms[code].hostId = socket.id;
    socket.emit('hostAccepted', { code });
    io.to(code).emit('state', rooms[code]);
  });

  socket.on('playerJoin', ({code, name, avatar})=>{
    if(!code || !rooms[code]) return socket.emit('joinRejected');
    socket.join(code);
    rooms[code].players[socket.id] = { id: socket.id, name: String(name||'Player').slice(0,40), avatar: avatar||null, score:0 };
    io.to(code).emit('state', rooms[code]);
    socket.emit('joinedAck', { id: socket.id, code });
    io.to(code).emit('playSound', { name:'join' });
  });

  socket.on('startQuiz', ({code})=>{
    if(!code || !rooms[code]) return;
    if(rooms[code].hostId !== socket.id) return;
    const room = rooms[code];
    room.currentQuestionIndex = 0;
    room.roundActive = true;
    room.answers = {};
    io.to(code).emit('roundStarted', { idx: room.currentQuestionIndex });
    io.to(code).emit('state', room);
    scheduleQuestionFlow(code);
  });

  socket.on('submitAnswer', ({code, answer})=>{
    if(!code || !rooms[code]) return;
    const room = rooms[code];
    if(!room.roundActive) return socket.emit('answerRejected');
    room.answers[socket.id] = answer;
    io.to(code).emit('playerAnsweredLive', { playerId: socket.id, name: room.players[socket.id].name });
  });

  socket.on('nextQuestion', ({code})=>{
    if(!code || !rooms[code]) return;
    const room = rooms[code];
    const per = evaluateAnswers(code);
    io.to(code).emit('answerResults', { perPlayer: per });
    io.to(code).emit('scoresUpdated', { players: Object.values(room.players) });
    if(room.autoLeaderboard){
      const lb = Object.values(room.players).map(p=>({ name:p.name, score:p.score, avatar:p.avatar||null }));
      io.to(code).emit('leaderboard', { leaderboard: lb });
    }
    const qs = QUESTIONS;
    if(room.currentQuestionIndex < qs.length - 1){
      room.currentQuestionIndex++;
      room.answers = {};
      io.to(code).emit('questionChanged', { idx: room.currentQuestionIndex, question: qs[room.currentQuestionIndex], timer: room.autoQuestionTimer });
    } else {
      room.roundActive = false;
      io.to(code).emit('roundEnded');
    }
    io.to(code).emit('state', room);
  });

  socket.on('showLeaderboard', ({code})=>{
    if(!code || !rooms[code]) return;
    const room = rooms[code];
    const lb = Object.values(room.players).map(p=>({ name:p.name, score:p.score, avatar:p.avatar||null }));
    io.to(code).emit('leaderboard', { leaderboard: lb });
  });

  socket.on('hostSetPrefs', ({code, timer, autoLeaderboard})=>{
    if(!code || !rooms[code]) return;
    if(rooms[code].hostId !== socket.id) return;
    if(timer && Number(timer)>0) rooms[code].autoQuestionTimer = Number(timer);
    if(typeof autoLeaderboard === 'boolean') rooms[code].autoLeaderboard = autoLeaderboard;
    io.to(code).emit('state', rooms[code]);
  });

  socket.on('disconnect', ()=>{
    for(const code in rooms){
      if(rooms[code].players && rooms[code].players[socket.id]){
        delete rooms[code].players[socket.id];
        io.to(code).emit('state', rooms[code]);
      }
      if(rooms[code].hostId === socket.id){
        rooms[code].hostId = null;
        io.to(code).emit('hostLeft');
      }
    }
  });
});

function scheduleQuestionFlow(code){
  const room = rooms[code];
  if(!room) return;
  const qs = QUESTIONS;
  if(!qs || qs.length===0) return;
  // show first question
  io.to(code).emit('questionShown', { idx: room.currentQuestionIndex, question: qs[room.currentQuestionIndex], timer: room.autoQuestionTimer });
  // schedule iterative progression using timeouts
  const advance = ()=>{
    const per = evaluateAnswers(code);
    io.to(code).emit('answerResults', { perPlayer: per });
    io.to(code).emit('scoresUpdated', { players: Object.values(room.players) });
    if(room.autoLeaderboard){
      const lb = Object.values(room.players).map(p=>({ name:p.name, score:p.score, avatar:p.avatar||null }));
      io.to(code).emit('leaderboard', { leaderboard: lb });
    }
    if(room.currentQuestionIndex < qs.length - 1){
      room.currentQuestionIndex++;
      room.answers = {};
      io.to(code).emit('questionChanged', { idx: room.currentQuestionIndex, question: qs[room.currentQuestionIndex], timer: room.autoQuestionTimer });
      setTimeout(advance, room.autoQuestionTimer * 1000);
    } else {
      room.roundActive = false;
      io.to(code).emit('roundEnded');
      io.to(code).emit('state', room);
    }
    io.to(code).emit('state', room);
  };
  setTimeout(advance, room.autoQuestionTimer * 1000);
}

app.get('/api/questions', (req,res)=> res.json(QUESTIONS));

server.listen(PORT, ()=> console.log('Listening on', PORT));
