const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const http = require("http");
const express = require("express");
const session = require("express-session");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const multer = require("multer");
const { Server } = require("socket.io");
require("dotenv").config();

const PORT = Number(process.env.PORT || 3000);
const MAX_USERS = Math.max(1, Number(process.env.MAX_USERS || 10));
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const UPLOAD_DIR = path.join(ROOT, "uploads");
const DB_FILE = path.join(DATA_DIR, "store.json");

for (const dir of [DATA_DIR, UPLOAD_DIR]) fs.mkdirSync(dir, { recursive: true });

const blankDB = () => ({
  users: [],
  friendRequests: [],
  friendships: [],
  messages: []
});

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) return blankDB();
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    return { ...blankDB(), ...parsed };
  } catch {
    return blankDB();
  }
}
let db = loadDB();

/* Upgrade old message records created before message actions existed. */
db.messages.forEach(m => {
  if (!Array.isArray(m.deletedFor)) m.deletedFor = [];
  if (typeof m.forwarded !== "boolean") m.forwarded = false;
  if (!Object.prototype.hasOwnProperty.call(m,"forwardedFrom")) {
    m.forwardedFrom = null;
  }
});
saveDB();

// After a restart/crash nobody is really connected, so clear stale "online" flags.
db.users.forEach(u => { u.online = false; });

function saveDB() {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
  fs.renameSync(tmp, DB_FILE);
}

const MIME_EXT = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp", "image/avif": ".avif",
  "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov"
};
const safeExt = (mime) => MIME_EXT[mime] || ".bin";
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const clean = (v, max = 1000) => String(v ?? "").trim().slice(0, max);
const usernameKey = (v) => clean(v, 30).toLowerCase().replace(/[^a-z0-9_.-]/g, "");
const publicUser = (u) => u && ({
  id: u.id,
  username: u.username,
  displayName: u.displayName,
  avatarUrl: u.avatarUrl || null,
  online: Boolean(u.online),
  lastSeen: u.lastSeen || null
});

function userById(uid) { return db.users.find(u => u.id === uid); }
function userByGoogle(gid) { return db.users.find(u => u.googleId === gid); }
function userByUsername(name) { return db.users.find(u => u.username === usernameKey(name)); }

function areFriends(a, b) {
  return db.friendships.some(f =>
    (f.a === a && f.b === b) || (f.a === b && f.b === a)
  );
}
function friendIds(uid) {
  return db.friendships
    .filter(f => f.a === uid || f.b === uid)
    .map(f => f.a === uid ? f.b : f.a);
}
function friendshipKey(a,b) { return [a,b].sort().join(":"); }

function createUsername(base) {
  let baseName = usernameKey(base) || "user";
  if (baseName.length < 3) baseName += "user";
  baseName = baseName.slice(0, 24);
  let candidate = baseName;
  let n = 1;
  while (userByUsername(candidate)) {
    candidate = `${baseName.slice(0, 24 - String(n).length)}${n++}`;
  }
  return candidate;
}

function makeConversationId(a,b) {
  return [a,b].sort().join("__");
}
function conversationMembers(cid) {
  const parts = String(cid).split("__");
  return parts.length === 2 ? parts : [];
}
function canAccessConversation(uid, cid) {
  const [a,b] = conversationMembers(cid);
  return (a === uid || b === uid) && areFriends(a,b);
}
function messageView(m, viewerId) {
  const sender = userById(m.senderId);
  const deletedForMe =
    Array.isArray(m.deletedFor) &&
    m.deletedFor.includes(viewerId);

  return {
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    senderName: sender?.displayName || sender?.username || "User",
    recipientId: m.recipientId,
    type: m.type,

    text:
      m.deletedAt || deletedForMe
        ? null
        : (
            m.type === "text" &&
            m.oneTime &&
            viewerId === m.recipientId
              ? null
              : m.text
          ),

    mediaUrl:
      m.deletedAt || deletedForMe
        ? null
        : m.mediaUrl,

    mediaName: m.mediaName || null,
    mediaMime: m.mediaMime || null,

    oneTime: Boolean(m.oneTime),
    viewedAt: m.viewedAt || null,
    deletedAt: m.deletedAt || null,
    deletedForMe,
    createdAt: m.createdAt,
    deliveredAt: m.deliveredAt || null,
    readAt: m.readAt || null,
    mine: m.senderId === viewerId,

    forwarded: Boolean(m.forwarded),
    forwardedFrom: m.forwardedFrom || null
  };
}

function auth(req,res,next) {
  if (!req.user) return res.status(401).json({ error:"AUTH_REQUIRED" });
  next();
}
function sendError(res, code, message, status=400) {
  return res.status(status).json({ error: code, message });
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.set("trust proxy", 1);

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || "chatspace-development-secret-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 30
  }
});
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((uid, done) => done(null, userById(uid) || false));

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL || `http://localhost:${PORT}/auth/google/callback`
  }, (accessToken, refreshToken, profile, done) => {
    try {
      const email = profile.emails?.[0]?.value?.toLowerCase() || "";
      let user = userByGoogle(profile.id);
      if (!user && email) user = db.users.find(u => u.email === email);

      if (!user) {
        if (db.users.length >= MAX_USERS) return done(null, false, { message: "ChatSpace is full. Maximum 10 users." });
        const base = profile.displayName || profile.name?.givenName || email.split("@")[0] || "user";
        user = {
          id: id(),
          googleId: profile.id,
          email,
          username: createUsername(base),
          displayName: clean(profile.displayName || base, 60),
          avatarUrl: profile.photos?.[0]?.value || null,
          createdAt: now(),
          lastSeen: now(),
          online: false
        };
        db.users.push(user);
      } else {
        user.googleId = profile.id;
        if (!user.avatarUrl && profile.photos?.[0]?.value) user.avatarUrl = profile.photos[0].value;
      }
      user.lastSeen = now();
      saveDB();
      return done(null, user);
    } catch (e) {
      return done(e);
    }
  }));
}

app.get("/auth/google", (req,res,next) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(503).send("Google OAuth is not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env.");
  }
  passport.authenticate("google", { scope:["profile","email"] })(req,res,next);
});

app.get("/auth/google/callback", (req,res,next) => {
  passport.authenticate("google", (err,user,info) => {
    if (err) {
      console.error("[Google login error]", err.name || "", err.code || "", err.message || err);
      if (err.oauthError) console.error("[Google response]", err.oauthError.statusCode, err.oauthError.data);
      const reason = err.code || err.message || "unknown error";
      return res.redirect(`/?authError=${encodeURIComponent("Google sign-in failed: " + reason)}`);
    }
    if (!user) {
      const message = encodeURIComponent(info?.message || "Google sign-in could not be completed.");
      return res.redirect(`/?authError=${message}`);
    }
    req.logIn(user, (loginErr) => {
      if (loginErr) return next(loginErr);
      user.online = true;
      user.lastSeen = now();
      saveDB();
      return res.redirect("/chat.html");
    });
  })(req,res,next);
});

app.post("/auth/logout", auth, (req,res) => {
  const u = userById(req.user.id);
  if (u) { u.online = false; u.lastSeen = now(); saveDB(); }
  req.logout(() => req.session.destroy(() => res.json({ ok:true })));
});

app.get("/api/me", auth, (req,res) => {
  const u = userById(req.user.id);
  res.json({ user: { ...publicUser(u), email: u.email || null, createdAt: u.createdAt || null } });
});

app.get("/api/stats", (req,res) => res.json({
  users: db.users.length,
  maxUsers: MAX_USERS,
  available: Math.max(0, MAX_USERS - db.users.length)
}));

app.get("/api/friends", auth, (req,res) => {
  const uid = req.user.id;
  const ids = friendIds(uid);
  const pendingIn = db.friendRequests.filter(r => r.to === uid && r.status === "pending");
  const pendingOut = db.friendRequests.filter(r => r.from === uid && r.status === "pending");
  res.json({
    friends: ids.map(x => publicUser(userById(x))).filter(Boolean),
    incoming: pendingIn.map(r => ({ ...r, from: publicUser(userById(r.from)) })),
    outgoing: pendingOut.map(r => ({ ...r, to: publicUser(userById(r.to)) }))
  });
});

app.get("/api/users/search", auth, (req,res) => {
  const q = usernameKey(req.query.q || "");
  if (q.length < 2) return res.json({ users: [] });
  const uid = req.user.id;
  const users = db.users.filter(u =>
    u.id !== uid &&
    u.username.includes(q)
  ).slice(0,10).map(publicUser);
  res.json({ users });
});

app.post("/api/friends/request", auth, (req,res) => {
  const target = userByUsername(req.body.username);
  if (!target) return sendError(res,"NOT_FOUND","Username not found.",404);
  if (target.id === req.user.id) return sendError(res,"SELF","You cannot add yourself.");
  if (areFriends(req.user.id,target.id)) return sendError(res,"ALREADY_FRIENDS","You are already friends.");
  const existing = db.friendRequests.find(r =>
    r.status === "pending" &&
    ((r.from === req.user.id && r.to === target.id) || (r.from === target.id && r.to === req.user.id))
  );
  if (existing) return sendError(res,"REQUEST_EXISTS","A friend request is already pending.");
  const request = { id:id(), from:req.user.id, to:target.id, status:"pending", createdAt:now() };
  db.friendRequests.push(request); saveDB();
  io.to(`user:${target.id}`).emit("friend:request", { ...request, from:publicUser(userById(request.from)) });
  res.json({ ok:true });
});

app.post("/api/friends/respond", auth, (req,res) => {
  const r = db.friendRequests.find(x => x.id === req.body.requestId && x.to === req.user.id && x.status === "pending");
  if (!r) return sendError(res,"NOT_FOUND","Friend request not found.",404);
  const accept = req.body.action === "accept";
  r.status = accept ? "accepted" : "rejected";
  r.respondedAt = now();
  if (accept && !areFriends(r.from,r.to)) {
    db.friendships.push({ id:id(), a:r.from, b:r.to, createdAt:now() });
  }
  saveDB();
  io.to(`user:${r.from}`).emit("friend:updated");
  io.to(`user:${r.to}`).emit("friend:updated");
  res.json({ ok:true, accepted:accept });
});

const avatarStorage = multer.diskStorage({
  destination: (req,file,cb) => cb(null, UPLOAD_DIR),
  filename: (req,file,cb) => cb(null, `avatar-${req.user.id}-${Date.now()}${safeExt(file.mimetype)}`)
});
const avatarUpload = multer({
  storage: avatarStorage,
  limits:{fileSize:5*1024*1024},
  fileFilter:(req,file,cb)=>imageTypes.has(file.mimetype)?cb(null,true):cb(new Error("Profile picture must be an image."))
});
app.post("/api/profile/avatar", auth, avatarUpload.single("avatar"), (req,res) => {
  if(!req.file) return sendError(res,"NO_FILE","Choose an image.");
  const u=userById(req.user.id);
  u.avatarUrl=`/avatar/${path.basename(req.file.path)}`;
  saveDB();
  res.json({ok:true,user:publicUser(u)});
});

app.post("/api/profile", auth, (req,res) => {
  const u = userById(req.user.id);
  const nextUsername = usernameKey(req.body.username);
  const displayName = clean(req.body.displayName,60);
  if (nextUsername) {
    if (nextUsername.length < 3 || nextUsername.length > 30) return sendError(res,"BAD_USERNAME","Username must be 3-30 characters.");
    if (!/^[a-z0-9_.-]+$/.test(nextUsername)) return sendError(res,"BAD_USERNAME","Username can use letters, numbers, dot, underscore and hyphen.");
    const taken = db.users.find(x => x.username === nextUsername && x.id !== u.id);
    if (taken) return sendError(res,"USERNAME_TAKEN","That username is already taken.");
    u.username = nextUsername;
  }
  if (displayName) u.displayName = displayName;
  u.lastSeen = now();
  saveDB();
  res.json({ ok:true, user:publicUser(u) });
});

const imageTypes = new Set(["image/jpeg","image/png","image/gif","image/webp","image/avif"]);
const videoTypes = new Set(["video/mp4","video/webm","video/quicktime"]);
const storage = multer.diskStorage({
  destination: (req,file,cb) => cb(null, UPLOAD_DIR),
  filename: (req,file,cb) => {
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${safeExt(file.mimetype)}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (req,file,cb) => {
    if (imageTypes.has(file.mimetype) || videoTypes.has(file.mimetype)) cb(null,true);
    else cb(new Error("Only image and video files are supported."));
  }
});

app.post("/api/messages/media", auth, upload.single("file"), (req,res) => {
  if (!req.file) return sendError(res,"NO_FILE","Choose an image or video.");
  const other = userById(req.body.recipientId);
  if (!other || !areFriends(req.user.id, other.id)) {
    fs.rmSync(req.file.path,{force:true});
    return sendError(res,"NOT_ALLOWED","You can only message friends.",403);
  }
  const type = imageTypes.has(req.file.mimetype) ? "image" : "video";
  const message = {
    id:id(),
    conversationId:makeConversationId(req.user.id,other.id),
    senderId:req.user.id,
    recipientId:other.id,
    type,
    text:"",
    mediaUrl:`/media/${path.basename(req.file.path)}`,
    mediaName:clean(req.file.originalname,200),
    mediaMime:req.file.mimetype,
    oneTime:String(req.body.oneTime) === "true",
    viewedAt:null,
    deletedAt:null,
    deletedFor:[],
    createdAt:now(),
    deliveredAt: other.online ? now() : null,
    readAt:null
  };
  db.messages.push(message); saveDB();
  const payload = messageView(message, req.user.id);
  io.to(`user:${other.id}`).emit("message:new", messageView(message,other.id));
  io.to(`user:${req.user.id}`).emit("message:new", payload);
  res.json({ ok:true, message:payload });
});

app.get("/avatar/:name", auth, (req,res) => {
  const name=path.basename(req.params.name);
  const file=path.join(UPLOAD_DIR,name);
  if(!name.startsWith(`avatar-`) || !fs.existsSync(file)) return res.status(404).end();
  res.sendFile(file);
});

app.get("/api/media-once/:id", auth, (req,res) => {
  const m = db.messages.find(x => x.id === req.params.id);
  if (!m || !m.oneTime || m.deletedAt) return res.status(404).json({error:"NOT_FOUND"});
  if (m.recipientId !== req.user.id) return res.status(403).json({error:"NOT_ALLOWED"});
  if (m.viewedAt) return res.status(410).json({error:"ONE_TIME_EXPIRED"});
  const name = path.basename(m.mediaUrl || "");
  const file = path.join(UPLOAD_DIR,name);
  if (!fs.existsSync(file)) return res.status(404).json({error:"FILE_NOT_FOUND"});
  m.viewedAt = now(); saveDB();
  io.to(`user:${m.senderId}`).emit("message:viewed",{id:m.id,viewedAt:m.viewedAt});
  res.sendFile(file);
});

app.use("/media", auth, (req,res,next) => {
  const name = path.basename(req.path);
  const file = path.join(UPLOAD_DIR,name);
  const message = db.messages.find(m => m.mediaUrl === `/media/${name}`);
  if (!message || message.deletedAt) return res.status(404).end();
  if (![message.senderId,message.recipientId].includes(req.user.id)) return res.status(403).end();
  if (message.oneTime && req.user.id === message.recipientId && message.viewedAt) return res.status(410).json({error:"ONE_TIME_EXPIRED"});
  req.mediaMessage = message;
  req.mediaFile = file;
  next();
}, (req,res) => {
  if (!fs.existsSync(req.mediaFile)) return res.status(404).end();
  if (req.mediaMessage.oneTime && req.mediaMessage.recipientId === req.user.id) {
    req.mediaMessage.viewedAt = now();
    saveDB();
    io.to(`user:${req.mediaMessage.senderId}`).emit("message:viewed", {
      id:req.mediaMessage.id, viewedAt:req.mediaMessage.viewedAt
    });
  }
  res.sendFile(req.mediaFile);
});

app.get("/api/conversations/:friendId/messages", auth, (req,res) => {
  const fid = req.params.friendId;

  if (!userById(fid) || !areFriends(req.user.id,fid)) {
    return sendError(
      res,
      "NOT_ALLOWED",
      "You can only open a chat with a friend.",
      403
    );
  }

  const cid = makeConversationId(req.user.id,fid);

  const messages = db.messages
    .filter(m =>
      m.conversationId === cid &&
      !(Array.isArray(m.deletedFor) && m.deletedFor.includes(req.user.id))
    )
    .slice(-100)
    .map(m => messageView(m,req.user.id));

  const changed = db.messages.filter(m =>
    m.conversationId === cid &&
    m.recipientId === req.user.id &&
    !m.deliveredAt &&
    !m.deletedAt &&
    !(Array.isArray(m.deletedFor) && m.deletedFor.includes(req.user.id))
  );

  changed.forEach(m => m.deliveredAt = now());

  if (changed.length) saveDB();

  res.json({ messages });
});

app.post("/api/messages/text", auth, (req,res) => {
  const recipient = userById(req.body.recipientId);
  const text = clean(req.body.text,4000);
  if (!recipient || recipient.id === req.user.id) return sendError(res,"BAD_RECIPIENT","Invalid recipient.");
  if (!areFriends(req.user.id,recipient.id)) return sendError(res,"NOT_ALLOWED","You can only message friends.",403);
  if (!text) return sendError(res,"EMPTY","Message is empty.");
  const m = {
    id:id(),
    conversationId:makeConversationId(req.user.id,recipient.id),
    senderId:req.user.id,
    recipientId:recipient.id,
    type:"text",
    text,
    mediaUrl:null, mediaName:null, mediaMime:null,
    oneTime:String(req.body.oneTime) === "true",
    viewedAt:null,
    deletedAt:null,
    deletedFor:[],
    createdAt:now(),
    deliveredAt:recipient.online ? now() : null,
    readAt:null
  };
  db.messages.push(m); saveDB();
  io.to(`user:${recipient.id}`).emit("message:new",messageView(m,recipient.id));
  io.to(`user:${req.user.id}`).emit("message:new",messageView(m,req.user.id));
  res.json({ ok:true, message:messageView(m,req.user.id) });
});

app.post("/api/messages/:id/read", auth, (req,res) => {
  const m = db.messages.find(x => x.id === req.params.id);
  if (!m || m.recipientId !== req.user.id) return sendError(res,"NOT_FOUND","Message not found.",404);
  m.deliveredAt ||= now();
  m.readAt = now();
  saveDB();
  io.to(`user:${m.senderId}`).emit("message:read",{id:m.id,readAt:m.readAt});
  res.json({ok:true});
});

app.post("/api/messages/:id/open-once", auth, (req,res) => {
  const m = db.messages.find(x => x.id === req.params.id);
  if (!m || m.type !== "text" || !m.oneTime || m.deletedAt || m.recipientId !== req.user.id) return sendError(res,"NOT_FOUND","Message not found.",404);
  if (m.viewedAt) return sendError(res,"ONE_TIME_EXPIRED","This one-time message was already opened.",410);
  m.viewedAt = now(); m.deliveredAt ||= m.viewedAt; m.readAt ||= m.viewedAt;
  saveDB();
  io.to(`user:${m.senderId}`).emit("message:viewed",{id:m.id,viewedAt:m.viewedAt});
  res.json({ ok:true, text:m.text });
});

/* ================= MESSAGE ACTIONS ================= */

/* DELETE FOR ME */
app.post("/api/messages/:id/delete-for-me", auth, (req,res) => {
  const m = db.messages.find(x => x.id === req.params.id);

  if (!m) {
    return sendError(res,"NOT_FOUND","Message not found.",404);
  }

  if (![m.senderId,m.recipientId].includes(req.user.id)) {
    return sendError(
      res,
      "NOT_ALLOWED",
      "You cannot delete this message.",
      403
    );
  }

  if (!Array.isArray(m.deletedFor)) {
    m.deletedFor = [];
  }

  if (!m.deletedFor.includes(req.user.id)) {
    m.deletedFor.push(req.user.id);
  }

  saveDB();

  io.to(`user:${req.user.id}`).emit("message:deleted-for-me", {
    id:m.id
  });

  res.json({
    ok:true,
    id:m.id
  });
});


/* DELETE FOR EVERYONE */
app.post("/api/messages/:id/delete-for-everyone", auth, (req,res) => {
  const m = db.messages.find(x => x.id === req.params.id);

  if (!m) {
    return sendError(res,"NOT_FOUND","Message not found.",404);
  }

  if (m.senderId !== req.user.id) {
    return sendError(
      res,
      "NOT_ALLOWED",
      "Only the sender can delete this message for everyone.",
      403
    );
  }

  if (m.deletedAt) {
    return res.json({ ok:true,id:m.id });
  }

  m.deletedAt = now();

  saveDB();

  io.to(`user:${m.senderId}`).emit("message:deleted", {
    id:m.id,
    mode:"everyone"
  });

  io.to(`user:${m.recipientId}`).emit("message:deleted", {
    id:m.id,
    mode:"everyone"
  });

  res.json({
    ok:true,
    id:m.id
  });
});


/* FORWARD */
app.post("/api/messages/:id/forward", auth, (req,res) => {
  const original = db.messages.find(x => x.id === req.params.id);
  const recipient = userById(req.body.recipientId);

  if (!original) {
    return sendError(res,"NOT_FOUND","Message not found.",404);
  }

  if (!recipient || recipient.id === req.user.id) {
    return sendError(res,"BAD_RECIPIENT","Invalid recipient.");
  }

  if (!areFriends(req.user.id,recipient.id)) {
    return sendError(
      res,
      "NOT_ALLOWED",
      "You can only forward to friends.",
      403
    );
  }

  if (![original.senderId,original.recipientId].includes(req.user.id)) {
    return sendError(
      res,
      "NOT_ALLOWED",
      "You cannot forward this message.",
      403
    );
  }

  if (original.deletedAt) {
    return sendError(
      res,
      "DELETED",
      "Deleted messages cannot be forwarded."
    );
  }

  if (original.oneTime) {
    return sendError(
      res,
      "ONE_TIME",
      "One-time messages cannot be forwarded."
    );
  }

  let mediaUrl = null;

  /* Make a separate media copy so forwarding does not depend
     on the original media message staying alive. */
  if (original.type === "image" || original.type === "video") {
    const originalName = path.basename(original.mediaUrl || "");
    const originalFile = path.join(UPLOAD_DIR,originalName);

    if (!originalName || !fs.existsSync(originalFile)) {
      return sendError(
        res,
        "FILE_NOT_FOUND",
        "Original media file is no longer available.",
        404
      );
    }

    const newName =
      `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${safeExt(original.mediaMime)}`;

    const newFile = path.join(UPLOAD_DIR,newName);
    fs.copyFileSync(originalFile,newFile);
    mediaUrl = `/media/${newName}`;
  }

  const forwarded = {
    id:id(),
    conversationId:makeConversationId(req.user.id,recipient.id),
    senderId:req.user.id,
    recipientId:recipient.id,
    type:original.type,
    text:original.type === "text" ? (original.text || "") : "",
    mediaUrl,
    mediaName:original.mediaName || null,
    mediaMime:original.mediaMime || null,
    oneTime:false,
    viewedAt:null,
    deletedAt:null,
    deletedFor:[],
    forwarded:true,
    forwardedFrom:original.id,
    createdAt:now(),
    deliveredAt:recipient.online ? now() : null,
    readAt:null
  };

  db.messages.push(forwarded);
  saveDB();

  const recipientPayload = messageView(forwarded,recipient.id);
  const senderPayload = messageView(forwarded,req.user.id);

  io.to(`user:${recipient.id}`).emit(
    "message:new",
    recipientPayload
  );

  io.to(`user:${req.user.id}`).emit(
    "message:new",
    senderPayload
  );

  res.json({
    ok:true,
    message:senderPayload
  });
});


app.get("/api/health", (req,res) => res.json({ok:true, users:db.users.length, maxUsers:MAX_USERS}));

app.get("/sw.js", (req,res) => { res.set("Cache-Control","no-cache"); res.type("application/javascript").sendFile(path.join(PUBLIC,"sw.js")); });
app.get("/manifest.json", (req,res) => { res.type("application/manifest+json").sendFile(path.join(PUBLIC,"manifest.json")); });
app.use(express.static(PUBLIC));
app.get("/", (req,res) => res.sendFile(path.join(PUBLIC,"index.html")));

const onlineSockets = new Map();
const socketSession = sessionMiddleware;
io.engine.use(socketSession);
io.engine.use(passport.initialize());
io.engine.use(passport.session());

io.use((socket,next) => {
  const user = socket.request.user;
  if (!user) return next(new Error("AUTH_REQUIRED"));
  next();
});

io.on("connection", socket => {
  const user = userById(socket.request.user.id);
  if (!user) return socket.disconnect(true);
  socket.join(`user:${user.id}`);
  socket.join(`presence:${user.id}`);
  onlineSockets.set(user.id,(onlineSockets.get(user.id)||0)+1);
  user.online = true; user.lastSeen = now(); saveDB();
  io.emit("presence",{userId:user.id,online:true,lastSeen:user.lastSeen});

  socket.on("typing", ({recipientId,typing}) => {
    if (recipientId && areFriends(user.id,recipientId)) io.to(`user:${recipientId}`).emit("typing",{userId:user.id,typing:Boolean(typing)});
  });

  socket.on("read", ({messageId}) => {
    const m=db.messages.find(x=>x.id===messageId);
    if (!m || m.recipientId!==user.id) return;
    m.deliveredAt ||= now(); m.readAt=now(); saveDB();
    io.to(`user:${m.senderId}`).emit("message:read",{id:m.id,readAt:m.readAt});
  });

  socket.on("disconnect", () => {
    const count=Math.max(0,(onlineSockets.get(user.id)||1)-1);
    if (count===0) {
      onlineSockets.delete(user.id);
      user.online=false; user.lastSeen=now(); saveDB();
      io.emit("presence",{userId:user.id,online:false,lastSeen:user.lastSeen});
    } else onlineSockets.set(user.id,count);
  });
});

app.use((err,req,res,next) => {
  if (err instanceof multer.MulterError || err?.message?.includes("Only image")) return sendError(res,"UPLOAD_ERROR",err.message,400);
  console.error(err);
  res.status(500).json({error:"SERVER_ERROR",message:"Something went wrong."});
});

server.listen(PORT, () => {
  console.log(`ChatSpace running at http://localhost:${PORT}`);
  const cb = process.env.GOOGLE_CALLBACK_URL || `http://localhost:${PORT}/auth/google/callback`;
  console.log(`Google redirect URI (must match Google Cloud Console EXACTLY): ${cb}`);
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) console.warn("WARNING: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing in .env");
  if (process.env.NODE_ENV === "production" && !cb.startsWith("https://")) console.warn("WARNING: NODE_ENV=production sets secure cookies; over plain http the login will loop back to the home page.");
});
