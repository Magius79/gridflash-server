const { v4: uuid } = require("uuid");
const { getDifficulty } = require("./engine/difficulty");
const { generatePattern } = require("./engine/pattern");
const { calculateAccuracy, scoreRound } = require("./engine/scoring");
const { ROUND_TOTAL } = require("./engine/constants");

const ROOM_STATES = {
  WAITING: "waiting",
  COUNTDOWN: "countdown",
  MEMORIZE: "memorize",
  RECALL: "recall",
  ROUND_RESULT: "round_result",
  MATCH_END: "match_end",
  CLOSED: "closed",
};

class Room {
  constructor(player1) {
    this.id = uuid();
    this.state = ROOM_STATES.WAITING;
    this.players = { [player1.id]: player1 };
    this.round = 0;
    this.pattern = [];
    this.difficulty = null;
    this.scores = {};
    this.roundsWon = {};
    this.submissions = {};
    this.recallStartTime = null;
    this.timers = [];

    this.scores[player1.id] = 0;
    this.roundsWon[player1.id] = 0;
  }

  addPlayer(player) {
    this.players[player.id] = player;
    this.scores[player.id] = 0;
    this.roundsWon[player.id] = 0;
  }

  get playerIds() {
    return Object.keys(this.players);
  }

  get isFull() {
    return this.playerIds.length === 2;
  }

  broadcast(type, data = {}) {
    for (const pid of this.playerIds) {
      const player = this.players[pid];
      if (player && player.ws.readyState === 1) {
        player.ws.send(JSON.stringify({ type, ...data }));
      }
    }
  }

  sendTo(playerId, type, data = {}) {
    const player = this.players[playerId];
    if (player && player.ws.readyState === 1) {
      player.ws.send(JSON.stringify({ type, ...data }));
    }
  }

  clearTimers() {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers = [];
  }

  startMatch() {
    if (!this.isFull) return;

    this.broadcast("match_start", {
      roomId: this.id,
      opponent: this.playerIds.map((id) => ({
        id,
        name: this.players[id].name,
      })),
      rounds: ROUND_TOTAL,
    });

    this.startRound();
  }

  startRound() {
    this.round++;
    this.difficulty = getDifficulty(this.round);
    this.pattern = generatePattern(this.difficulty.grid, this.difficulty.colors);
    this.submissions = {};

    // Countdown phase: 3 seconds
    this.state = ROOM_STATES.COUNTDOWN;
    this.broadcast("countdown", { round: this.round });

    const countdownTimer = setTimeout(() => {
      // Memorize phase
      this.state = ROOM_STATES.MEMORIZE;
      this.broadcast("memorize", {
        round: this.round,
        pattern: this.pattern,
        gridSize: this.difficulty.grid,
        colorCount: this.difficulty.colors,
        duration: this.difficulty.time,
      });

      const memorizeTimer = setTimeout(() => {
        // Recall phase
        this.state = ROOM_STATES.RECALL;
        this.recallStartTime = Date.now();
        const recallDuration = this.difficulty.time * 4;

        this.broadcast("recall_start", {
          duration: recallDuration,
        });

        // Auto-submit timeout for players who don't submit
        const recallTimer = setTimeout(() => {
          this.forceSubmitRemaining();
        }, recallDuration + 2000); // 2s grace for network latency

        this.timers.push(recallTimer);
      }, this.difficulty.time);

      this.timers.push(memorizeTimer);
    }, 3000);

    this.timers.push(countdownTimer);
  }

  handleSubmit(playerId, playerPattern) {
    if (this.state !== ROOM_STATES.RECALL) return;
    if (this.submissions[playerId]) return; // already submitted

    const elapsed = Date.now() - this.recallStartTime;
    const accuracy = calculateAccuracy(this.pattern, playerPattern);
    const points = scoreRound(accuracy, elapsed, this.difficulty.time);

    this.submissions[playerId] = {
      pattern: playerPattern,
      time: elapsed,
      accuracy,
      points,
    };

    // Acknowledge receipt
    this.sendTo(playerId, "submit_ack", { received: true });

    // If both submitted, resolve the round
    if (Object.keys(this.submissions).length === 2) {
      this.resolveRound();
    }
  }

  forceSubmitRemaining() {
    for (const pid of this.playerIds) {
      if (!this.submissions[pid]) {
        // Empty submission — timed out
        const emptyPattern = Array(this.difficulty.grid ** 2).fill(null);
        const elapsed = this.difficulty.time * 4 + 2000;
        const accuracy = calculateAccuracy(this.pattern, emptyPattern);
        const points = scoreRound(accuracy, elapsed, this.difficulty.time);

        this.submissions[pid] = {
          pattern: emptyPattern,
          time: elapsed,
          accuracy,
          points,
          timedOut: true,
        };
      }
    }

    if (Object.keys(this.submissions).length === 2) {
      this.resolveRound();
    }
  }

  resolveRound() {
    this.state = ROOM_STATES.ROUND_RESULT;
    const [p1, p2] = this.playerIds;
    const s1 = this.submissions[p1];
    const s2 = this.submissions[p2];

    this.scores[p1] += s1.points;
    this.scores[p2] += s2.points;

    let roundWinner = null;
    if (s1.points > s2.points) {
      this.roundsWon[p1]++;
      roundWinner = p1;
    } else if (s2.points > s1.points) {
      this.roundsWon[p2]++;
      roundWinner = p2;
    }

    // Send each player a personalized result
    for (const pid of this.playerIds) {
      const opponentId = pid === p1 ? p2 : p1;
      const mine = this.submissions[pid];
      const theirs = this.submissions[opponentId];

      this.sendTo(pid, "round_result", {
        round: this.round,
        correctPattern: this.pattern,
        you: {
          accuracy: mine.accuracy,
          time: mine.time,
          points: mine.points,
          timedOut: mine.timedOut || false,
        },
        opponent: {
          accuracy: theirs.accuracy,
          time: theirs.time,
          points: theirs.points,
          timedOut: theirs.timedOut || false,
        },
        youWon: roundWinner === pid,
        draw: roundWinner === null,
        totalScore: this.scores[pid],
        opponentTotalScore: this.scores[opponentId],
        roundsWon: this.roundsWon[pid],
        opponentRoundsWon: this.roundsWon[opponentId],
        roundsPlayed: this.round,
        roundsTotal: ROUND_TOTAL,
      });
    }

    // Check if match is over
    if (this.round >= ROUND_TOTAL) {
      setTimeout(() => this.endMatch(), 500);
    }
  }

  advanceRound() {
    if (this.round >= ROUND_TOTAL) {
      this.endMatch();
    } else {
      this.startRound();
    }
  }

  endMatch() {
    this.state = ROOM_STATES.MATCH_END;
    const [p1, p2] = this.playerIds;

    for (const pid of this.playerIds) {
      const opponentId = pid === p1 ? p2 : p1;
      this.sendTo(pid, "match_end", {
        yourScore: this.scores[pid],
        opponentScore: this.scores[opponentId],
        yourRoundsWon: this.roundsWon[pid],
        opponentRoundsWon: this.roundsWon[opponentId],
        won: this.scores[pid] > this.scores[opponentId],
        draw: this.scores[pid] === this.scores[opponentId],
      });
    }

    this.cleanup();
  }

  handleDisconnect(playerId) {
    this.clearTimers();

    const opponentId = this.playerIds.find((id) => id !== playerId);
    if (opponentId) {
      this.sendTo(opponentId, "opponent_disconnected", {
        message: "Your opponent left the match.",
      });
    }

    this.state = ROOM_STATES.CLOSED;
    this.cleanup();
  }

  cleanup() {
    this.clearTimers();
    // Room will be removed from matchmaker by the server
  }
}

module.exports = { Room, ROOM_STATES };
