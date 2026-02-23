// ============================================================
// Game Routes — GET /games/current, POST /games/:id/join, GET /games/:id/countries
// Province-based v3
// ============================================================

import { Hono } from "hono";
import { getActiveGame, getGameById } from "../db/games.js";
import { getCountries, createCountry, getCountryByPlayer } from "../db/countries.js";
import { getProvinces, bulkCreateProvinces, getProvincesByOwner } from "../db/provinces.js";
import { getPacts, getPactMembers } from "../db/diplomacy.js";
import { getWars, getUnions, getUnionMembers } from "../db/diplomacy.js";
import { insertGameEvent } from "../db/events.js";
import { COUNTRY_STARTERS, COUNTRY_IDS, getCountryName } from "../game/config.js";
import { authMiddleware } from "../middleware/auth.js";
import countryProvinces from "../data/country-provinces.json" with { type: "json" };
import provinceData from "../data/province-data.json" with { type: "json" };

const game = new Hono();

// Get current active game
game.get("/games/current", async (c) => {
  const active = await getActiveGame();
  if (!active) {
    return c.json({ error: "No active game", game: null });
  }

  const countries = await getCountries(active.id);
  const provinces = await getProvinces(active.id);
  const pacts = await getPacts(active.id);
  const wars = await getWars(active.id);
  const unions = await getUnions(active.id);

  // Build pact members
  const pactData = await Promise.all(
    pacts.map(async (p) => {
      const members = await getPactMembers(p.id);
      return {
        id: p.id,
        name: p.name,
        abbreviation: p.abbreviation,
        color: p.color,
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
        abbreviation: u.abbreviation,
        members: members.map((m) => m.countryId),
        leader: leader?.countryId ?? null,
      };
    })
  );

  return c.json({
    game: {
      id: active.id,
      phase: active.phase,
      turn: active.turn,
      turn_phase: active.turnPhase,
      max_turns: active.maxTurns,
      world_tension: active.worldTension,
      turn_deadline_at: active.turnDeadlineAt,
      player_count: countries.length,
      min_players: active.minPlayers,
      created_at: active.createdAt,
      started_at: active.startedAt,
    },
    countries: countries.map((c) => {
      const owned = provinces.filter((p) => p.ownerId === c.countryId);
      return {
        country_id: c.countryId,
        display_name: c.displayName,
        flag_data: c.flagData,
        money: c.money,
        total_troops: c.totalTroops,
        tech: c.tech,
        stability: c.stability,
        province_count: owned.length,
        total_gdp: owned.reduce((sum, p) => sum + p.gdpValue, 0),
        is_eliminated: c.isEliminated,
        annexed_by: c.annexedBy ?? null,
        capital_province_id: c.capitalProvinceId,
        union_id: c.unionId ?? null,
      };
    }),
    provinces: provinces.map((p) => ({
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
  });
});

// Get available countries for a game
game.get("/games/:id/countries", async (c) => {
  const gameId = c.req.param("id");
  const g = await getGameById(gameId);
  if (!g) return c.json({ error: "Game not found" }, 404);

  const countries = await getCountries(gameId);
  const taken = new Set(countries.map((c) => c.countryId));

  return c.json({
    countries: COUNTRY_IDS.map((id) => {
      const starter = COUNTRY_STARTERS[id];
      const provinceIds = (countryProvinces as Record<string, string[]>)[id] ?? [];
      return {
        id,
        name: starter.name,
        flag: starter.flag,
        money: starter.money,
        troops: starter.troops,
        tech: starter.tech,
        stability: starter.stability,
        province_count: provinceIds.length,
        capital: starter.capitalProvinceId,
        taken: taken.has(id),
      };
    }),
  });
});

// Join a game with a country
game.post("/games/:id/join", authMiddleware, async (c) => {
  const player = c.get("player");
  const gameId = c.req.param("id");
  const body = (await c.req.json()) as { country_id?: string; webhook_url?: string };

  if (!body.country_id) {
    return c.json({ error: "country_id is required" }, 400);
  }

  const g = await getGameById(gameId);
  if (!g) return c.json({ error: "Game not found" }, 404);
  if (g.phase !== "lobby") {
    return c.json({ error: "Game is not in lobby phase" }, 400);
  }

  const starter = COUNTRY_STARTERS[body.country_id];
  if (!starter) {
    return c.json({ error: "Invalid country_id" }, 400);
  }

  // Check if player already in this game
  const existing = await getCountryByPlayer(gameId, player.id);
  if (existing) {
    return c.json({
      error: "You are already in this game",
      country_id: existing.countryId,
    }, 400);
  }

  // Check if country is taken
  const countries = await getCountries(gameId);
  const takenCountry = countries.find((c) => c.countryId === body.country_id);
  if (takenCountry) {
    return c.json({ error: "Country already taken" }, 400);
  }

  // Create country record
  const country = await createCountry({
    gameId,
    playerId: player.id,
    countryId: body.country_id,
    displayName: starter.name,
    money: starter.money,
    totalTroops: starter.troops,
    tech: starter.tech,
    stability: starter.stability,
    spyTokens: starter.spyTokens,
    capitalProvinceId: starter.capitalProvinceId,
    webhookUrl: body.webhook_url,
  });

  // Create provinces for this country
  const provinceIds = (countryProvinces as Record<string, string[]>)[body.country_id] ?? [];
  const pData = provinceData as Record<string, { name: string; gdp: number; population: number; terrain: string }>;
  const troopsPerProvince = Math.floor(starter.troops / provinceIds.length);
  let troopsRemaining = starter.troops;

  const provincesToCreate = provinceIds.map((nuts2Id, i) => {
    const pd = pData[nuts2Id] ?? { name: nuts2Id, gdp: 10, population: 500000, terrain: "plains" };
    const isCapital = nuts2Id === starter.capitalProvinceId;
    const troops = i === provinceIds.length - 1
      ? troopsRemaining
      : troopsPerProvince;
    troopsRemaining -= troopsPerProvince;

    return {
      game_id: gameId,
      nuts2_id: nuts2Id,
      name: pd.name,
      owner_id: body.country_id!,
      original_owner_id: body.country_id!,
      is_capital: isCapital,
      gdp_value: pd.gdp,
      terrain: pd.terrain,
      troops_stationed: troops,
      population: pd.population,
    };
  });

  if (provincesToCreate.length > 0) {
    await bulkCreateProvinces(provincesToCreate);
  }

  await insertGameEvent({
    gameId,
    type: "player_joined",
    turn: 0,
    phase: "lobby",
    data: { country_id: body.country_id, display_name: starter.name },
  });

  return c.json({
    message: `Joined as ${starter.name}`,
    country_id: body.country_id,
    game_id: gameId,
    provinces: provinceIds.length,
  });
});

export default game;
