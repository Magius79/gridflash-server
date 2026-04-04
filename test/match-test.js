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
    const pending = []; // messages not yet claimed by a waitFor call
    const waiters = []; // { type, resolve } entries

    ws.on("open", () => {
      console.log(`[${name}] Connected`);
    });

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());

      // Check if any waiter wants this message
      const idx = waiters.findIndex((w) => w.type === msg.type);
      if (idx !== -1) {
        const waiter = waiters.splice(idx, 1)[0];
        clearTimeout(waiter.timeout);
        waiter.resolve(msg);
      } else {
        pending.push(msg);
      }
    });

    ws.on("error", reject);

    // Wait for welcome to get player ID
    const player = {
      ws,
      name,
      waitFor(type, timeoutMs = 30000) {
        // Check pending messages first
        const idx = pending.findIndex((m) => m.type === type);
        if (idx !== -1) {
          return Promise.resolve(pending.splice(idx, 1)[0]);
        }

        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            const wIdx = waiters.findIndex((w) => w._id === id);
            if (wIdx !== -1) waiters.splice(wIdx, 1);
            reject(new Error(`${name}: timeout waiting for ${type}`));
          }, timeoutMs);

          const id = Symbol();
          waiters.push({ type, resolve, timeout, _id: id });
        });
      },
    };

    // Resolve once we get the welcome message
    const welcomeHandler = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "welcome") {
        ws.off("message", welcomeHandler);
        player.playerId = msg.playerId;
        console.log(`[${name}] ID: ${msg.playerId.slice(0, 8)}`);
        resolve(player);
      }
    };
    ws.on("message", welcomeHandler);
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
    await p1.waitFor("match_start");
    console.log("\n=== MATCH STARTED ===\n");

    for (let round = 1; round <= 5; round++) {
      // Wait for memorize phase (both players)
      const mem = await p1.waitFor("memorize");
      await p2.waitFor("memorize");
      console.log(`Round ${round}: grid=${mem.gridSize}, colors=${mem.colorCount}, time=${mem.duration}ms`);

      // Wait for recall
      await p1.waitFor("recall_start");
      await p2.waitFor("recall_start");

      // Simulate submissions — p1 submits the correct pattern, p2 submits half-correct
      await wait(500 + Math.random() * 1000);

      const correctPattern = mem.pattern;
      const halfPattern = correctPattern.map((c, i) =>
        i % 2 === 0 ? c : null
      );

      p1.ws.send(JSON.stringify({ type: "submit", pattern: correctPattern }));
      p2.ws.send(JSON.stringify({ type: "submit", pattern: halfPattern }));

      // Wait for round result
      const result = await p1.waitFor("round_result");
      await p2.waitFor("round_result");

      console.log(
        `  You: ${Math.round(result.you.accuracy * 100)}% (${result.you.points}pts) | ` +
        `Opponent: ${Math.round(result.opponent.accuracy * 100)}% (${result.opponent.points}pts) | ` +
        `${result.youWon ? "WIN" : result.draw ? "DRAW" : "LOSS"}`
      );
      console.log(
        `  Score: ${result.totalScore} vs ${result.opponentTotalScore}`
      );

      // Both players advance
      p1.ws.send(JSON.stringify({ type: "next_round" }));
      p2.ws.send(JSON.stringify({ type: "next_round" }));
    }

    // Wait for match end
    const end = await p1.waitFor("match_end");
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
