const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const crypto = require("crypto");
const cookieParser = require("cookie-parser");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const path = require('path');
const app = express();
const server = http.createServer(app);

// Configuração do CORS
app.use(cors({
  origin: "https://openmessage.hsyst.xyz",
  methods: ["GET", "POST"],
  credentials: true,
}));

// Configuração do Socket.IO
const io = socketIo(server, {
  cors: {
    origin: "https://openmessage.hsyst.xyz",
    methods: ["GET", "POST"],
  },
});

// Configurações
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Banco de dados SQLite
const db = new sqlite3.Database("./database.db");

// Criação das tabelas (se não existirem)
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      tokenaes TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      description TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      serverId INTEGER,
      name TEXT,
      description TEXT,
      FOREIGN KEY(serverId) REFERENCES servers(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER,
      channelId INTEGER,
      serverId INTEGER,
      message TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(userId) REFERENCES users(id),
      FOREIGN KEY(channelId) REFERENCES channels(id),
      FOREIGN KEY(serverId) REFERENCES servers(id)
    )
  `);
});

// Função para gerar token AES
function generateToken() {
  return crypto.randomBytes(16).toString("hex");
}

// Middleware de autenticação
function authenticate(req, res, next) {
  const { user, tokenaes } = req.cookies;
  if (!user || !tokenaes) {
    return res.status(401).json({ error: "Não autenticado" });
  }

  db.get(
    "SELECT * FROM users WHERE username = ? AND tokenaes = ?",
    [user, tokenaes],
    (err, row) => {
      if (err || !row) {
        return res.status(401).json({ error: "Token inválido" });
      }
      req.user = row;
      next();
    }
  );
}

// Rotas

// 1. Login
app.post("/login", (req, res) => {
  const { user, tokenaes } = req.body;
  if (!user || !tokenaes) {
    return res.status(400).json({ error: "Usuário e token são obrigatórios" });
  }

  db.get(
    "SELECT * FROM users WHERE username = ? AND tokenaes = ?",
    [user, tokenaes],
    (err, row) => {
      if (err || !row) {
        return res.status(401).json({ error: "Credenciais inválidas" });
      }

      res.cookie("user", user, { maxAge: 3600000, httpOnly: false });
      res.cookie("tokenaes", tokenaes, { maxAge: 3600000, httpOnly: false });
      res.json({ message: "Login bem-sucedido" });
    }
  );
});

// 2. Registro
app.post("/register", (req, res) => {
  const { user } = req.body;
  if (!user) {
    return res.status(400).json({ error: "Nome de usuário é obrigatório" });
  }

  const tokenaes = generateToken();

  db.run(
    "INSERT INTO users (username, tokenaes) VALUES (?, ?)",
    [user, tokenaes],
    function (err) {
      if (err) {
        return res.status(400).json({ error: "Usuário já existe" });
      }
      res.json({ message: "Registro bem-sucedido", tokenaes });
    }
  );
});

// 3. Enviar mensagem
app.post("/send-message", authenticate, (req, res) => {
  const { channelId, serverId, message } = req.body;
  if (!channelId || !serverId || !message) {
    return res.status(400).json({ error: "Dados incompletos" });
  }

  db.run(
    "INSERT INTO messages (userId, channelId, serverId, message) VALUES (?, ?, ?, ?)",
    [req.user.id, channelId, serverId, message],
    function (err) {
      if (err) {
        return res.status(500).json({ error: "Erro ao enviar mensagem" });
      }

      // Enviar mensagem via Socket.IO
      io.to(`server:${serverId}`).to(`channel:${channelId}`).emit("new-message", {
        userId: req.user.id,
        channelId,
        serverId,
        message,
        timestamp: new Date().toISOString(),
      });

      res.json({ message: "Mensagem enviada" });
    }
  );
});

// 4. Criar servidor
app.post("/create-server", authenticate, (req, res) => {
  const { name, description } = req.body;
  if (!name || !description) {
    return res.status(400).json({ error: "Nome e descrição são obrigatórios" });
  }

  db.run(
    "INSERT INTO servers (name, description) VALUES (?, ?)",
    [name, description],
    function (err) {
      if (err) {
        return res.status(500).json({ error: "Erro ao criar servidor" });
      }
      res.json({ message: "Servidor criado", serverId: this.lastID });
    }
  );
});

// 5. Criar canal
app.post("/create-channel", authenticate, (req, res) => {
  const { serverId, name, description } = req.body;
  if (!serverId || !name || !description) {
    return res.status(400).json({ error: "Dados incompletos" });
  }

  db.run(
    "INSERT INTO channels (serverId, name, description) VALUES (?, ?, ?)",
    [serverId, name, description],
    function (err) {
      if (err) {
        return res.status(500).json({ error: "Erro ao criar canal" });
      }
      res.json({ message: "Canal criado", channelId: this.lastID });
    }
  );
});

// 6. Listar servidores
app.get("/servers", authenticate, (req, res) => {
  db.all("SELECT * FROM servers", (err, rows) => {
    if (err) {
      return res.status(500).json({ error: "Erro ao listar servidores" });
    }
    res.json(rows);
  });
});

// 7. Listar canais de um servidor
app.get("/servers/:serverId/channels", authenticate, (req, res) => {
  const { serverId } = req.params;
  db.all("SELECT * FROM channels WHERE serverId = ?", [serverId], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: "Erro ao listar canais" });
    }
    res.json(rows);
  });
});

// 8. Listar mensagens de um canal
app.get("/channels/:channelId/messages", authenticate, (req, res) => {
  const { channelId } = req.params;
  db.all("SELECT * FROM messages WHERE channelId = ?", [channelId], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: "Erro ao listar mensagens" });
    }
    res.json(rows);
  });
});

// 9. Buscar nome de usuário pelo ID
app.get("/user/:userId", authenticate, (req, res) => {
    const { userId } = req.params;
    db.get("SELECT username FROM users WHERE id = ?", [userId], (err, row) => {
        if (err || !row) {
            return res.status(404).json({ error: "Usuário não encontrado" });
        }
        res.json({ username: row.username });
    });
});


// Socket.IO
io.on("connection", (socket) => {
  console.log("Novo cliente conectado");

  // Entrar em um canal
  socket.on("join-channel", ({ serverId, channelId }) => {
    socket.join(`server:${serverId}`);
    socket.join(`channel:${channelId}`);
    console.log(`Usuário entrou no servidor ${serverId} e canal ${channelId}`);
  });

  // Sair de um canal
  socket.on("leave-channel", ({ serverId, channelId }) => {
    socket.leave(`server:${serverId}`);
    socket.leave(`channel:${channelId}`);
    console.log(`Usuário saiu do servidor ${serverId} e canal ${channelId}`);
  });
});

// Iniciar servidor
const PORT = 7314;
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
