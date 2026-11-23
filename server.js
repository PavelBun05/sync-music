const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const db = require("./db");

const app = express();
app.use(express.json({ limit: "50kb" }));
app.use(express.static(path.join(__dirname, "public")));

const MUSIC_DIR = path.join(__dirname, "public", "music");
fs.mkdirSync(MUSIC_DIR, { recursive: true });

// ========== СОЗДАНИЕ ТАБЛИЦ ==========
async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      "displayName" TEXT NOT NULL,
      salt TEXT NOT NULL,
      "passwordHash" TEXT NOT NULL,
      "createdAt" TEXT NOT NULL
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS user_favorites (
      "userId" TEXT NOT NULL,
      "trackId" TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      PRIMARY KEY ("userId", "trackId")
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS friends (
      "userId" TEXT NOT NULL,
      "friendId" TEXT NOT NULL,
      PRIMARY KEY ("userId", "friendId")
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS albums (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      mode TEXT NOT NULL,
      "ownerId" TEXT NOT NULL,
      "ownerName" TEXT NOT NULL,
      "sharedWith" TEXT NOT NULL,
      "sharedWithName" TEXT NOT NULL,
      tracks TEXT NOT NULL,
      "createdAt" TEXT NOT NULL
    )
  `);

  console.log("База данных готова");
}

initDb().catch((err) => {
  console.error("Ошибка инициализации БД:", err);
});

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========
const cleanUser = (user) => ({
  id: user.id,
  username: user.username,
  displayName: user.displayName,
});

function makeToken(user) {
  const payload = Buffer.from(
    JSON.stringify({ id: user.id, exp: Date.now() + 30 * 86400000 }),
  ).toString("base64url");
  const signature = crypto
    .createHmac(
      "sha256",
      process.env.TOKEN_SECRET || "default_secret_change_me",
    )
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

async function verifyToken(token) {
  if (typeof token !== "string") return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;

  const expected = crypto
    .createHmac(
      "sha256",
      process.env.TOKEN_SECRET || "default_secret_change_me",
    )
    .update(payload)
    .digest();
  let actual;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }

  if (
    actual.length !== expected.length ||
    !crypto.timingSafeEqual(actual, expected)
  ) {
    return null;
  }

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.id || data.exp < Date.now()) return null;

    const result = await db.query(
      'SELECT id, username, "displayName" FROM users WHERE id = $1',
      [data.id],
    );
    return result.rows[0] || null;
  } catch {
    return null;
  }
}

async function authUser(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const user = await verifyToken(token);
  if (!user)
    return res.status(401).json({ error: "Сначала войдите в аккаунт" });
  req.user = user;
  next();
}

function validUsername(value) {
  return /^[a-zA-Zа-яА-ЯёЁ0-9_.-]{3,20}$/.test(value);
}

async function getFavorites(userId) {
  const result = await db.query(
    'SELECT "trackId" as id, title, url FROM user_favorites WHERE "userId" = $1',
    [userId],
  );
  return result.rows;
}

function getMusicCatalog() {
  const allowed = new Set([".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"]);
  return fs
    .readdirSync(MUSIC_DIR, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && allowed.has(path.extname(entry.name).toLowerCase()),
    )
    .sort((a, b) => a.name.localeCompare(b.name, "ru", { numeric: true }))
    .map((entry) => {
      const file = entry.name;
      const title = path
        .basename(file, path.extname(file))
        .replace(/[._]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return {
        id: file,
        title: title || file,
        url: `/music/${encodeURIComponent(file)}`,
      };
    });
}

// ========== РЕГИСТРАЦИЯ ==========
app.post("/api/register", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const displayName = String(req.body.displayName || "")
      .trim()
      .slice(0, 24);
    const password = String(req.body.password || "");

    if (!validUsername(username)) {
      return res
        .status(400)
        .json({
          error: "Логин: 3–20 символов, буквы, цифры, точка, дефис или _",
        });
    }
    if (displayName.length < 2) {
      return res
        .status(400)
        .json({ error: "Укажи имя длиной не менее 2 символов" });
    }
    if (password.length < 6 || password.length > 100) {
      return res
        .status(400)
        .json({ error: "Пароль должен содержать от 6 до 100 символов" });
    }

    const existing = await db.query(
      "SELECT id FROM users WHERE LOWER(username) = LOWER($1)",
      [username],
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "Такой логин уже занят" });
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = crypto.scryptSync(password, salt, 64).toString("hex");
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    await db.query(
      `INSERT INTO users (id, username, "displayName", salt, "passwordHash", "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, username, displayName, salt, passwordHash, createdAt],
    );

    const user = { id, username, displayName };
    res.status(201).json({ token: makeToken(user), user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// ========== ВХОД ==========
app.post("/api/login", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");

    const result = await db.query(
      "SELECT * FROM users WHERE LOWER(username) = LOWER($1)",
      [username],
    );
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: "Неверный логин или пароль" });
    }

    const hash = crypto.scryptSync(password, user.salt, 64);
    const saved = Buffer.from(user.passwordHash, "hex");

    if (hash.length !== saved.length || !crypto.timingSafeEqual(hash, saved)) {
      return res.status(401).json({ error: "Неверный логин или пароль" });
    }

    res.json({
      token: makeToken(user),
      user: cleanUser(user),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.get("/api/me", authUser, (req, res) => {
  res.json({ user: cleanUser(req.user) });
});

app.get("/api/music", authUser, (req, res) => {
  res.json({ tracks: getMusicCatalog() });
});

app.get("/api/me/favorites", authUser, async (req, res) => {
  try {
    const tracks = await getFavorites(req.user.id);
    res.json({ tracks });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.put("/api/me/favorites", authUser, async (req, res) => {
  try {
    const track = req.body.track;
    if (
      !track ||
      typeof track.id !== "string" ||
      typeof track.title !== "string" ||
      typeof track.url !== "string"
    ) {
      return res.status(400).json({ error: "Некорректный трек" });
    }

    const catalog = getMusicCatalog();
    if (!catalog.some((t) => t.id === track.id)) {
      return res
        .status(404)
        .json({ error: "Этого файла больше нет на сервере" });
    }

    if (req.body.action === "remove") {
      await db.query(
        'DELETE FROM user_favorites WHERE "userId" = $1 AND "trackId" = $2',
        [req.user.id, track.id],
      );
    } else {
      await db.query(
        `INSERT INTO user_favorites ("userId", "trackId", title, url)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT ("userId", "trackId") DO NOTHING`,
        [req.user.id, track.id, track.title, track.url],
      );
    }

    const tracks = await getFavorites(req.user.id);
    res.json({ tracks });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.get("/api/friends", authUser, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT u.id, u.username, u."displayName"
       FROM friends f
       JOIN users u ON u.id = f."friendId"
       WHERE f."userId" = $1`,
      [req.user.id],
    );
    res.json({ friends: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.post("/api/friends", authUser, async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();

    const targetResult = await db.query(
      'SELECT id, username, "displayName" FROM users WHERE LOWER(username) = LOWER($1)',
      [username],
    );
    const target = targetResult.rows[0];

    if (!target) {
      return res
        .status(404)
        .json({ error: "Пользователь с таким логином не найден" });
    }
    if (target.id === req.user.id) {
      return res.status(400).json({ error: "Нельзя добавить самого себя" });
    }

    const already = await db.query(
      'SELECT 1 FROM friends WHERE "userId" = $1 AND "friendId" = $2',
      [req.user.id, target.id],
    );
    if (already.rows.length > 0) {
      return res
        .status(400)
        .json({ error: "Этот пользователь уже у вас в друзьях" });
    }

    await db.query(
      'INSERT INTO friends ("userId", "friendId") VALUES ($1, $2), ($2, $1)',
      [req.user.id, target.id],
    );

    const friendsResult = await db.query(
      `SELECT u.id, u.username, u."displayName"
       FROM friends f
       JOIN users u ON u.id = f."friendId"
       WHERE f."userId" = $1`,
      [req.user.id],
    );

    res.status(201).json({ friend: target, friends: friendsResult.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.get("/api/users/:id/favorites", authUser, async (req, res) => {
  try {
    const userResult = await db.query(
      'SELECT id, username, "displayName" FROM users WHERE id = $1',
      [req.params.id],
    );
    const user = userResult.rows[0];
    if (!user) {
      return res.status(404).json({ error: "Пользователь не найден" });
    }

    const tracks = await getFavorites(user.id);
    res.json({ user: cleanUser(user), tracks });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.get("/api/albums", authUser, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM albums
       WHERE "ownerId" = $1 OR "sharedWith" = $1
       ORDER BY "createdAt" DESC`,
      [req.user.id],
    );

    const albums = result.rows.map((row) => ({
      ...row,
      tracks: JSON.parse(row.tracks),
    }));

    res.json({ albums });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.post("/api/albums", authUser, async (req, res) => {
  try {
    const name = String(req.body.name || "")
      .trim()
      .slice(0, 50);
    const friendId = String(req.body.friendId || "");
    const mode = String(req.body.mode || "union");

    if (name.length < 2) {
      return res
        .status(400)
        .json({ error: "Название должно содержать минимум 2 символа" });
    }
    if (!["union", "common", "friend"].includes(mode)) {
      return res.status(400).json({ error: "Неизвестный тип альбома" });
    }

    const isFriend = await db.query(
      'SELECT 1 FROM friends WHERE "userId" = $1 AND "friendId" = $2',
      [req.user.id, friendId],
    );
    if (isFriend.rows.length === 0) {
      return res
        .status(403)
        .json({ error: "Выбери пользователя из списка друзей" });
    }

    const friendResult = await db.query(
      'SELECT id, "displayName" FROM users WHERE id = $1',
      [friendId],
    );
    const friend = friendResult.rows[0];
    if (!friend) {
      return res.status(404).json({ error: "Друг не найден" });
    }

    const mine = await getFavorites(req.user.id);
    const theirs = await getFavorites(friendId);

    const mineMap = new Map(mine.map((t) => [t.id, t]));
    const theirMap = new Map(theirs.map((t) => [t.id, t]));

    let tracks;
    if (mode === "common") {
      tracks = mine.filter((t) => theirMap.has(t.id));
    } else if (mode === "friend") {
      tracks = theirs;
    } else {
      tracks = [...mine, ...theirs.filter((t) => !mineMap.has(t.id))];
    }

    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    await db.query(
      `INSERT INTO albums (id, name, mode, "ownerId", "ownerName", "sharedWith", "sharedWithName", tracks, "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        name,
        mode,
        req.user.id,
        req.user.displayName,
        friendId,
        friend.displayName,
        JSON.stringify(tracks),
        createdAt,
      ],
    );

    const album = {
      id,
      name,
      mode,
      ownerId: req.user.id,
      ownerName: req.user.displayName,
      sharedWith: friendId,
      sharedWithName: friend.displayName,
      tracks,
      createdAt,
    };

    res.status(201).json({ album });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.delete("/api/albums/:id", authUser, async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM albums WHERE id = $1", [
      req.params.id,
    ]);
    const album = result.rows[0];

    if (!album) {
      return res.status(404).json({ error: "Альбом не найден" });
    }
    if (album.ownerId !== req.user.id) {
      return res
        .status(403)
        .json({ error: "Удалить альбом может только его создатель" });
    }

    await db.query("DELETE FROM albums WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// ========== WEBSOCKET ==========
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const rooms = new Map();

function createRoom(code) {
  return {
    code,
    adminId: null,
    users: new Map(),
    queue: [],
    current: null,
    isPlaying: false,
    positionAtSync: 0,
    syncedAt: Date.now(),
  };
}

function roomState(room) {
  return {
    code: room.code,
    adminId: room.adminId,
    users: [...room.users.values()],
    queue: room.queue,
    current: room.current,
    isPlaying: room.isPlaying,
    positionAtSync: room.positionAtSync,
    syncedAt: room.syncedAt,
    serverTime: Date.now(),
  };
}

function send(ws, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

function broadcast(room, data) {
  const payload = JSON.stringify(data);
  for (const ws of room.users.keys()) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

function updatePosition(room) {
  if (!room.isPlaying || !room.current) return;
  room.positionAtSync += (Date.now() - room.syncedAt) / 1000;
  room.syncedAt = Date.now();
}

function nextTrack(room) {
  room.current = room.queue.shift() || null;
  room.isPlaying = Boolean(room.current);
  room.positionAtSync = 0;
  room.syncedAt = Date.now();
}

wss.on("connection", (ws) => {
  ws.userId = null;
  ws.room = null;

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "join") {
      const user = await verifyToken(msg.token);
      if (!user) {
        send(ws, {
          type: "auth:error",
          message: "Сессия завершена. Войди в аккаунт заново.",
        });
        ws.close();
        return;
      }

      const code = String(msg.room || "")
        .trim()
        .toUpperCase()
        .slice(0, 12);
      if (!code) return;

      if (ws.room) ws.room.users.delete(ws);

      if (!rooms.has(code)) rooms.set(code, createRoom(code));
      const room = rooms.get(code);

      ws.room = room;
      ws.userId = user.id;
      ws.nick = user.displayName;

      room.users.set(ws, { id: user.id, nick: user.displayName });
      if (!room.adminId) room.adminId = user.id;

      send(ws, { type: "welcome", you: user.id, state: roomState(room) });
      broadcast(room, {
        type: "users",
        users: [...room.users.values()],
        adminId: room.adminId,
      });
      return;
    }

    const room = ws.room;
    if (!room) return;

    switch (msg.type) {
      case "play":
        if (ws.userId !== room.adminId || !room.current) return;
        updatePosition(room);
        room.isPlaying = true;
        room.syncedAt = Date.now();
        broadcast(room, { type: "sync", state: roomState(room) });
        break;

      case "pause":
        if (ws.userId !== room.adminId) return;
        updatePosition(room);
        room.isPlaying = false;
        broadcast(room, { type: "sync", state: roomState(room) });
        break;

      case "seek":
        if (ws.userId !== room.adminId) return;
        room.positionAtSync = Math.max(0, Number(msg.position) || 0);
        room.syncedAt = Date.now();
        broadcast(room, { type: "sync", state: roomState(room) });
        break;

      case "queue:add": {
        const track = getMusicCatalog().find((t) => t.id === msg.trackId);
        const url = track ? track.url : String(msg.url || "").trim();
        if (!url) return;

        room.queue.push({
          id: crypto.randomUUID(),
          title: String(
            track ? track.title : msg.title || "Без названия",
          ).slice(0, 100),
          url,
          addedBy: ws.nick,
        });

        if (!room.current) nextTrack(room);
        broadcast(room, { type: "sync", state: roomState(room) });
        break;
      }

      case "queue:remove":
        if (ws.userId !== room.adminId) return;
        room.queue = room.queue.filter((t) => t.id !== msg.id);
        broadcast(room, { type: "sync", state: roomState(room) });
        break;

      case "next":
        if (ws.userId !== room.adminId) return;
        nextTrack(room);
        broadcast(room, { type: "sync", state: roomState(room) });
        break;

      case "track:ended":
        if (ws.userId !== room.adminId || !room.current) return;
        nextTrack(room);
        broadcast(room, { type: "sync", state: roomState(room) });
        break;
    }
  });

  ws.on("close", () => {
    const room = ws.room;
    if (!room) return;

    room.users.delete(ws);

    if (ws.userId === room.adminId) {
      const nextSocket = room.users.keys().next().value;
      room.adminId = nextSocket ? nextSocket.userId : null;
    }

    broadcast(room, {
      type: "users",
      users: [...room.users.values()],
      adminId: room.adminId,
    });

    if (room.users.size === 0) rooms.delete(room.code);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Sync Music запущен: http://localhost:${PORT}`);
});
