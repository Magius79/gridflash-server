const http = require("http");
const { WebSocketServer } = require("ws");
const { v4: uuid } = require("uuid");
const { Matchmaker } = require("./matchmaker");

const PORT = process.env.PORT || 3000;
const HEARTBEAT_INTERVAL = 30000;
const SWEEP_INTERVAL = 60000;

const matchmaker = new Matchmaker();

// --- HTTP server for health checks ---
const httpServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    const stats = matchmaker.stats;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      uptime: process.uptime(),
      ...stats,
    }));
    return;
  }

  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("GridFlash Matchmaking Server");
    return;
  }

  res.writeHead(404);
  res.end();
});

// --- WebSocket server ---
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws, req) => {
  const playerId = uuid();
  ws.playerId = playerId;
  ws.isAlive = true;
  ws.joinedAt = Date.now();

  console.log(`[ws] Player ${playerId.slice(0, 8)} connected from ${req.socket.remoteAddress}`);

  // Send welcome with assigned ID
  ws.send(JSON.stringify({
    type: "welcome",
    playerId,
  }));

  // Pong handler for heartbeat
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      console.warn(`[ws] Bad message from ${playerId.slice(0, 8)}`);
      return;
    }

    switch (msg.type) {
      case "find_match":
        matchmaker.enqueue({
          id: playerId,
          ws,
          name: msg.name || `Player ${playerId.slice(0, 4)}`,
        });
        break;

      case "cancel_queue":
        matchmaker.dequeue(playerId);
        ws.send(JSON.stringify({ type: "queue_cancelled" }));
        break;

      case "submit":
      case "next_round":
        matchmaker.handleMessage(playerId, msg);
        break;

      case "ping":
        ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
        break;

      default:
        console.log(`[ws] Unknown message type: ${msg.type}`);
    }
  });

  ws.on("close", () => {
    console.log(`[ws] Player ${playerId.slice(0, 8)} disconnected`);
    matchmaker.handleDisconnect(playerId);
  });

  ws.on("error", (err) => {
    console.error(`[ws] Error for ${playerId.slice(0, 8)}:`, err.message);
  });
});

// --- Heartbeat: detect dead connections ---
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      console.log(`[ws] Terminating stale connection: ${ws.playerId?.slice(0, 8)}`);
      if (ws.playerId) matchmaker.handleDisconnect(ws.playerId);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

// --- Room cleanup sweep ---
const sweep = setInterval(() => {
  matchmaker.sweep();
}, SWEEP_INTERVAL);

// --- Graceful shutdown ---
function shutdown() {
  console.log("[server] Shutting down...");
  clearInterval(heartbeat);
  clearInterval(sweep);

  wss.clients.forEach((ws) => {
    ws.send(JSON.stringify({ type: "server_shutdown" }));
    ws.close();
  });

  wss.close(() => {
    httpServer.close(() => {
      console.log("[server] Goodbye.");
      process.exit(0);
    });
  });

  // Force exit after 5s
  setTimeout(() => process.exit(1), 5000);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// --- Start ---
httpServer.listen(PORT, () => {
  console.log(`[server] GridFlash matchmaking running on port ${PORT}`);
  console.log(`[server] Health check: http://localhost:${PORT}/health`);
});
