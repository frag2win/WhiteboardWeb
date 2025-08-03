const express = require('express');
const path = require('path');
const http = require('http');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// --- MongoDB Connection ---
mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/whiteboard-app')
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// --- Mongoose Schemas (Improved for Flexibility) ---
const User = mongoose.model('User', new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true }
}));

const drawingActionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, index: true },
  data: { type: Object, required: true }
}, { timestamps: true });
const DrawingAction = mongoose.model('DrawingAction', drawingActionSchema);

// --- Middleware ---
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

// --- API Routes for Login/Registration ---
app.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ message: 'All fields are required.' });
    if (await User.findOne({ username })) return res.status(409).json({ message: 'User already exists.' });

    const hashedPassword = await bcrypt.hash(password, 10);
    await new User({ username, password: hashedPassword }).save();
    res.status(201).json({ success: true, message: 'Registration successful!' });
  } catch (error) {
    res.status(500).json({ message: 'Server error during registration.' });
  }
});

app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ message: 'Invalid credentials.' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ message: 'Server error during login.' });
  }
});

// --- Real-time Socket.IO Logic (Refactored for Stability) ---
const sessions = {}; // A single source of truth for all session data

io.on('connection', (socket) => {
  socket.on('join-session', async ({ sessionId, username }) => {
    // Initialize session if it doesn't exist
    if (!sessions[sessionId]) {
      sessions[sessionId] = { users: new Map() };
    }
    const session = sessions[sessionId];

    // Join the socket room and store user data
    socket.join(sessionId);
    session.users.set(socket.id, username);
    socket.data = { sessionId, username };

    // Retrieve and send drawing history
    try {
      const history = await DrawingAction.find({ sessionId }).sort('createdAt');
      // Send only the data part of each action
      socket.emit('drawing-history', history.map(h => h.data));
    } catch (err) {
      console.error('Failed to retrieve drawing history:', err);
    }

    // Notify all clients in the room about the updated user list
    io.to(sessionId).emit('user-list-update', Array.from(session.users.values()));
  });

  socket.on('drawing-action', (data) => {
    // Broadcast the action to other users in the same session
    if (socket.data.sessionId) {
      socket.to(socket.data.sessionId).emit('drawing-action', data);
      // Save the action to the database
      const action = new DrawingAction({ sessionId: socket.data.sessionId, data });
      action.save().catch(err => console.error('Failed to save drawing action:', err));
    }
  });

  socket.on('chat-message', (message) => {
    if (socket.data.sessionId && socket.data.username) {
      io.to(socket.data.sessionId).emit('chat-message', { user: socket.data.username, message });
    }
  });

  socket.on('clear-board', () => {
    if (socket.data.sessionId) {
      DrawingAction.deleteMany({ sessionId: socket.data.sessionId }).catch(err => console.error('Failed to clear board history:', err));
      io.to(socket.data.sessionId).emit('board-cleared');
    }
  });

  socket.on('disconnect', () => {
    const { sessionId } = socket.data || {};
    if (sessionId && sessions[sessionId]) {
      // Remove user from the session list
      sessions[sessionId].users.delete(socket.id);
      // Notify remaining clients about the updated user list
      io.to(sessionId).emit('user-list-update', Array.from(sessions[sessionId].users.values()));
    }
  });
});

server.listen(PORT, () => console.log(`🚀 Server is running on http://localhost:${PORT}`));