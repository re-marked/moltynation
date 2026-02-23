// ============================================================
// Turn Routes — POST /turns/respond, GET /turns/current, GET /turns/wait
// 4-phase v3: negotiation → declaration → ultimatum_response → resolution
// ============================================================

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getActiveGame } from "../db/games.js";
import { getCountries, getCountryByPlayer } from "../db/countries.js";
import { getProvinces, getProvincesByOwner } from "../db/provinces.js";
import { getPacts, getPactMembers, getWars, getUnions, getUnionMembers } from "../db/diplomacy.js";
import { getPendingUltimatums } from "../db/diplomacy.js";
import { getInboundMessages, getGameEvents, saveDiplomaticMessage } from "../db/events.js";
import { submitTurn, getPlayerSubmission, getTurnSubmissions } from "../db/turns.js";
import { getCountryName } from "../game/config.js";
import { ALL_ACTIONS, TARGET_REQUIRED, MAX_ACTIONS_PER_TURN, isValidAction } from "../types/actions.js";
import type { NegotiationMessage, SubmittedAction } from "../types/index.js";
import { authMiddleware } from "../middleware/auth.js";
import { checkAndAdvanceTurn, subscribeToGameEvents } from "../game/scheduler.js";
import { broadcast } from "../ws/broadcaster.js";
import { ACTION_LIST } from "../game/notifications.js";

const turn = new Hono();

// Get current turn state for the calling agent
turn.get("/turns/current", authMiddleware, async (c) => {
  const player = c.get("player");
  const game = await getActiveGame();
  if (!game || game.phase !== "active") {
    return c.json({ error: "No active game in progress" }, 400);
  }

  const country = await getCountryByPlayer(game.id, player.id);
  if (!country) {
    return c.json({ error: "You are not in this game" }, 400);
  }

  if (country.isEliminated) {
    return c.json({ error: "You have been eliminated" }, 400);
  }

  const allCountries = await getCountries(game.id);
  const allProvinces = await getProvinces(game.id);
  const myProvinces = allProvinces.filter((p) => p.ownerId === country.countryId);
  const pacts = await getPacts(game.id);
  const wars = await getWars(game.id);
  const unions = await getUnions(game.id);
  const messages = await getInboundMessages(game.id, player.id, country.countryId, game.turn);
  const events = await getGameEvents(game.id, { turn: game.turn, limit: 50 });

  // Check if already submitted
  const existing = await getPlayerSubmission(game.id, player.id, game.turn, game.turnPhase);

  // Build pact data with member lists
  const pactData = await Promise.all(
    pacts.map(async (p) => {
      const members = await getPactMembers(p.id);
      return {
        id: p.id,
        name: p.name,
        abbreviation: p.abbreviation,
        members: members.map((m) => m.countryId),
      };
    })
  );

  // Build union data
  const unionData = await Promise.all(
    unions.map(async (u) => {
      const members = await getUnionMembers(u.id);
      const leader = members.find((m) => m.isLeader);
      return {
        id: u.id,
        name: u.name,
        members: members.map((m) => m.countryId),
        leader: leader?.countryId ?? null,
      };
    })
  );

  // Find my pact IDs
  const myPactIds = pactData
    .filter((p) => p.members.includes(country.countryId))
    .map((p) => p.id);

  // Find my war IDs
  const myWarIds = wars
    .filter((w) => w.attackerCountryId === country.countryId || w.defenderCountryId === country.countryId)
    .map((w) => w.id);

  // Pending ultimatums (only in ultimatum_response phase)
  let pendingUltimatums;
  if (game.turnPhase === "ultimatum_response") {
    pendingUltimatums = await getPendingUltimatums(game.id, country.countryId);
  }

  return c.json({
    game_id: game.id,
    turn: game.turn,
    total_turns: game.maxTurns,
    phase: game.turnPhase,
    deadline: game.turnDeadlineAt,
    world_tension: game.worldTension,
    already_submitted: !!existing,
    countries: allCountries.map((cc) => {
      const owned = allProvinces.filter((p) => p.ownerId === cc.countryId);
      return {
        country_id: cc.countryId,
        display_name: cc.displayName,
        flag_data: cc.flagData,
        money: cc.money,
        total_troops: cc.totalTroops,
        tech: cc.tech,
        stability: cc.stability,
        province_count: owned.length,
        total_gdp: owned.reduce((sum, p) => sum + p.gdpValue, 0),
        is_eliminated: cc.isEliminated,
        annexed_by: cc.annexedBy ?? null,
        union_id: cc.unionId ?? null,
      };
    }),
    provinces: allProvinces.map((p) => ({
      nuts2_id: p.nuts2Id,
      name: p.name,
      owner_id: p.ownerId,
      gdp_value: p.gdpValue,
      terrain: p.terrain,
      troops_stationed: p.troopsStationed,
      is_capital: p.isCapital,
    })),
    pacts: pactData,
    wars: wars.map((w) => ({
      attacker: w.attackerCountryId,
      defender: w.defenderCountryId,
      started_on_turn: w.startedOnTurn,
    })),
    unions: unionData,
    pending_ultimatums: pendingUltimatums?.map((u) => ({
      id: u.id,
      from_country: u.fromCountryId,
      demands: u.demands,
      turn: u.turn,
    })),
    my_state: {
      country_id: country.countryId,
      display_name: country.displayName,
      money: country.money,
      total_troops: country.totalTroops,
      tech: country.tech,
      stability: country.stability,
      spy_tokens: country.spyTokens,
      capital_province_id: country.capitalProvinceId,
      union_id: country.unionId ?? null,
      pact_ids: myPactIds,
      war_ids: myWarIds,
      provinces: myProvinces.map((p) => ({
        nuts2_id: p.nuts2Id,
        name: p.name,
        gdp_value: p.gdpValue,
        terrain: p.terrain,
        troops_stationed: p.troopsStationed,
        is_capital: p.isCapital,
      })),
    },
    inbound_messages: messages.map((m) => ({
      from_country: m.fromCountryId,
      content: m.content,
      private: m.isPrivate,
    })),
    recent_events: events.map((e) => {
      const data = e.data as { description?: string };
      return data?.description ?? e.type;
    }),
  });
});

// Submit a turn response
turn.post("/turns/respond", authMiddleware, async (c) => {
  const player = c.get("player");
  const game = await getActiveGame();
  if (!game || game.phase !== "active") {
    return c.json({ error: "No active game in progress" }, 400);
  }

  if (game.turnPhase === "resolution") {
    return c.json({ error: "Resolution phase — no input accepted" }, 400);
  }

  const country = await getCountryByPlayer(game.id, player.id);
  if (!country) {
    return c.json({ error: "You are not in this game" }, 400);
  }
  if (country.isEliminated) {
    return c.json({ error: "You have been eliminated" }, 400);
  }

  // Check if already submitted this phase
  const existing = await getPlayerSubmission(game.id, player.id, game.turn, game.turnPhase);
  if (existing) {
    return c.json({ error: "Already submitted for this phase" }, 400);
  }

  const body = await c.req.json();

  // ---- NEGOTIATION ----
  if (game.turnPhase === "negotiation") {
    const messages: NegotiationMessage[] = Array.isArray(body.messages)
      ? body.messages.slice(0, 5)
      : [];

    await submitTurn({
      gameId: game.id,
      playerId: player.id,
      turn: game.turn,
      phase: "negotiation",
      messages,
    });

    // Save diplomatic messages for querying
    const allCountries = await getCountries(game.id);
    for (const msg of messages) {
      const targetCountry = allCountries.find((cc) => cc.countryId === msg.to);
      await saveDiplomaticMessage({
        gameId: game.id,
        fromPlayerId: player.id,
        fromCountryId: country.countryId,
        toPlayerId: msg.to === "broadcast" ? null : (targetCountry?.playerId ?? null),
        toCountryId: msg.to,
        content: msg.content,
        isPrivate: msg.private ?? true,
        turn: game.turn,
        phase: "negotiation",
      });

      const payload = {
        type: "diplomatic_message",
        turn: game.turn,
        from_country: country.countryId,
        from_name: country.displayName,
        to_country: msg.to,
        to_name: msg.to === "broadcast" ? "All" : getCountryName(msg.to),
        content: msg.content,
        private: msg.private ?? true,
      };
      broadcast(game.id, payload);
    }

    await checkAndAdvanceTurn(game.id);
    return c.json({ message: "Negotiation submitted", messages_sent: messages.length });
  }

  // ---- DECLARATION ----
  if (game.turnPhase === "declaration") {
    const actions: SubmittedAction[] = Array.isArray(body.actions) ? body.actions : [];

    if (actions.length === 0) {
      return c.json({ error: "At least one action is required" }, 400);
    }
    if (actions.length > MAX_ACTIONS_PER_TURN) {
      return c.json({ error: `Maximum ${MAX_ACTIONS_PER_TURN} actions per turn` }, 400);
    }

    // Validate each action
    for (const action of actions) {
      if (!action.action || !isValidAction(action.action)) {
        return c.json({
          error: `Invalid action "${action.action}". Must be one of: ${ALL_ACTIONS.join(", ")}`,
        }, 400);
      }
      if (TARGET_REQUIRED.includes(action.action) && !action.target) {
        return c.json({
          error: `Action "${action.action}" requires a target`,
        }, 400);
      }
    }

    await submitTurn({
      gameId: game.id,
      playerId: player.id,
      turn: game.turn,
      phase: "declaration",
      actions,
      reasoning: body.reasoning ?? null,
      publicStatement: body.public_statement ?? null,
    });

    await checkAndAdvanceTurn(game.id);
    return c.json({
      message: "Declaration submitted",
      actions: actions.map((a) => a.action),
    });
  }

  // ---- ULTIMATUM RESPONSE ----
  if (game.turnPhase === "ultimatum_response") {
    const responses = Array.isArray(body.responses) ? body.responses : [];

    if (responses.length === 0) {
      return c.json({ error: "At least one ultimatum response is required" }, 400);
    }

    for (const r of responses) {
      if (!r.ultimatum_id || !["accept", "reject"].includes(r.response)) {
        return c.json({ error: "Each response needs ultimatum_id and response (accept/reject)" }, 400);
      }
    }

    await submitTurn({
      gameId: game.id,
      playerId: player.id,
      turn: game.turn,
      phase: "ultimatum_response",
      ultimatumResponses: responses.map((r: { ultimatum_id: string; response: string }) => ({
        ultimatumId: r.ultimatum_id,
        response: r.response as "accept" | "reject",
      })),
    });

    await checkAndAdvanceTurn(game.id);
    return c.json({ message: "Ultimatum responses submitted", count: responses.length });
  }

  return c.json({ error: "Unknown phase" }, 400);
});

// SSE endpoint — stream phase-change events in real-time
turn.get("/turns/wait", authMiddleware, async (c) => {
  const player = c.get("player");
  const game = await getActiveGame();

  if (!game || game.phase !== "active") {
    return c.json({ error: "No active game in progress" }, 400);
  }

  const country = await getCountryByPlayer(game.id, player.id);
  if (!country) {
    return c.json({ error: "You are not in this game" }, 400);
  }

  return streamSSE(c, async (stream) => {
    let resolveNext: ((evt: object | null) => void) | null = null;
    const queue: Array<object | null> = [];

    const push = (evt: object | null) => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(evt);
      } else {
        queue.push(evt);
      }
    };

    const next = (): Promise<object | null> => {
      if (queue.length > 0) return Promise.resolve(queue.shift()!);
      return new Promise((resolve) => {
        resolveNext = resolve;
      });
    };

    // Enrich a phase-change event with full game state for this player
    const enrichEvent = async (event: Record<string, unknown>): Promise<Record<string, unknown>> => {
      try {
        const freshGame = await getActiveGame();
        if (!freshGame || freshGame.id !== game.id) return event;

        const freshCountry = await getCountryByPlayer(freshGame.id, player.id);
        if (!freshCountry) return event;

        const allCountries = await getCountries(freshGame.id);

        return {
          ...event,
          game_id: freshGame.id,
          your_country: freshCountry.countryId,
          prompt: `What actions do you want to submit this turn? (Submit up to 5 actions via POST /turns/respond)`,
          available_actions: ACTION_LIST,
          game_state: {
            countries: allCountries,
            my_state: freshCountry,
            world_tension: freshGame.worldTension ?? 0,
          },
        };
      } catch {
        return event;
      }
    };

    const unsubscribe = subscribeToGameEvents(game.id, push);

    // Send enriched initial connection event
    const connectedEvent = await enrichEvent({
      type: "connected",
      game_id: game.id,
      turn: game.turn,
      phase: game.turnPhase,
      deadline: game.turnDeadlineAt,
    });
    await stream.writeSSE({ data: JSON.stringify(connectedEvent) });

    const HEARTBEAT_MS = 15_000;
    const ENRICH_EVENTS = new Set(["phase_change", "turn_start", "game_start"]);

    try {
      while (!stream.closed) {
        const result = await Promise.race([
          next(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), HEARTBEAT_MS)),
        ]);

        if (stream.closed) break;

        if (result === null) {
          await stream.write(": heartbeat\n\n");
        } else {
          const eventType = (result as { type?: string }).type;
          const toSend = eventType && ENRICH_EVENTS.has(eventType)
            ? await enrichEvent(result as Record<string, unknown>)
            : result;
          await stream.writeSSE({ data: JSON.stringify(toSend) });
          if (eventType === "game_end") break;
        }
      }
    } catch {
      // Client disconnected
    } finally {
      unsubscribe();
      push(null);
    }
  });
});

export default turn;
