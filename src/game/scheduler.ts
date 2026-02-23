// ============================================================
// STATECRAFT v3 — Turn Scheduler
// 4-phase turn flow: negotiation → declaration → ultimatum_response → resolution
// ============================================================

import { getGameById, getActiveGame, createGame, updateGame } from "../db/games.js";
import { getCountries } from "../db/countries.js";
import { getTurnSubmissions, submitTurn } from "../db/turns.js";
import { getPendingUltimatums } from "../db/diplomacy.js";
import { insertGameEvent } from "../db/events.js";
import { resolve } from "./engine.js";
import { broadcast } from "../ws/broadcaster.js";
import { GAME_CONFIG } from "./config.js";
import { sendTurnNotifications } from "./notifications.js";

// ---- In-memory locks ----
const advanceLocks = new Map<string, boolean>();

// ---- SSE subscribers ----
const sseSubscribers = new Map<string, Set<(event: object) => void>>();

export function subscribeToGameEvents(
  gameId: string,
  handler: (event: object) => void
): () => void {
  if (!sseSubscribers.has(gameId)) {
    sseSubscribers.set(gameId, new Set());
  }
  sseSubscribers.get(gameId)!.add(handler);

  return () => {
    const handlers = sseSubscribers.get(gameId);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) sseSubscribers.delete(gameId);
    }
  };
}

function notifySSE(gameId: string, event: object) {
  const handlers = sseSubscribers.get(gameId);
  if (!handlers) return;
  for (const handler of handlers) {
    try {
      handler(event);
    } catch {
      handlers.delete(handler);
    }
  }
}

// ---- Deadline timers ----
const deadlineTimers = new Map<string, NodeJS.Timeout>();

export function clearDeadline(gameId: string) {
  const timer = deadlineTimers.get(gameId);
  if (timer) {
    clearTimeout(timer);
    deadlineTimers.delete(gameId);
  }
}

function setDeadline(gameId: string, seconds: number) {
  clearDeadline(gameId);
  const timer = setTimeout(() => forceAdvanceTurn(gameId), seconds * 1000);
  deadlineTimers.set(gameId, timer);
}

// ---- Start a game ----
export async function startGame(gameId: string) {
  const game = await getGameById(gameId);
  if (!game || game.phase !== "lobby") return;

  const deadline = new Date(Date.now() + game.turnDeadlineSeconds * 1000).toISOString();

  await updateGame(gameId, {
    phase: "active",
    turn: 1,
    turnPhase: "negotiation",
    turnDeadlineAt: deadline,
    startedAt: new Date().toISOString(),
  });

  await insertGameEvent({
    gameId, type: "game_start", turn: 1, phase: "negotiation",
    data: { message: "The game has begun!" },
  });

  const startEvent = { type: "game_start", turn: 1, phase: "negotiation", deadline };
  broadcast(gameId, startEvent);
  notifySSE(gameId, startEvent);
  setDeadline(gameId, game.turnDeadlineSeconds);

  // Send webhook notifications to agents
  const freshGame = await getGameById(gameId);
  if (freshGame) {
    const countries = await getCountries(gameId);
    await sendTurnNotifications(freshGame, countries);
  }
}

// ---- Check if all alive players submitted ----
export async function checkAndAdvanceTurn(gameId: string) {
  if (advanceLocks.get(gameId)) return;

  const game = await getGameById(gameId);
  if (!game || game.phase !== "active") return;

  const countries = await getCountries(gameId);
  const alive = countries.filter((c) => !c.isEliminated);
  const submissions = await getTurnSubmissions(gameId, game.turn, game.turnPhase);

  // For ultimatum_response phase, only countries with pending ultimatums need to respond
  let required = alive.length;
  if (game.turnPhase === "ultimatum_response") {
    const pending = await getPendingUltimatums(gameId);
    const countriesWithUltimatums = new Set(pending.map((u) => u.toCountryId));
    required = countriesWithUltimatums.size;
    // If no ultimatums pending, skip this phase entirely
    if (required === 0) {
      advanceLocks.set(gameId, true);
      try { await advanceTurn(gameId); } finally { advanceLocks.delete(gameId); }
      return;
    }
  }

  if (submissions.length >= required) {
    advanceLocks.set(gameId, true);
    try { await advanceTurn(gameId); } finally { advanceLocks.delete(gameId); }
  }
}

// ---- Force advance ----
export async function forceAdvanceTurn(gameId: string) {
  clearDeadline(gameId);
  if (advanceLocks.get(gameId)) return;
  advanceLocks.set(gameId, true);

  try {
    const game = await getGameById(gameId);
    if (!game || game.phase !== "active") return;

    const countries = await getCountries(gameId);
    const alive = countries.filter((c) => !c.isEliminated);
    const submissions = await getTurnSubmissions(gameId, game.turn, game.turnPhase);
    const submitted = new Set(submissions.map((s) => s.playerId));

    // Auto-submit for agents that haven't responded
    for (const c of alive) {
      if (submitted.has(c.playerId)) continue;

      if (game.turnPhase === "negotiation") {
        await submitTurn({
          gameId, playerId: c.playerId, turn: game.turn,
          phase: "negotiation", messages: [],
        });
      } else if (game.turnPhase === "declaration") {
        await submitTurn({
          gameId, playerId: c.playerId, turn: game.turn,
          phase: "declaration",
          actions: [{ action: "neutral" }],
          reasoning: "Auto-submitted (deadline expired)",
          publicStatement: "No comment.",
        });
      } else if (game.turnPhase === "ultimatum_response") {
        // Auto-reject all pending ultimatums
        const pending = await getPendingUltimatums(gameId, c.countryId);
        if (pending.length > 0) {
          await submitTurn({
            gameId, playerId: c.playerId, turn: game.turn,
            phase: "ultimatum_response",
            ultimatumResponses: pending.map((u) => ({
              ultimatumId: u.id,
              response: "reject",
            })),
          });
        }
      }
    }

    await advanceTurn(gameId);
  } finally {
    advanceLocks.delete(gameId);
  }
}

// ---- Core turn advancement ----
async function advanceTurn(gameId: string) {
  clearDeadline(gameId);
  const game = await getGameById(gameId);
  if (!game || game.phase !== "active") return;

  if (game.turnPhase === "negotiation") {
    // → declaration
    const graceMs = GAME_CONFIG.graceDelaySeconds * 1000;
    const deadline = new Date(Date.now() + graceMs + game.turnDeadlineSeconds * 1000).toISOString();

    await updateGame(gameId, { turnPhase: "declaration", turnDeadlineAt: deadline });

    const event = { type: "phase_change", turn: game.turn, phase: "declaration", deadline };
    await insertGameEvent({
      gameId, type: "phase_change", turn: game.turn, phase: "declaration",
      data: { message: "Declaration phase begins", deadline },
    });
    broadcast(gameId, event);
    notifySSE(gameId, event);
    setDeadline(gameId, GAME_CONFIG.graceDelaySeconds + game.turnDeadlineSeconds);

    // Send webhook notifications
    const freshGame = await getGameById(gameId);
    if (freshGame) {
      const countries = await getCountries(gameId);
      await sendTurnNotifications(freshGame, countries);
    }

  } else if (game.turnPhase === "declaration") {
    // → ultimatum_response (or skip if no ultimatums)
    const pending = await getPendingUltimatums(gameId);

    if (pending.length > 0) {
      const deadline = new Date(Date.now() + game.turnDeadlineSeconds * 1000).toISOString();
      await updateGame(gameId, { turnPhase: "ultimatum_response", turnDeadlineAt: deadline });

      // Broadcast declarations first
      const submissions = await getTurnSubmissions(gameId, game.turn, "declaration");
      const countries = await getCountries(gameId);
      const declarations = submissions.map((s) => {
        const c = countries.find((cc) => cc.playerId === s.playerId);
        return {
          country_id: c?.countryId ?? "unknown",
          actions: s.actions,
          public_statement: s.publicStatement,
        };
      });

      const declEvent = { type: "declarations_revealed", turn: game.turn, declarations };
      broadcast(gameId, declEvent);
      notifySSE(gameId, declEvent);

      await insertGameEvent({
        gameId, type: "declarations_revealed", turn: game.turn, phase: "declaration",
        data: { declarations },
      });

      const phaseEvent = { type: "phase_change", turn: game.turn, phase: "ultimatum_response", deadline };
      broadcast(gameId, phaseEvent);
      notifySSE(gameId, phaseEvent);

      await insertGameEvent({
        gameId, type: "phase_change", turn: game.turn, phase: "ultimatum_response",
        data: { message: "Ultimatum response phase begins", pending: pending.length, deadline },
      });

      setDeadline(gameId, game.turnDeadlineSeconds);
    } else {
      // No ultimatums → skip straight to resolution
      await runResolution(gameId, game);
    }

  } else if (game.turnPhase === "ultimatum_response") {
    // → resolution
    await runResolution(gameId, game);
  }
}

async function runResolution(gameId: string, game: { turn: number; turnPhase: string; maxTurns: number; turnDeadlineSeconds: number }) {
  await updateGame(gameId, { turnPhase: "resolution", turnDeadlineAt: null });

  // Broadcast declarations if not already done
  if (game.turnPhase === "declaration") {
    const submissions = await getTurnSubmissions(gameId, game.turn, "declaration");
    const countries = await getCountries(gameId);
    const declarations = submissions.map((s) => {
      const c = countries.find((cc) => cc.playerId === s.playerId);
      return {
        country_id: c?.countryId ?? "unknown",
        actions: s.actions,
        public_statement: s.publicStatement,
      };
    });
    const declEvent = { type: "declarations_revealed", turn: game.turn, declarations };
    broadcast(gameId, declEvent);
    notifySSE(gameId, declEvent);
    await insertGameEvent({
      gameId, type: "declarations_revealed", turn: game.turn, phase: "resolution",
      data: { declarations },
    });
  }

  // Run resolution engine
  await resolve(gameId);

  // Check if game ended
  const updated = await getGameById(gameId);
  if (updated && updated.phase === "active") {
    const nextTurn = game.turn + 1;

    if (nextTurn > game.maxTurns) {
      await updateGame(gameId, {
        phase: "ended",
        endedAt: new Date().toISOString(),
      });
      const endEvent = { type: "game_end", reason: "max_turns" };
      broadcast(gameId, endEvent);
      notifySSE(gameId, endEvent);
      await insertGameEvent({
        gameId, type: "game_end", turn: game.turn, phase: "resolution",
        data: { reason: "max_turns" },
      });
    } else {
      const deadline = new Date(Date.now() + game.turnDeadlineSeconds * 1000).toISOString();
      await updateGame(gameId, {
        turn: nextTurn,
        turnPhase: "negotiation",
        turnDeadlineAt: deadline,
      });

      const turnEvent = { type: "turn_start", turn: nextTurn, phase: "negotiation", deadline };
      broadcast(gameId, turnEvent);
      notifySSE(gameId, turnEvent);
      await insertGameEvent({
        gameId, type: "turn_start", turn: nextTurn, phase: "negotiation", data: { deadline },
      });
      setDeadline(gameId, game.turnDeadlineSeconds);

      // Send webhook notifications
      const freshGame = await getGameById(gameId);
      if (freshGame) {
        const countries = await getCountries(gameId);
        await sendTurnNotifications(freshGame, countries);
      }
    }
  }
}

// ---- Auto-Lobby ----
export async function ensureLobbyExists(): Promise<void> {
  try {
    const existing = await getActiveGame();
    if (existing) {
      console.log(`[lobby] Active game exists: ${existing.id} (${existing.phase})`);
      return;
    }
    const game = await createGame({});
    console.log(`[lobby] No active game found — created new lobby: ${game.id}`);
  } catch (err) {
    console.error("[lobby] Failed to ensure lobby:", err);
  }
}

export function startAutoLobby(): void {
  ensureLobbyExists();
  setInterval(() => { ensureLobbyExists(); }, 60_000);
}
