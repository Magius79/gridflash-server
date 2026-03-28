const { Room, ROOM_STATES } = require("./room");

class Matchmaker {
  constructor() {
    this.queue = [];          // players waiting for a match
    this.rooms = new Map();   // roomId -> Room
    this.playerRoom = new Map(); // playerId -> roomId
  }

  get stats() {
    let activePlayers = 0;
    for (const room of this.rooms.values()) {
      if (room.state !== ROOM_STATES.CLOSED) {
        activePlayers += room.playerIds.length;
      }
    }
    return {
      queued: this.queue.length,
      activeRooms: this.rooms.size,
      activePlayers,
    };
  }

  enqueue(player) {
    // Don't double-queue
    if (this.queue.find((p) => p.id === player.id)) return;
    if (this.playerRoom.has(player.id)) return;

    this.queue.push(player);
    player.ws.send(JSON.stringify({
      type: "queued",
      position: this.queue.length,
    }));

    this.tryMatch();
  }

  dequeue(playerId) {
    this.queue = this.queue.filter((p) => p.id !== playerId);
  }

  tryMatch() {
    while (this.queue.length >= 2) {
      const p1 = this.queue.shift();
      const p2 = this.queue.shift();

      // Verify both still connected
      if (p1.ws.readyState !== 1) {
        if (p2.ws.readyState === 1) this.queue.unshift(p2);
        continue;
      }
      if (p2.ws.readyState !== 1) {
        if (p1.ws.readyState === 1) this.queue.unshift(p1);
        continue;
      }

      this.createRoom(p1, p2);
    }
  }

  createRoom(p1, p2) {
    const room = new Room(p1);
    room.addPlayer(p2);

    this.rooms.set(room.id, room);
    this.playerRoom.set(p1.id, room.id);
    this.playerRoom.set(p2.id, room.id);

    console.log(
      `[match] Room ${room.id.slice(0, 8)} created: ${p1.id.slice(0, 8)} vs ${p2.id.slice(0, 8)}`
    );

    room.startMatch();
  }

  handleMessage(playerId, message) {
    const roomId = this.playerRoom.get(playerId);
    if (!roomId) return;

    const room = this.rooms.get(roomId);
    if (!room) return;

    switch (message.type) {
      case "submit":
        room.handleSubmit(playerId, message.pattern);
        break;

      case "next_round":
        // Only advance if both players signal ready
        // (or auto-advance after a delay — keeping it simple for MVP)
        room.advanceRound();
        break;

      default:
        console.log(`[room] Unknown message type: ${message.type}`);
    }
  }

  handleDisconnect(playerId) {
    // Remove from queue
    this.dequeue(playerId);

    // Handle in-progress match
    const roomId = this.playerRoom.get(playerId);
    if (roomId) {
      const room = this.rooms.get(roomId);
      if (room && room.state !== ROOM_STATES.CLOSED) {
        room.handleDisconnect(playerId);
      }
      this.cleanupRoom(roomId);
    }
  }

  cleanupRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    for (const pid of room.playerIds) {
      this.playerRoom.delete(pid);
    }
    this.rooms.delete(roomId);

    console.log(`[match] Room ${roomId.slice(0, 8)} removed`);
  }

  // Periodic cleanup of stale rooms
  sweep() {
    for (const [roomId, room] of this.rooms) {
      if (room.state === ROOM_STATES.CLOSED || room.state === ROOM_STATES.MATCH_END) {
        this.cleanupRoom(roomId);
      }
    }
  }
}

module.exports = { Matchmaker };
