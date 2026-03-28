/**
 * Integration test: spins up the server, connects two players,
 * and runs through a full 5-round match.
 *
 * Usage: node test/match-test.js
 */

const { WebSocket } = require("ws");
const { spawn } = require("child_process");
const path = require("path");

const PORT = 4444;
const SERVER_URL = `ws://localhost:${PORT}`;

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function connectPlayer(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SERVER_URL);
    const messages = [];
    let playerId = null;

    ws.on("open", () => {
      console.log(`[${name}] Connected`);
    });

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      messages.push(msg);

      if (msg.type === "welcome") {
        playerId = msg.playerId;
        console.log(`[${name}] ID: ${playerId.slice(0, 8)}`);
        resolve({ ws, messages, getId: () => playerId, name });
      }
    });

    ws.on("error", reject);
  });
}

function waitForType(player, type, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`${player.name}: timeout waiting for ${type}`)),
      timeoutMs
    );

    // Check already received
    const existing = player.messages.find((m) => m.type === type);
    if (existing) {
      clearTimeout(timeout);
      resolve(existing);
      return;
    }

    const handler = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === type) {
        clearTimeout(timeout);
        player.ws.off("message", handler);
        resolve(msg);
      }
    };
    player.ws.on("message", handler);
  });
}

async function run() {
  console.log("Starting server...");
  const server = spawn("node", ["src/server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, PORT: String(PORT) },
    stdio: "pipe",
  });

  server.stdout.on("data", (d) => process.stdout.write(`  [server] ${d}`));
  server.stderr.on("data", (d) => process.stderr.write(`  [server] ${d}`));

  await wait(1000);

  try {
    const p1 = await connectPlayer("Alice");
    const p2 = await connectPlayer("Bob");

    // Both find a match
    p1.ws.send(JSON.stringify({ type: "find_match", name: "Alice" }));
    p2.ws.send(JSON.stringify({ type: "find_match", name: "Bob" }));

    // Wait for match start
    await waitForType(p1, "match_start");
    console.log("\n=== MATCH STARTED ===\n");

    for (let round = 1; round <= 5; round++) {
      // Wait for memorize phase
      const mem = await waitForType(p1, "memorize");
      console.log(`Round ${round}: grid=${mem.gridSize}, colors=${mem.colorCount}, time=${mem.duration}ms`);

      // Wait for recall
      await waitForType(p1, "recall_start");

      // Simulate submissions — p1 submits the correct pattern, p2 submits half-correct
      await wait(500 + Math.random() * 1000);

      const correctPattern = mem.pattern;
      const halfPattern = correctPattern.map((c, i) =>
        i % 2 === 0 ? c : null
      );

      p1.ws.send(JSON.stringify({ type: "submit", pattern: correctPattern }));
      p2.ws.send(JSON.stringify({ type: "submit", pattern: halfPattern }));

      // Wait for round result
      const result = await waitForType(p1, "round_result");
      console.log(
        `  You: ${Math.round(result.you.accuracy * 100)}% (${result.you.points}pts) | ` +
        `Opponent: ${Math.round(result.opponent.accuracy * 100)}% (${result.opponent.points}pts) | ` +
        `${result.youWon ? "WIN" : result.draw ? "DRAW" : "LOSS"}`
      );
      console.log(
        `  Score: ${result.totalScore} vs ${result.opponentTotalScore}`
      );

      // Advance if not last round
      if (round < 5) {
        p1.ws.send(JSON.stringify({ type: "next_round" }));
      }
    }

    // Wait for match end
    const end = await waitForType(p1, "match_end");
    console.log(`\n=== MATCH COMPLETE ===`);
    console.log(`Final: ${end.yourScore} vs ${end.opponentScore}`);
    console.log(`Result: ${end.won ? "VICTORY" : end.draw ? "DRAW" : "DEFEAT"}`);

    p1.ws.close();
    p2.ws.close();

    console.log("\n✅ All tests passed!");
  } catch (err) {
    console.error("\n❌ Test failed:", err.message);
  } finally {
    server.kill("SIGTERM");
    await wait(500);
    process.exit(0);
  }
}

run();
