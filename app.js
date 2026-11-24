const $ = (id) => document.getElementById(id);
const store = {
  read(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  write(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  },
};

let authToken = localStorage.getItem("syncAuthToken") || "";
let currentUser = null;
let authMode = "login";
let catalog = [];
let favorites = [];
let friends = [];
let albums = [];
let selectedFriend = null;
let currentRoomState = null;
let socket = null;
let mySocketId = null;
let clockOffset = 0;
let activeTrackUrl = null;
let audioPlayPending = false;
let isSeeking = false;
let toastTimer;

async function api(url, options = {}) {
  const headers = {
    ...(options.headers || {}),
    Authorization: `Bearer ${authToken}`,
  };
  if (options.body) headers["Content-Type"] = "application/json";
  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(data.error || "Не удалось выполнить запрос");
  return data;
}

function toast(message) {
  const node = $("toast");
  if (!node) return;
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 2600);
}

function setAuthMode(mode) {
  authMode = mode;
  $("loginForm").hidden = mode !== "login";
  $("registerForm").hidden = mode !== "register";
  $("authAccount").hidden = true;
  $("authSwitch").hidden = false;
  $("authTitle").textContent =
    mode === "login" ? "С возвращением!" : "Создать аккаунт";
  $("authSubtitle").textContent =
    mode === "login"
      ? "Войди, чтобы слушать музыку вместе"
      : "Присоединяйся к своей музыкальной волне";
  $("authSwitch").innerHTML =
    mode === "login"
      ? 'Нет аккаунта? <button type="button" id="showRegister">Зарегистрироваться</button>'
      : 'Уже есть аккаунт? <button type="button" id="showLogin">Войти</button>';
  $("authError").textContent = "";
}

// Один постоянный обработчик на контейнере переключателя
$("authSwitch").addEventListener("click", (event) => {
  const button = event.target.closest("#showRegister, #showLogin");
  if (!button) return;
  event.preventDefault();
  setAuthMode(button.id === "showRegister" ? "register" : "login");
});

function showAuth() {
  $("authOverlay").hidden = false;
  $("authOverlay").classList.remove("auth-overlay-hidden");
  setAuthMode("login");
}

function hideAuth() {
  $("authOverlay").classList.add("auth-overlay-hidden");
  $("authOverlay").hidden = true;
}

function applyUser(user) {
  currentUser = user;
  const name = user.displayName || user.username;
  $("profileButton").textContent = name[0].toUpperCase();
  $("profileButton").title = `${name} — профиль`;
  $("favoriteOwner").textContent = name.toUpperCase();
  $("roomOwner").textContent = name.toUpperCase();
  $("compareMe").textContent = name.toUpperCase();
  $("resultMe").textContent = name.toUpperCase();
}

async function authRequest(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(data.error || "Не удалось выполнить запрос");
  return data;
}

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.currentTarget);
  $("authError").textContent = "";
  try {
    const data = await authRequest("/api/login", {
      username: f.get("username"),
      password: f.get("password"),
    });
    authToken = data.token;
    localStorage.setItem("syncAuthToken", authToken);
    applyUser(data.user);
    hideAuth();
    await loadAppData();
    toast(`С возвращением, ${data.user.displayName}!`);
  } catch (err) {
    $("authError").textContent = err.message;
  }
});

$("registerForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.currentTarget);
  $("authError").textContent = "";
  try {
    const data = await authRequest("/api/register", {
      displayName: f.get("displayName"),
      username: f.get("username"),
      password: f.get("password"),
    });
    authToken = data.token;
    localStorage.setItem("syncAuthToken", authToken);
    applyUser(data.user);
    hideAuth();
    await loadAppData();
    toast("Аккаунт создан. Добро пожаловать!");
  } catch (err) {
    $("authError").textContent = err.message;
  }
});

async function initializeAuth() {
  if (!authToken) return showAuth();
  try {
    const data = await api("/api/me");
    applyUser(data.user);
    hideAuth();
    await loadAppData();
  } catch (_) {
    authToken = "";
    localStorage.removeItem("syncAuthToken");
    showAuth();
  }
}

function logout() {
  if (socket) socket.close();
  socket = null;
  authToken = "";
  currentUser = null;
  localStorage.removeItem("syncAuthToken");
  $("dropdownMenu").classList.remove("open");
  showAuth();
}

$("logoutButton").addEventListener("click", logout);
$("modalLogout").addEventListener("click", logout);
$("closeAccount").addEventListener("click", hideAuth);

$("profileButton").addEventListener("click", () => {
  if (!currentUser) return showAuth();
  $("loginForm").hidden = true;
  $("registerForm").hidden = true;
  $("authSwitch").hidden = true;
  $("authError").textContent = "";
  $("authTitle").textContent = "Твой профиль";
  $("authSubtitle").textContent = "Аккаунт Sync Music";
  $("accountInfo").textContent =
    `${currentUser.displayName} · @${currentUser.username}`;
  $("authAccount").hidden = false;
  $("authOverlay").hidden = false;
  $("authOverlay").classList.remove("auth-overlay-hidden");
});

function navigate(page) {
  document
    .querySelectorAll(".view")
    .forEach((v) => v.classList.remove("active"));
  const view = $(`view-${page}`);
  if (view) view.classList.add("active");
  $("dropdownMenu").classList.remove("open");
  if (page === "favorites") renderFavorites();
  if (page === "room") renderRoomFavorites();
  if (page === "wave-create") renderCompare();
  if (page === "playlists") renderPlaylists();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

document.addEventListener("click", (e) => {
  const button = e.target.closest("[data-page]");
  if (button) navigate(button.dataset.page);
});

$("menuButton").addEventListener("click", () =>
  $("dropdownMenu").classList.toggle("open"),
);

async function loadAppData() {
  const [musicData, favoriteData, friendData, albumData] = await Promise.all([
    api("/api/music"),
    api("/api/me/favorites"),
    api("/api/friends"),
    api("/api/albums"),
  ]);
  catalog = musicData.tracks || [];
  favorites = favoriteData.tracks || [];
  friends = friendData.friends || [];
  albums = albumData.albums || [];
  renderCatalog();
  renderFavorites();
  renderRoomFavorites();
  renderFriends();
  renderPlaylists();
}

function isFavorite(track) {
  return favorites.some((t) => t.id === track.id);
}

async function toggleFavorite(track, forceRemove = false) {
  const wasFavorite = isFavorite(track);
  try {
    const action = forceRemove ? "remove" : wasFavorite ? "remove" : "add";
    const data = await api("/api/me/favorites", {
      method: "PUT",
      body: JSON.stringify({ track, action }),
    });
    favorites = data.tracks;
    renderCatalog();
    renderFavorites();
    renderRoomFavorites();
    renderCompare();
    toast(action === "add" ? "Добавлено в избранное" : "Убрано из избранного");
  } catch (e) {
    toast(e.message);
  }
}

async function addFavorite(track) {
  if (isFavorite(track)) return toast("Эта песня уже в избранном");
  try {
    const data = await api("/api/me/favorites", {
      method: "PUT",
      body: JSON.stringify({ track, action: "add" }),
    });
    favorites = data.tracks;
    renderCatalog();
    renderFavorites();
    renderRoomFavorites();
    renderCompare();
    toast("Добавлено в избранное");
  } catch (e) {
    toast(e.message);
  }
}

function trackRow(track, options = {}) {
  const row = document.createElement("div");
  row.className = "track-row";

  const title = document.createElement("button");
  title.className = "track-title-button";
  title.textContent = track.title;
  title.title = "Нажми, чтобы добавить или убрать из избранного";
  title.addEventListener("click", () => addFavorite(track));
  row.append(title);

  if (options.favoriteButton !== false) {
    const fav = document.createElement("button");
    fav.className = "track-fav-button";
    fav.textContent = isFavorite(track) ? "♥" : "♡";
    fav.title = isFavorite(track)
      ? "Убрать из избранного"
      : "Добавить в избранное";
    fav.addEventListener("click", () => toggleFavorite(track));
    row.append(fav);
  }

  if (options.queue) {
    const add = document.createElement("button");
    add.textContent = "+";
    add.title = "Добавить в очередь комнаты";
    add.addEventListener("click", () =>
      sendSocket({ type: "queue:add", trackId: track.id }),
    );
    row.append(add);
  }

  if (options.remove) {
    const remove = document.createElement("button");
    remove.textContent = "×";
    remove.title = "Убрать";
    remove.addEventListener("click", () => toggleFavorite(track, true));
    row.append(remove);
  }

  return row;
}

function renderTrackList(container, tracks, options = {}) {
  container.replaceChildren();
  if (!tracks.length) {
    const p = document.createElement("p");
    p.className = "empty-note";
    p.textContent = options.empty || "Здесь пока нет песен";
    container.append(p);
    return;
  }
  tracks.forEach((track) => container.append(trackRow(track, options)));
}

function renderCatalog(query = "") {
  const box = $("homeResults");
  box.replaceChildren();
  const q = query.trim().toLowerCase();
  const found = catalog.filter((t) => t.title.toLowerCase().includes(q));
  $("catalogCount").textContent =
    `${catalog.length} ${plural(catalog.length, "трек", "трека", "треков")}`;

  if (!catalog.length) {
    box.innerHTML =
      '<p class="empty-note">На сервере пока нет музыки. Добавь аудиофайлы в папку <b>public/music</b>, затем обнови страницу.</p>';
    return;
  }
  if (!found.length) {
    box.textContent = "По этому запросу ничего не найдено";
    return;
  }

  found.forEach((track) => {
    const row = document.createElement("div");
    row.className = "search-result";
    const name = document.createElement("button");
    name.className = "track-title-button";
    name.textContent = track.title;
    name.addEventListener("click", () => addFavorite(track));
    const fav = document.createElement("button");
    fav.textContent = isFavorite(track) ? "♥ В избранном" : "+ В избранное";
    fav.addEventListener("click", () => toggleFavorite(track));
    row.append(name, fav);
    box.append(row);
  });
}

function plural(n, one, few, many) {
  const n10 = n % 10,
    n100 = n % 100;
  return n10 === 1 && n100 !== 11
    ? one
    : n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)
      ? few
      : many;
}

$("homeSearch").addEventListener("input", (e) => renderCatalog(e.target.value));

function renderFavorites() {
  const q = $("favoritesSearch").value.toLowerCase();
  renderTrackList(
    $("favoritesList"),
    favorites.filter((t) => t.title.toLowerCase().includes(q)),
    { remove: true },
  );
}
$("favoritesSearch").addEventListener("input", renderFavorites);

function renderRoomFavorites() {
  renderTrackList($("roomFavoriteList"), favorites, { queue: true });
}

async function renderFriends() {
  const select = $("friendSelect");
  const albumSelect = $("albumFriend");
  const current = select.value;
  const friendQuery = $("friendSearch").value.trim().toLowerCase();
  const visibleFriends = friends.filter((friend) =>
    `${friend.displayName} ${friend.username}`
      .toLowerCase()
      .includes(friendQuery),
  );

  select.replaceChildren();
  albumSelect.replaceChildren();

  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = friends.length ? "Выбери друга" : "Сначала добавь друга";
  select.append(empty);

  const empty2 = document.createElement("option");
  empty2.value = "";
  empty2.textContent = friends.length ? "Выбери друга" : "Сначала добавь друга";
  albumSelect.append(empty2);

  visibleFriends.forEach((friend) => {
    const option = document.createElement("option");
    option.value = friend.id;
    option.textContent = friend.displayName;
    select.append(option);
  });

  friends.forEach((friend) => {
    const option = document.createElement("option");
    option.value = friend.id;
    option.textContent = friend.displayName;
    albumSelect.append(option);
  });

  if (visibleFriends.some((f) => f.id === current)) select.value = current;
  if (!select.value && visibleFriends.length)
    select.value = visibleFriends[0].id;

  renderCompare();
}

$("addFriendButton").addEventListener("click", async () => {
  const username = $("friendUsername").value.trim();
  if (!username) return toast("Введи логин пользователя");
  try {
    const data = await api("/api/friends", {
      method: "POST",
      body: JSON.stringify({ username }),
    });
    friends = data.friends;
    $("friendUsername").value = "";
    await renderFriends();
    toast(`${data.friend.displayName} добавлен в друзья`);
  } catch (e) {
    toast(e.message);
  }
});

$("friendUsername").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("addFriendButton").click();
});
$("friendSelect").addEventListener("change", renderCompare);
$("friendSearch").addEventListener("input", renderFriends);

async function renderCompare() {
  $("compareMe").textContent = (
    currentUser?.displayName || "ВАШИ ТРЕКИ"
  ).toUpperCase();
  renderTrackList($("myCompareList"), favorites, {
    empty: "Добавь песни в избранное",
  });

  selectedFriend =
    friends.find((f) => f.id === $("friendSelect").value) || null;
  if (!selectedFriend) {
    renderTrackList($("friendCompareList"), [], {
      empty: "Добавь друга по его логину",
    });
    return;
  }

  try {
    const data = await api(
      `/api/users/${encodeURIComponent(selectedFriend.id)}/favorites`,
    );
    renderTrackList($("friendCompareList"), data.tracks || [], {
      empty: "У друга пока нет избранных песен",
    });
  } catch (e) {
    renderTrackList($("friendCompareList"), [], { empty: e.message });
  }
}

$("createWave").addEventListener("click", async () => {
  if (!selectedFriend) return toast("Сначала выбери друга");
  try {
    const data = await api(
      `/api/users/${encodeURIComponent(selectedFriend.id)}/favorites`,
    );
    const theirs = data.tracks || [];
    $("resultMe").textContent = currentUser.displayName.toUpperCase();
    $("resultFriend").textContent = selectedFriend.displayName.toUpperCase();
    renderTrackList($("resultMyList"), favorites);
    renderTrackList($("resultFriendList"), theirs);
    const shared = favorites.filter((t) => theirs.some((x) => x.id === t.id));
    $("matchCount").textContent = `${shared.length} ОБЩИХ ТРЕКОВ`;
    renderTrackList($("sharedTracks"), shared, {
      empty: "Совпадений пока нет. Можно создать альбом другого типа.",
    });
    navigate("wave-result");
  } catch (e) {
    toast(e.message);
  }
});

$("createAlbum").addEventListener("click", async () => {
  const name = $("albumName").value.trim();
  const friendId = $("albumFriend").value;
  const mode = $("albumMode").value;
  if (!name) return toast("Придумай название альбома");
  if (!friendId) return toast("Выбери друга");
  try {
    const data = await api("/api/albums", {
      method: "POST",
      body: JSON.stringify({ name, friendId, mode }),
    });
    albums.unshift(data.album);
    $("albumName").value = "";
    renderPlaylists();
    toast("Общий альбом создан");
  } catch (e) {
    toast(e.message);
  }
});

function renderPlaylists(filter = "") {
  const box = $("playlistsList");
  box.replaceChildren();
  const filtered = albums.filter((a) =>
    a.name.toLowerCase().includes(filter.toLowerCase()),
  );

  if (!filtered.length) {
    const p = document.createElement("p");
    p.className = "empty-note";
    p.textContent = "Общих альбомов пока нет. Создай первый выше.";
    box.append(p);
    return;
  }

  filtered.forEach((album) => {
    const card = document.createElement("article");
    card.className = "playlist-card";

    const title = document.createElement("h3");
    title.textContent = album.name;

    const meta = document.createElement("p");
    meta.className = "playlist-people";
    meta.textContent = `${album.ownerName} + ${album.sharedWithName} · ${album.tracks.length} песен · ${modeName(album.mode)}`;

    const list = document.createElement("div");
    list.className = "album-track-list";
    renderTrackList(list, album.tracks, { favoriteButton: false, queue: true });

    card.append(title, meta, list);

    if (album.ownerId === currentUser.id) {
      const del = document.createElement("button");
      del.className = "album-delete";
      del.textContent = "Удалить альбом";
      del.addEventListener("click", async () => {
        try {
          await api(`/api/albums/${album.id}`, { method: "DELETE" });
          albums = albums.filter((a) => a.id !== album.id);
          renderPlaylists($("playlistSearch").value);
          toast("Альбом удалён");
        } catch (e) {
          toast(e.message);
        }
      });
      card.append(del);
    }

    box.append(card);
  });
}

function modeName(mode) {
  return mode === "common"
    ? "совпадения"
    : mode === "friend"
      ? "музыка друга"
      : "объединённая музыка";
}

$("playlistSearch").addEventListener("input", (e) =>
  renderPlaylists(e.target.value),
);

function showUserTracks(userId, displayName) {
  api(`/api/users/${encodeURIComponent(userId)}/favorites`)
    .then((data) => {
      $("tracksModalTitle").textContent = `Избранное: ${displayName}`;
      renderTrackList($("tracksModalList"), data.tracks || [], {
        empty: "У этого участника пока нет избранных песен",
      });
      $("tracksModal").hidden = false;
    })
    .catch((e) => toast(e.message));
}

$("closeTracksModal").addEventListener(
  "click",
  () => ($("tracksModal").hidden = true),
);
$("tracksModal").addEventListener("click", (e) => {
  if (e.target === $("tracksModal")) $("tracksModal").hidden = true;
});

function connectRoom() {
  if (!authToken) return showAuth();
  const code = $("roomCodeInput").value.trim().toUpperCase();
  if (!code) return toast("Введи код комнаты");

  if (socket && socket.readyState === WebSocket.OPEN) socket.close();

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}`);
  $("roomConnection").textContent = "Подключаемся...";

  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: "join", token: authToken, room: code }));
  });

  socket.addEventListener("message", (e) => {
    try {
      handleSocketMessage(JSON.parse(e.data));
    } catch (err) {
      console.error(err);
    }
  });

  socket.addEventListener("close", () => {
    $("roomConnection").textContent = "Соединение закрыто";
  });

  socket.addEventListener("error", () => {
    $("roomConnection").textContent = "Ошибка подключения";
  });
}

$("connectRoom").addEventListener("click", connectRoom);

function sendSocket(data) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    toast("Сначала подключись к комнате");
    return false;
  }
  socket.send(JSON.stringify(data));
  return true;
}

function handleSocketMessage(msg) {
  if (msg.type === "auth:error") {
    toast(msg.message || "Нужно войти в аккаунт");
    logout();
  }
  if (msg.type === "welcome") {
    mySocketId = msg.you;
    applyRoomState(msg.state);
    $("roomConnection").textContent = `Комната ${msg.state.code}`;
  }
  if (msg.type === "sync") applyRoomState(msg.state);
  if (msg.type === "users") renderRoomUsers(msg.users, msg.adminId);
}

function applyRoomState(s) {
  currentRoomState = s;
  clockOffset = s.serverTime - Date.now();
  renderRoomUsers(s.users || [], s.adminId);
  renderRoomQueue(s.queue || [], s.current);
  $("nowPlaying").textContent = s.current
    ? s.current.title
    : "Сейчас ничего не играет";

  const admin = Boolean(mySocketId && mySocketId === s.adminId);
  $("adminStatus").textContent = admin
    ? "★ Ты администратор комнаты"
    : "Управление плеером доступно администратору";
  $("roomPlay").style.opacity = admin ? "1" : ".55";
  $("roomPlay").disabled = !admin;
  $("roomNext").disabled = !admin;

  // Одна кнопка управляет и запуском, и паузой.
  $("roomPlay").textContent = s.isPlaying ? "Ⅱ" : "▶";
  $("roomPlay").title = s.isPlaying ? "Пауза" : "Воспроизвести";
  $("roomPlay").setAttribute("aria-label", s.isPlaying ? "Пауза" : "Воспроизвести");

  syncAudio(s);
}

function renderRoomUsers(users, adminId) {
  const box = $("roomUsers");
  box.replaceChildren();
  if (!users.length) {
    const p = document.createElement("p");
    p.className = "empty-note";
    p.textContent = "Пока никого нет";
    box.append(p);
    return;
  }
  users.forEach((u) => {
    const item = document.createElement("button");
    item.className = "guest-item guest-user-button";
    item.textContent = u.nick + (u.id === adminId ? "  ★ Администратор" : "");
    item.title = "Посмотреть избранные песни";
    item.addEventListener("click", () => showUserTracks(u.id, u.nick));
    box.append(item);
  });
}

function renderRoomQueue(queue, current) {
  const box = $("roomQueue");
  box.replaceChildren();
  if (current) {
    const now = document.createElement("div");
    now.className = "queue-item";
    now.textContent = "▶ Сейчас: " + current.title;
    box.append(now);
  }
  queue.forEach((track, i) => {
    const item = document.createElement("div");
    item.className = "queue-item";
    item.textContent = `${i + 1}. ${track.title} — ${track.addedBy}`;
    box.append(item);
  });
}

function targetPosition(s) {
  return Math.max(
    0,
    s.positionAtSync +
      (s.isPlaying ? (Date.now() + clockOffset - s.syncedAt) / 1000 : 0),
  );
}

function syncAudio(s) {
  const audio = $("audio");
  if (!s.current) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    activeTrackUrl = null;
    return;
  }

  if (activeTrackUrl !== s.current.url) {
    activeTrackUrl = s.current.url;
    audio.pause();
    audio.src = s.current.url;
    audio.load();
  }

  const target = targetPosition(s);
  if (audio.readyState >= 1 && Math.abs(audio.currentTime - target) > 0.8) {
    try {
      audio.currentTime = target;
    } catch (_) {}
  }

  if (s.isPlaying && audio.paused) tryAudioPlay();
  if (!s.isPlaying && !audio.paused) audio.pause();
}

function tryAudioPlay() {
  const audio = $("audio");
  if (
    !currentRoomState ||
    !currentRoomState.isPlaying ||
    audioPlayPending ||
    !audio.paused
  )
    return;
  audioPlayPending = true;
  audio
    .play()
    .catch(() => toast("Браузер заблокировал звук. Нажми запуск ещё раз."))
    .finally(() => (audioPlayPending = false));
}

$("roomPlay").addEventListener("click", () => {
  if (!currentRoomState) {
    toast("Сначала подключись к комнате");
    return;
  }

  if (mySocketId !== currentRoomState.adminId) {
    toast("Управлять воспроизведением может только администратор комнаты");
    return;
  }

  sendSocket({ type: currentRoomState.isPlaying ? "pause" : "play" });
});

$("roomNext").addEventListener("click", () => sendSocket({ type: "next" }));

// Перемешивает избранное и добавляет песни в конец очереди комнаты.
$("shuffleFavorites").addEventListener("click", () => {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    toast("Сначала подключись к комнате");
    return;
  }

  if (!favorites.length) {
    toast("В избранном пока нет песен");
    return;
  }

  const shuffled = [...favorites];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  shuffled.forEach((track) => {
    sendSocket({ type: "queue:add", trackId: track.id });
  });

  toast(`Перемешано и добавлено в очередь: ${shuffled.length} песен`);
});

$("addRoomTrack").addEventListener("click", () => {
  const url = $("roomTrackUrl").value.trim();
  if (!url) return toast("Вставь прямую ссылку на MP3");
  const title =
    url
      .split("/")
      .pop()
      .replace(/\.mp3(\?.*)?$/i, "") || "Новый трек";
  if (sendSocket({ type: "queue:add", title, url }))
    $("roomTrackUrl").value = "";
});

$("copyInvite").addEventListener("click", async () => {
  const code = $("roomCodeInput").value.trim().toUpperCase();
  if (!code) return toast("Сначала введи код комнаты");
  try {
    await navigator.clipboard.writeText(code);
    toast("Код комнаты скопирован");
  } catch (_) {
    toast("Код комнаты: " + code);
  }
});

$("roomSearch").addEventListener("input", (e) => {
  const q = e.target.value.toLowerCase();
  const old = $("roomSearchResults");
  if (old) old.remove();
  if (!q) return;

  const matches = catalog
    .filter((t) => t.title.toLowerCase().includes(q))
    .slice(0, 8);
  const list = document.createElement("div");
  list.id = "roomSearchResults";
  list.className = "search-results";

  matches.forEach((track) => {
    const button = document.createElement("button");
    button.className = "search-result";
    button.textContent = "+ " + track.title;
    button.addEventListener("click", () =>
      sendSocket({ type: "queue:add", trackId: track.id }),
    );
    list.append(button);
  });

  $("roomSearch").parentElement.after(list);
});

$("audio").addEventListener("loadedmetadata", () => {
  if (currentRoomState) {
    try {
      $("audio").currentTime = targetPosition(currentRoomState);
    } catch (_) {}
    if (currentRoomState.isPlaying) tryAudioPlay();
  }
});

$("audio").addEventListener("ended", () => {
  if (currentRoomState && mySocketId === currentRoomState.adminId) {
    sendSocket({ type: "track:ended" });
  }
});

$("seek").addEventListener("pointerdown", () => {
  isSeeking = Boolean(
    currentRoomState && mySocketId === currentRoomState.adminId,
  );
});

$("seek").addEventListener("input", () => {
  if (isSeeking)
    $("audioCurrent").textContent = formatTime(Number($("seek").value));
});

$("seek").addEventListener("change", () => {
  if (isSeeking)
    sendSocket({ type: "seek", position: Number($("seek").value) });
  isSeeking = false;
});

function formatTime(value) {
  if (!Number.isFinite(value) || value < 0) return "0:00";
  return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
}

setInterval(() => {
  if (!currentRoomState) return;
  const audio = $("audio");
  const duration = audio.duration || 0;
  const target = targetPosition(currentRoomState);

  $("seek").max = Math.max(duration, 1);
  if (!isSeeking) $("seek").value = Math.min(target, duration || target);
  $("audioCurrent").textContent = formatTime(audio.currentTime);
  $("audioDuration").textContent = formatTime(duration);

  if (
    currentRoomState.isPlaying &&
    audio.readyState >= 1 &&
    !isSeeking &&
    Math.abs(audio.currentTime - target) > 1.6
  ) {
    try {
      audio.currentTime = target;
    } catch (_) {}
  }
}, 500);

$("homePlay")?.addEventListener("click", () =>
  toast("Добавляй треки в очередь музыкальной комнаты, чтобы слушать вместе"),
);
$("favoritesPlay")?.addEventListener("click", () =>
  toast("Добавь избранные песни в очередь комнаты"),
);
$("resultPlay")?.addEventListener("click", () =>
  toast("Добавь песни в очередь комнаты"),
);
$("playlistPlay")?.addEventListener("click", () =>
  toast("Добавь песни альбома в очередь комнаты"),
);

initializeAuth();
