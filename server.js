const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = socketIo(server);

const games = {}; // Stores game state
const disconnectTimers = {}; // Stores disconnect cleanup timers
const gameTimers = {}; // Stores question timers for each game (includes setInterval ID)
const leaderboardTimers = {}; // Stores auto-leaderboard timers

// Scoring configuration
const QUESTION_DURATION_SECONDS = 60;
const MAX_POINTS_PER_QUESTION = 1000;
const FAST_ANSWER_BONUS_SECONDS = 10;

io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    // Host creates game
    socket.on('createGame', () => {
        const gameId = generateGameId();
        games[gameId] = {
            id: gameId,
            host: socket.id,
            players: {},
            currentQuestion: 0,
            questions: shuffleArray(sampleQuestions()),
            isStarted: false,
            playerAnswersCount: 0,
            questionStartTime: null,
            gamePhase: 'lobby' // New: Track game phase
        };
        socket.join(gameId);
        socket.emit('gameCreated', gameId);
        console.log(`Game created with ID: ${gameId}`);
        updateMonitors(gameId); // Update any monitoring clients
    });

    // Host reconnects
    socket.on('reconnectHost', (gameId) => {
        if (games[gameId]) {
            clearDisconnectTimer(socket.id, gameId, true); // Clear old timer

            // Update host's socket ID in the game state
            games[gameId].host = socket.id;
            socket.join(gameId);
            
            let currentQuestionData = null;
            let timeLeft = 0;
            if (games[gameId].isStarted && games[gameId].currentQuestion < games[gameId].questions.length) {
                currentQuestionData = {
                    question: games[gameId].questions[games[gameId].currentQuestion].question,
                    options: games[gameId].questions[games[gameId].currentQuestion].options,
                    questionNumber: games[gameId].currentQuestion + 1,
                    totalQuestions: games[gameId].questions.length,
                    duration: QUESTION_DURATION_SECONDS
                };
                if (gameTimers[gameId] && gameTimers[gameId].startTime) {
                    timeLeft = Math.max(0, QUESTION_DURATION_SECONDS - Math.floor((Date.now() - gameTimers[gameId].startTime) / 1000));
                }
            }
            
            socket.emit('reconnectedAsHost', {
                gameId,
                gameData: {
                    isStarted: games[gameId].isStarted,
                    players: Object.values(games[gameId].players).map(p => ({
                        name: p.name,
                        score: p.score,
                        socketId: p.socketId,
                        answeredCurrentQuestion: p.answeredQuestion === games[gameId].currentQuestion
                    })),
                    currentQuestionIndex: games[gameId].currentQuestion,
                    totalQuestions: games[gameId].questions.length,
                    gamePhase: games[gameId].gamePhase // Send current phase
                },
                currentQuestionData: currentQuestionData,
                timeLeft: timeLeft
            });
            console.log(`Host reconnected to game ${gameId}`);
            updateMonitors(gameId); // Ensure monitors get updated state
        } else {
            socket.emit('error', 'Game not found for reconnection. Returning to home.');
        }
    });

    // Player joins game
    socket.on('joinGame', ({ gameId, playerName }) => {
        gameId = gameId.toUpperCase();
        if (!games[gameId]) {
            socket.emit('error', 'Game not found');
            return;
        }

        const existingPlayer = Object.values(games[gameId].players).find(p => p.name.toLowerCase() === playerName.toLowerCase());
        if (existingPlayer && io.sockets.sockets.has(existingPlayer.socketId)) {
            socket.emit('error', `Player '${playerName}' is already active in this game. Choose a different name or use the reconnect feature if you disconnected.`);
            return;
        }
        
        // If there was a disconnected player with this name, clear their timer
        clearDisconnectTimer(null, gameId, false, playerName);

        // If player is rejoining with the same name, retain their score.
        let playerScore = 0;
        let playerAnsweredQuestion = null;
        if (existingPlayer) {
            playerScore = existingPlayer.score;
            playerAnsweredQuestion = existingPlayer.answeredQuestion; // Retain last answered question state
            delete games[gameId].players[existingPlayer.name]; // Remove old entry if it exists (e.g., old socketId)
        }

        games[gameId].players[playerName] = {
            socketId: socket.id,
            name: playerName,
            score: playerScore,
            answeredQuestion: playerAnsweredQuestion,
            answerTime: null
        };

        socket.join(gameId);
        socket.emit('gameJoined', { gameId, isHost: false, gameStarted: games[gameId].isStarted });
        io.to(games[gameId].host).emit('playerJoined', {
            playerId: playerName,
            playerName: playerName
        });
        console.log(`Player ${playerName} joined game ${gameId}`);
        updateMonitors(gameId); // Update monitors
    });

    // Player reconnects
    socket.on('reconnectPlayer', ({ gameId, playerName }) => {
        gameId = gameId.toUpperCase();
        if (games[gameId] && games[gameId].players[playerName]) {
            clearDisconnectTimer(null, gameId, false, playerName); // Clear old player disconnect timer by name

            // Update player's socket ID
            games[gameId].players[playerName].socketId = socket.id;

            socket.join(gameId);
            
            let currentQuestionData = null;
            let timeLeft = 0;
            if (games[gameId].isStarted && games[gameId].currentQuestion < games[gameId].questions.length) {
                currentQuestionData = {
                    question: games[gameId].questions[games[gameId].currentQuestion].question,
                    options: games[gameId].questions[games[gameId].currentQuestion].options,
                    questionNumber: games[gameId].currentQuestion + 1,
                    totalQuestions: games[gameId].questions.length,
                    duration: QUESTION_DURATION_SECONDS
                };
                if (gameTimers[gameId] && gameTimers[gameId].startTime) {
                    timeLeft = Math.max(0, QUESTION_DURATION_SECONDS - Math.floor((Date.now() - gameTimers[gameId].startTime) / 1000));
                }
            }

            socket.emit('reconnectedAsPlayer', {
                gameId,
                playerName,
                gameData: {
                    isStarted: games[gameId].isStarted,
                    currentQuestionIndex: games[gameId].currentQuestion,
                    totalQuestions: games[gameId].questions.length,
                    gamePhase: games[gameId].gamePhase // Send current phase
                },
                currentQuestionData: currentQuestionData,
                timeLeft: timeLeft
            });
            io.to(games[gameId].host).emit('playerJoined', {
                playerId: playerName,
                playerName: playerName
            }); // Re-notify host
            console.log(`Player ${playerName} reconnected to game ${gameId}`);
            updateMonitors(gameId); // Update monitors
        } else {
            socket.emit('error', 'Reconnection failed: Player or Game not found. Returning to home.');
        }
    });

    // Start game
    socket.on('startGame', (gameId) => {
        if (games[gameId]?.host === socket.id && !games[gameId].isStarted) {
            games[gameId].isStarted = true;
            games[gameId].gamePhase = 'question'; // Set phase
            games[gameId].playerAnswersCount = 0;
            Object.values(games[gameId].players).forEach(p => p.answeredQuestion = null); // Reset all players for Q1

            const q = games[gameId].questions[0];
            io.to(gameId).emit('gameStarted');
            sendQuestion(gameId, q, 1, games[gameId].questions.length);
            console.log(`Game ${gameId} started.`);
            updateMonitors(gameId); // Update monitors
        }
    });

    // Submit answer
    socket.on('submitAnswer', ({ gameId, answer }) => {
        const game = games[gameId];
        if (!game) return;

        const playerName = getPlayerNameBySocket(game, socket.id);
        if (!playerName) return;

        const player = game.players[playerName];
        const currentQ = game.questions[game.currentQuestion];

        if (player.answeredQuestion !== game.currentQuestion && gameTimers[gameId] && gameTimers[gameId].startTime) {
            player.answeredQuestion = game.currentQuestion;
            game.playerAnswersCount++;

            const timeTaken = (Date.now() - gameTimers[gameId].startTime) / 1000;
            player.answerTime = timeTaken;

            const isCorrect = answer === currentQ.correctAnswer;
            let pointsAwarded = 0;

            if (isCorrect) {
                if (timeTaken <= FAST_ANSWER_BONUS_SECONDS) {
                    pointsAwarded = MAX_POINTS_PER_QUESTION;
                } else if (timeTaken < QUESTION_DURATION_SECONDS) {
                    const decayFactor = (QUESTION_DURATION_SECONDS - timeTaken) / (QUESTION_DURATION_SECONDS - FAST_ANSWER_BONUS_SECONDS);
                    pointsAwarded = Math.max(0, Math.floor(MAX_POINTS_PER_QUESTION * decayFactor));
                }
                player.score += pointsAwarded;
            }

            socket.emit('answerResult', {
                correct: isCorrect,
                correctAnswer: currentQ.correctAnswer,
                points: pointsAwarded,
                isFinalAnswer: true // Mark this as final feedback to player
            });

            // Emit to host directly for live player results
            io.to(game.host).emit('playerAnswered', {
                playerName,
                correct: isCorrect,
                answer: answer,
                score: player.score,
                timeTaken: timeTaken
            });

            console.log(`Player ${playerName} submitted answer for game ${gameId}. Correct: ${isCorrect}, Points: ${pointsAwarded}`);
            updateMonitors(gameId);

            // Check if all active players have answered or if host manual next
            const activePlayers = Object.values(game.players).filter(p => io.sockets.sockets.has(p.socketId));
            if (game.playerAnswersCount >= activePlayers.length && activePlayers.length > 0) {
                console.log(`All active players answered for game ${gameId}, question ${game.currentQuestion + 1}.`);
                clearInterval(gameTimers[gameId].interval);
                clearTimeout(gameTimers[gameId].timer);
                delete gameTimers[gameId];
                showLeaderboardOrNext(gameId);
            }
        }
    });

    // Host manually goes to next question
    socket.on('nextQuestion', (gameId) => {
        const game = games[gameId];
        if (!game || game.host !== socket.id) return;

        clearInterval(gameTimers[gameId]?.interval);
        clearTimeout(gameTimers[gameId]?.timer);
        clearTimeout(leaderboardTimers[gameId]);
        delete gameTimers[gameId];
        delete leaderboardTimers[gameId];

        advanceQuestion(gameId);
    });

    // Host manually shows leaderboard
    socket.on('showLeaderboard', (gameId) => {
        const game = games[gameId];
        if (!game || game.host !== socket.id) return;

        clearTimeout(leaderboardTimers[gameId]);
        delete leaderboardTimers[gameId];
        
        // Ensure all players who haven't answered are marked as 0 for this question before showing LB
        Object.values(game.players).forEach(p => {
            if (p.answeredQuestion !== game.currentQuestion) {
                p.answeredQuestion = game.currentQuestion; // Mark as answered (0 points)
                p.answerTime = QUESTION_DURATION_SECONDS; // Mark max time
            }
        });

        const leaderboard = getLeaderboard(game);
        io.to(gameId).emit('leaderboardUpdate', { leaderboard });
        games[gameId].gamePhase = 'leaderboard'; // Set phase
        console.log(`Game ${gameId}: Host requested leaderboard.`);
        updateMonitors(gameId); // Update monitors
        
        leaderboardTimers[gameId] = setTimeout(() => {
            console.log(`Game ${gameId}: Auto-advancing from leaderboard (manual click).`);
            advanceQuestion(gameId);
        }, 10000); // 10 seconds to auto-advance even after manual show
    });

    // Monitor Game
    socket.on('monitorGame', (gameId) => {
        gameId = gameId.toUpperCase();
        const game = games[gameId];
        if (game) {
            socket.join(`monitor-${gameId}`);
            updateMonitors(gameId, socket.id); // Send initial data to this specific monitor client
            console.log(`Client ${socket.id} started monitoring game ${gameId}`);
        } else {
            socket.emit('error', 'Game not found for monitoring. Please check the code.');
        }
    });

    // Disconnection handler
    socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);

        for (const gameId in games) {
            const game = games[gameId];

            if (game.host === socket.id) {
                console.log(`Host disconnected from ${gameId}, setting 10s removal timer...`);
                disconnectTimers[socket.id] = {
                    timer: setTimeout(() => {
                        if (games[gameId] && games[gameId].host === socket.id) {
                            io.to(gameId).emit('hostLeft');
                            clearInterval(gameTimers[gameId]?.interval);
                            clearTimeout(gameTimers[gameId]?.timer);
                            clearTimeout(leaderboardTimers[gameId]);
                            delete gameTimers[gameId];
                            delete leaderboardTimers[gameId];
                            delete games[gameId];
                            console.log(`Game ${gameId} removed due to host prolonged disconnection.`);
                            updateMonitors(gameId); // Update monitors as game is deleted
                        }
                        delete disconnectTimers[socket.id];
                    }, 10000),
                    gameId: gameId,
                    isHost: true
                };
                updateMonitors(gameId); // Inform monitors about host disconnection
                return;
            }

            const playerName = getPlayerNameBySocket(game, socket.id);
            if (playerName) {
                console.log(`Player ${playerName} disconnected from ${gameId}, setting 10s removal timer...`);
                disconnectTimers[socket.id] = {
                    timer: setTimeout(() => {
                        if (game.players[playerName] && game.players[playerName].socketId === socket.id) {
                            // If player was the last active player to answer, trigger leaderboard/next
                            const answeredCountBeforeRemoval = game.playerAnswersCount;
                            const activePlayersBeforeRemoval = Object.values(game.players).filter(p => io.sockets.sockets.has(p.socketId) && p.name !== playerName).length;

                            delete game.players[playerName]; // Remove player completely for simplicity
                            io.to(game.host).emit('playerLeft', playerName);
                            console.log(`Player ${playerName} removed from ${gameId} due to prolonged disconnection.`);
                            
                            if (activePlayersBeforeRemoval === 0 && !game.isStarted) {
                                // Game ends if no players left in lobby
                                io.to(game.host).emit('hostLeft'); 
                                delete games[gameId];
                                console.log(`Game ${gameId} removed as all players left and game not started.`);
                            } else if (game.isStarted && game.gamePhase === 'question' && answeredCountBeforeRemoval >= activePlayersBeforeRemoval && activePlayersBeforeRemoval > 0) {
                                // If a disconnect causes all *remaining* active players to have answered, advance
                                console.log(`Game ${gameId}: All remaining active players answered due to ${playerName} disconnect.`);
                                clearInterval(gameTimers[gameId].interval);
                                clearTimeout(gameTimers[gameId].timer);
                                delete gameTimers[gameId];
                                showLeaderboardOrNext(gameId);
                            }
                            updateMonitors(gameId); // Update monitors after player leaves
                        }
                        delete disconnectTimers[socket.id];
                    }, 10000),
                    gameId: gameId,
                    isHost: false,
                    playerName: playerName
                };
                updateMonitors(gameId); // Inform monitors about player disconnection (for status change)
                return;
            }

            if (socket.rooms.has(`monitor-${gameId}`)) {
                socket.leave(`monitor-${gameId}`);
                console.log(`Monitor client ${socket.id} left game ${gameId}.`);
                return;
            }
        }
    });
});

// --- Game Logic Functions ---

function sendQuestion(gameId, question, questionNumber, totalQuestions) {
    const game = games[gameId];
    if (!game) return;

    // Reset player answers for the new question for *active* players
    game.playerAnswersCount = 0;
    Object.values(game.players).forEach(p => {
        if (io.sockets.sockets.has(p.socketId)) { // Only reset for currently connected players
            p.answeredQuestion = null;
            p.answerTime = null;
        }
    });

    game.gamePhase = 'question'; // Set phase
    io.to(gameId).emit('newQuestion', {
        question: question.question,
        options: question.options,
        questionNumber: questionNumber,
        totalQuestions: totalQuestions,
        duration: QUESTION_DURATION_SECONDS
    });

    // Clear any existing timers
    if (gameTimers[gameId]) {
        clearInterval(gameTimers[gameId].interval);
        clearTimeout(gameTimers[gameId].timer);
        delete gameTimers[gameId];
    }
    clearTimeout(leaderboardTimers[gameId]);
    delete leaderboardTimers[gameId];

    const startTime = Date.now();
    game.questionStartTime = startTime;

    let timeLeft = QUESTION_DURATION_SECONDS;
    // Emit initial time left
    io.to(gameId).emit('questionTimerUpdate', timeLeft);
    io.to(`monitor-${gameId}`).emit('monitorTimerUpdate', {gameId: gameId, timeLeft: timeLeft});

    const intervalId = setInterval(() => {
        timeLeft--;
        io.to(gameId).emit('questionTimerUpdate', timeLeft);
        io.to(`monitor-${gameId}`).emit('monitorTimerUpdate', {gameId: gameId, timeLeft: timeLeft});
        if (timeLeft <= 0) {
            clearInterval(gameTimers[gameId]?.interval); // Use optional chaining
            if (gameTimers[gameId]) delete gameTimers[gameId]; // Clean up
        }
    }, 1000);

    gameTimers[gameId] = {
        startTime: startTime,
        interval: intervalId,
        timer: setTimeout(() => {
            console.log(`Game ${gameId}: Question timer expired for question ${questionNumber}.`);
            showLeaderboardOrNext(gameId);
        }, QUESTION_DURATION_SECONDS * 1000 + 500) // Add a small buffer for timer to hit 0
    };

    updateMonitors(gameId);
}

function showLeaderboardOrNext(gameId) {
    const game = games[gameId];
    if (!game) return;

    // Ensure all players who haven't answered are marked as 0 for this question
    Object.values(game.players).forEach(p => {
        // Only mark if they haven't answered this current question number AND they are active
        if (p.answeredQuestion !== game.currentQuestion && io.sockets.sockets.has(p.socketId)) {
            p.answeredQuestion = game.currentQuestion; // Mark as answered (0 points implicitly)
            p.answerTime = QUESTION_DURATION_SECONDS; // Mark max time
            // Optionally, emit a 'noAnswer' feedback to player here
            io.to(p.socketId).emit('answerResult', {
                correct: false,
                correctAnswer: game.questions[game.currentQuestion].correctAnswer,
                points: 0,
                isFinalAnswer: false // Not their answer, but feedback after timeout
            });
        }
    });

    const leaderboard = getLeaderboard(game);
    io.to(gameId).emit('leaderboardUpdate', { leaderboard });
    game.gamePhase = 'leaderboard'; // Set phase

    clearInterval(gameTimers[gameId]?.interval);
    clearTimeout(gameTimers[gameId]?.timer);
    delete gameTimers[gameId];

    clearTimeout(leaderboardTimers[gameId]); // Clear any existing leaderboard timer
    leaderboardTimers[gameId] = setTimeout(() => {
        console.log(`Game ${gameId}: Auto-advancing from leaderboard.`);
        advanceQuestion(gameId);
    }, 10000); // 10 seconds to auto-advance

    updateMonitors(gameId);
}

function advanceQuestion(gameId) {
    const game = games[gameId];
    if (!game) return;

    game.currentQuestion++;
    clearTimeout(leaderboardTimers[gameId]);
    delete leaderboardTimers[gameId]; // Clear leaderboard timer when advancing

    if (game.currentQuestion < game.questions.length) {
        const q = game.questions[game.currentQuestion];
        sendQuestion(gameId, q, game.currentQuestion + 1, game.questions.length);
    } else {
        const leaderboard = getLeaderboard(game);
        io.to(gameId).emit('gameOver', { leaderboard });
        game.gamePhase = 'game_over'; // Set phase
        console.log(`Game ${gameId}: Game Over.`);
        // Clean up game timers at game end
        clearInterval(gameTimers[gameId]?.interval);
        clearTimeout(gameTimers[gameId]?.timer);
        delete gameTimers[gameId];
        updateMonitors(gameId);
    }
}

function updateMonitors(gameId, targetSocketId = null) {
    const game = games[gameId];
    if (game) {
        const allPlayers = Object.values(game.players); // Get all players
        const activePlayerSockets = io.sockets.adapter.rooms.get(gameId); // Get active sockets in the game room

        const currentMonitorData = {
            gameId: game.id,
            isStarted: game.isStarted,
            currentQuestion: game.currentQuestion,
            totalQuestions: game.questions.length,
            players: allPlayers.map(p => ({
                name: p.name,
                score: p.score,
                // Check if player's socket is currently connected to the game room
                isConnected: activePlayerSockets ? activePlayerSockets.has(p.socketId) : false,
                answeredCurrentQuestion: p.answeredQuestion === game.currentQuestion
            })).sort((a, b) => b.score - a.score),
            gamePhase: game.gamePhase,
            questionText: game.isStarted && game.currentQuestion < game.questions.length ? game.questions[game.currentQuestion].question : null
        };

        const target = targetSocketId ? io.to(targetSocketId) : io.to(`monitor-${gameId}`);
        target.emit('monitoringData', currentMonitorData);
    }
}

// --- Utility Functions ---

function clearDisconnectTimer(socketId, gameId, isHost, playerName = null) {
    // If socketId is provided, clear that specific timer
    if (socketId && disconnectTimers[socketId]) {
        clearTimeout(disconnectTimers[socketId].timer);
        delete disconnectTimers[socketId];
        console.log(`Cleared specific disconnect timer for socket ${socketId}`);
        return;
    }
    // If playerName is provided (for players rejoining), find and clear by name
    if (playerName) {
        for (const timerSocketId in disconnectTimers) {
            const timerInfo = disconnectTimers[timerSocketId];
            if (timerInfo && timerInfo.gameId === gameId && !timerInfo.isHost && timerInfo.playerName.toLowerCase() === playerName.toLowerCase()) {
                clearTimeout(timerInfo.timer);
                delete disconnectTimers[timerSocketId];
                console.log(`Cleared stale player disconnect timer for ${playerName} (old socket ${timerSocketId})`);
                return;
            }
        }
    }
}


function getPlayerNameBySocket(game, socketId) {
    for (const name in game.players) {
        if (game.players[name].socketId === socketId) return name;
    }
    return null;
}

function getLeaderboard(game) {
    return Object.values(game.players)
        .map(p => ({ name: p.name, score: p.score }))
        .sort((a, b) => b.score - a.score);
}

function generateGameId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function sampleQuestions() {
    return [
        {
            question: "Which planet is known as the 'Red Planet'?",
            options: ["Earth", "Mars", "Jupiter", "Venus"],
            correctAnswer: "Mars"
        },
        {
            question: "What is the largest ocean on Earth?",
            options: ["Atlantic Ocean", "Indian Ocean", "Arctic Ocean", "Pacific Ocean"],
            correctAnswer: "Pacific Ocean"
        },
        {
            question: "What is the chemical symbol for water?",
            options: ["O2", "H2O", "CO2", "NACL"],
            correctAnswer: "H2O"
        },
        {
            question: "Who wrote 'Romeo and Juliet'?",
            options: ["Charles Dickens", "William Shakespeare", "Jane Austen", "Mark Twain"],
            correctAnswer: "William Shakespeare"
        },
        {
            question: "What is the smallest prime number?",
            options: ["0", "1", "2", "3"],
            correctAnswer: "2"
        },
        {
            question: "Which country is famous for the Great Wall?",
            options: ["India", "Japan", "China", "Egypt"],
            correctAnswer: "China"
        },
        {
            question: "What is the fastest land animal?",
            options: ["Lion", "Cheetah", "Gazelle", "Horse"],
            correctAnswer: "Cheetah"
        },
        {
            question: "What is the capital of Japan?",
            options: ["Seoul", "Beijing", "Tokyo", "Bangkok"],
            correctAnswer: "Tokyo"
        },
        {
            question: "Which gas do plants absorb from the atmosphere?",
            options: ["Oxygen", "Nitrogen", "Carbon Dioxide", "Hydrogen"],
            correctAnswer: "Carbon Dioxide"
        },
        {
            question: "How many continents are there?",
            options: ["5", "6", "7", "8"],
            correctAnswer: "7"
        },
        {
            question: "What is the main ingredient in guacamole?",
            options: ["Tomato", "Onion", "Avocado", "Chili"],
            correctAnswer: "Avocado"
        },
        {
            question: "Which is the longest river in the world?",
            options: ["Amazon River", "Nile River", "Yangtze River", "Mississippi River"],
            correctAnswer: "Nile River"
        },
        {
            question: "What is the capital of Australia?",
            options: ["Sydney", "Melbourne", "Canberra", "Perth"],
            correctAnswer: "Canberra"
        },
        {
            question: "In which year did the first man walk on the moon?",
            options: ["1965", "1969", "1971", "1975"],
            correctAnswer: "1969"
        },
        {
            question: "What is the hardest natural substance on Earth?",
            options: ["Gold", "Iron", "Diamond", "Quartz"],
            correctAnswer: "Diamond"
        }
    ];
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));