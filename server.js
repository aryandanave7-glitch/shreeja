const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const storage = require("node-persist");

// Simple word lists for more memorable IDs
const ADJECTIVES = ["alpha", "beta", "gamma", "delta", "zeta", "nova", "comet", "solar", "lunar", "star"];
const NOUNS = ["fox", "wolf", "hawk", "lion", "tiger", "bear", "crane", "iris", "rose", "maple"];

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});
// --- START: Syrja ID Directory Service ---

// Middleware to parse JSON bodies
app.use(express.json());

// Initialize node-persist
(async () => {
    await storage.init({
        dir: 'syrja_id_store',
        ttl: false, // We will handle TTL manually
    });
    console.log("✅ Syrja ID storage initialized.");
})();

function generateShortId() {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
    const num = Math.floor(100 + Math.random() * 900);
    return `syrja-${adj}-${num}`;
}

// Endpoint to create a new Syrja ID
app.post("/create-id", async (req, res) => {
    const { fullInviteCode } = req.body;
    if (!fullInviteCode) {
        return res.status(400).json({ error: "fullInviteCode is required" });
    }

    let shortId = generateShortId();
    // Ensure the generated ID is unique
    while (await storage.getItem(shortId)) {
        shortId = generateShortId();
    }

    // Store the mapping with a 24-hour TTL (in milliseconds)
    const EXPIRATION_TIME = 24 * 60 * 60 * 1000;
    await storage.setItem(shortId, {
        code: fullInviteCode,
        expiresAt: Date.now() + EXPIRATION_TIME,
    });
    
    // Set a timer to automatically remove the item after it expires
    setTimeout(async () => {
        await storage.removeItem(shortId);
        console.log(`🗑️ Expired and removed Syrja ID: ${shortId}`);
    }, EXPIRATION_TIME);

    console.log(`✅ Created Syrja ID: ${shortId}`);
    res.json({ shortId });
});

// Endpoint to retrieve an invite code from a Syrja ID
app.get("/get-invite/:id", async (req, res) => {
    const { id } = req.params;
    const item = await storage.getItem(id);

    if (item && item.code) {
        // Check for expiration, just in case the setTimeout cleanup failed
        if (Date.now() > item.expiresAt) {
            await storage.removeItem(id);
            console.log(`❓ Attempted to fetch expired ID: ${id}`);
            return res.status(404).json({ error: "ID not found or has expired" });
        }
        console.log(`➡️ Resolved Syrja ID: ${id}`);
        res.json({ fullInviteCode: item.code });
    } else {
        console.log(`❓ Failed to resolve Syrja ID: ${id}`);
        res.status(404).json({ error: "ID not found or has expired" });
    }
});
// --- END: Syrja ID Directory Service ---
// --- START: Simple Rate Limiting ---
const rateLimit = new Map();
const LIMIT = 20; // Max 20 requests
const TIME_FRAME = 60 * 1000; // per 60 seconds (1 minute)

function isRateLimited(socket) {
  const ip = socket.handshake.address;
  const now = Date.now();
  const record = rateLimit.get(ip);

  if (!record) {
    rateLimit.set(ip, { count: 1, startTime: now });
    return false;
  }

  // If time window has passed, reset
  if (now - record.startTime > TIME_FRAME) {
    rateLimit.set(ip, { count: 1, startTime: now });
    return false;
  }

  // If count exceeds limit, block the request
  if (record.count >= LIMIT) {
    return true;
  }

  // Otherwise, increment count and allow
  record.count++;
  return false;
}
// --- END: Simple Rate Limiting ---

// just to confirm server is alive
app.get("/", (req, res) => {
  res.send("✅ Signaling server is running");
});

// Map a user's permanent pubKey to their temporary socket.id
const userSockets = {};

// Helper to normalize keys
function normKey(k){ return (typeof k === 'string') ? k.replace(/\s+/g,'') : k; }

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // Handle client registration
  socket.on("register", (pubKey) => {
    if (isRateLimited(socket)) {
      console.log(`⚠️ Rate limit exceeded for registration by ${socket.handshake.address}`);
      return;
    }
    if (!pubKey) return;
    const key = normKey(pubKey);
    userSockets[key] = socket.id;
    socket.data.pubKey = key; // Store key on socket for later cleanup
    console.log(`🔑 Registered: ${key.slice(0,12)}... -> ${socket.id}`);
  });

  // Handle direct connection requests
  socket.on("request-connection", ({ to, from }) => {
    if (isRateLimited(socket)) {
      console.log(`⚠️ Rate limit exceeded for request-connection by ${socket.handshake.address}`);
      return;
    }
    const targetId = userSockets[normKey(to)];
    if (targetId) {
      io.to(targetId).emit("incoming-request", { from: normKey(from) });
      console.log(`📨 Connection request: ${from.slice(0, 12)}... → ${to.slice(0, 12)}...`);
    } else {
      console.log(`⚠️ Could not deliver request to ${to.slice(0,12)} (not registered/online)`);
    }
  });

  // Handle connection acceptance
  socket.on("accept-connection", ({ to, from }) => {
    const targetId = userSockets[normKey(to)];
    if (targetId) {
      io.to(targetId).emit("connection-accepted", { from: normKey(from) });
      console.log(`✅ Connection accepted: ${from.slice(0, 12)}... → ${to.slice(0, 12)}...`);
    } else {
      console.log(`⚠️ Could not deliver acceptance to ${to.slice(0,12)} (not registered/online)`);
    }
  });

  // server.js - New Code
// -- Video/Voice Call Signaling --
socket.on("call-request", ({ to, from, callType }) => {
    const targetId = userSockets[normKey(to)];
    if (targetId) {
        io.to(targetId).emit("incoming-call", { from: normKey(from), callType });
        console.log(`📞 Call request (${callType}): ${from.slice(0,12)}... → ${to.slice(0,12)}...`);
    }
});

socket.on("call-accepted", ({ to, from }) => {
    const targetId = userSockets[normKey(to)];
    if (targetId) {
        io.to(targetId).emit("call-accepted", { from: normKey(from) });
        console.log(`✔️ Call accepted: ${from.slice(0,12)}... → ${to.slice(0,12)}...`);
    }
});

socket.on("call-rejected", ({ to, from }) => {
    const targetId = userSockets[normKey(to)];
    if (targetId) {
        io.to(targetId).emit("call-rejected", { from: normKey(from) });
        console.log(`❌ Call rejected: ${from.slice(0,12)}... → ${to.slice(0,12)}...`);
    }
});

socket.on("call-ended", ({ to, from }) => {
    const targetId = userSockets[normKey(to)];
    if (targetId) {
        io.to(targetId).emit("call-ended", { from: normKey(from) });
        console.log(`👋 Call ended: ${from.slice(0,12)}... & ${to.slice(0,12)}...`);
    }
});
// ---------------------------------


  // Room and signaling logic remains the same
  socket.on("join", (room) => {
    socket.join(room);
    console.log(`Client ${socket.id} joined ${room}`);
  });

  socket.on("signal", ({ room, payload }) => {
    socket.to(room).emit("signal", payload);
  });

  socket.on("auth", ({ room, payload }) => {
    socket.to(room).emit("auth", payload);
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
    // Clean up the user mapping on disconnect
    if (socket.data.pubKey) {
      delete userSockets[socket.data.pubKey];
      console.log(`🗑️ Unregistered: ${socket.data.pubKey.slice(0, 12)}...`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
