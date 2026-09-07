const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
// Esta línea es crucial: expone la carpeta "public" al navegador.
app.use(express.static(path.join(__dirname, 'public'))); 

const QUESTIONS_FILE = path.join(__dirname, 'questions.json');

// --- MANEJO DE PREGUNTAS ---
function loadQuestions() {
  try {
    if (!fs.existsSync(QUESTIONS_FILE)) {
      // Si el archivo no existe, crearlo con un arreglo vacío
      fs.writeFileSync(QUESTIONS_FILE, '[]', 'utf8');
      return [];
    }
    const data = fs.readFileSync(QUESTIONS_FILE, 'utf8');
    // Si el archivo está vacío, devolver arreglo vacío
    if (!data || data.trim() === '') {
       return [];
    }
    return JSON.parse(data);
  } catch (error) {
    console.error("Error al cargar preguntas:", error);
    return []; // En caso de error (ej. JSON corrupto), devuelve vacío
  }
}

function saveQuestions(data) {
  try {
    fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
     console.error("Error al guardar preguntas:", error);
  }
}

// API RUTAS (Para el Admin)
app.get('/api/questions', (req, res) => {
  res.json(loadQuestions());
});

app.post('/api/questions', (req, res) => {
  const { question, options, correctIndex, timeLimit } = req.body;
  
  if (!question || !options || options.length !== 4 || correctIndex === undefined) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }

  const questions = loadQuestions();
  const newQ = {
    id: Date.now().toString(),
    question: question.trim(),
    options: options.map(o => o.trim()),
    correctIndex: parseInt(correctIndex, 10),
    timeLimit: parseInt(timeLimit, 10) || 20
  };
  
  questions.push(newQ);
  saveQuestions(questions);
  res.json({ success: true, question: newQ });
});

app.delete('/api/questions/:id', (req, res) => {
  let questions = loadQuestions();
  questions = questions.filter(q => q.id !== req.params.id);
  saveQuestions(questions);
  res.json({ success: true });
});

// --- LÓGICA DEL JUEGO (SOCKET.IO) ---
const rooms = {};

io.on('connection', (socket) => {
  console.log('Nuevo cliente conectado:', socket.id);

  // El presentador crea una sala
  socket.on('create-room', () => {
    // Generar PIN de 6 dígitos
    const pin = Math.floor(100000 + Math.random() * 900000).toString();
    const questions = loadQuestions();

    if (questions.length === 0) {
        return socket.emit('room-error', 'No hay preguntas guardadas. Ve al panel de admin a crear algunas.');
    }

    rooms[pin] = {
      hostId: socket.id,
      players: {},
      currentQuestionIndex: -1,
      questionStartTime: null,
      acceptingAnswers: false,
      questions: questions
    };
    
    socket.join(pin);
    console.log(`Sala creada. PIN: ${pin}, Host: ${socket.id}`);
    socket.emit('room-created', { pin });
  });

  // El alumno se une
  socket.on('join-room', ({ pin, paterno, materno, nombre }) => {
    const room = rooms[pin];
    
    if (!room) {
      return socket.emit('join-error', 'La sala no existe o el PIN es incorrecto.');
    }
    if (room.currentQuestionIndex >= 0) {
      return socket.emit('join-error', 'La partida ya está en curso.');
    }
    if (!paterno || !materno || !nombre) {
      return socket.emit('join-error', 'Debes ingresar Apellido Paterno, Materno y Nombre completos.');
    }

    const fullName = `${paterno.trim()} ${materno.trim()} ${nombre.trim()}`;
    
    room.players[socket.id] = {
      id: socket.id,
      fullName: fullName,
      score: 0,
      answered: false
    };

    socket.join(pin);
    console.log(`Jugador ${fullName} se unió a la sala ${pin}`);
    socket.emit('joined-success', { fullName });

    // Actualizar lista en pantalla del host
    io.to(room.hostId).emit('update-players', Object.values(room.players));
  });

  // El presentador lanza la siguiente pregunta
  socket.on('next-question', ({ pin }) => {
    const room = rooms[pin];
    if (!room || room.hostId !== socket.id) return;

    room.currentQuestionIndex++;
    
    // Si ya no hay preguntas, mostrar podio final
    if (room.currentQuestionIndex >= room.questions.length) {
      const leaderboard = Object.values(room.players).sort((a, b) => b.score - a.score);
      io.to(pin).emit('game-over', { leaderboard });
      delete rooms[pin];
      return;
    }

    const currentQ = room.questions[room.currentQuestionIndex];
    room.questionStartTime = Date.now();
    room.acceptingAnswers = true;

    // Reiniciar estado de respuesta de los jugadores
    for (let pid in room.players) {
      room.players[pid].answered = false;
    }

    // Enviar pregunta al proyector
    socket.emit('show-question-host', {
      question: currentQ.question,
      options: currentQ.options,
      timeLimit: currentQ.timeLimit,
      qIndex: room.currentQuestionIndex + 1,
      totalQ: room.questions.length
    });

    // Enviar aviso a los celulares
    socket.to(pin).emit('show-question-player', {
      timeLimit: currentQ.timeLimit
    });
  });

  // El alumno envía su respuesta
  socket.on('submit-answer', ({ pin, optionIndex }) => {
    const room = rooms[pin];
    if (!room || !room.acceptingAnswers) return;

    const player = room.players[socket.id];
    if (!player || player.answered) return;

    player.answered = true;
    const currentQ = room.questions[room.currentQuestionIndex];
    
    // Validar respuesta
    const isCorrect = optionIndex === currentQ.correctIndex;

    if (isCorrect) {
      // Calcular puntaje basado en tiempo (estilo Kahoot)
      const elapsedSeconds = (Date.now() - room.questionStartTime) / 1000;
      let points = Math.round(1000 * (1 - ((elapsedSeconds / currentQ.timeLimit) / 2)));
      // Puntaje mínimo por acierto
      if (points < 500) points = 500; 
      player.score += points;
    }

    // Avisar al alumno si acertó
    socket.emit('answer-recorded', { isCorrect });

    // Revisar si todos ya contestaron
    const allAnswered = Object.values(room.players).every(p => p.answered);
    if (allAnswered) {
      room.acceptingAnswers = false;
      io.to(room.hostId).emit('all-answered');
    }
  });

  // El presentador termina el tiempo de la pregunta
  socket.on('end-question', ({ pin }) => {
    const room = rooms[pin];
    if (!room || room.hostId !== socket.id) return;

    room.acceptingAnswers = false;
    const currentQ = room.questions[room.currentQuestionIndex];
    const leaderboard = Object.values(room.players).sort((a, b) => b.score - a.score);

    io.to(pin).emit('show-round-results', {
      correctIndex: currentQ.correctIndex,
      leaderboard
    });
  });

  // Desconexión
  socket.on('disconnect', () => {
    console.log('Cliente desconectado:', socket.id);
    for (let pin in rooms) {
      const room = rooms[pin];
      if (room.hostId === socket.id) {
        // Si el host se va, cerrar la sala
        io.to(pin).emit('room-closed');
        delete rooms[pin];
      } else if (room.players[socket.id]) {
        // Si un jugador se va, quitarlo de la lista
        delete room.players[socket.id];
        // Solo actualizar al host si el juego no ha empezado
        if(room.currentQuestionIndex === -1) {
             io.to(room.hostId).emit('update-players', Object.values(room.players));
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor iniciado correctamente.`);
  console.log(`- Panel Admin: http://localhost:${PORT}/admin.html`);
  console.log(`- Proyector:   http://localhost:${PORT}/host.html`);
  console.log(`- Alumnos:     http://localhost:${PORT}/player.html`);
});
