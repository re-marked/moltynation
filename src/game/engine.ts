// ============================================================
// STATECRAFT v3 — Resolution Engine Orchestrator
// Calls systems in order, applies state changes
// Capital capture = annexation, frontline advance combat
// ============================================================

import { getGameById } from "../db/games.js";
import { getCountries, updateCountry, annexCountry } from "../db/countries.js";
import { getProvinces, updateProvince, transferAllProvinces } from "../db/provinces.js";
import { getCachedAdjacencyMap } from "../db/provinces.js";
import { getTurnSubmissions } from "../db/turns.js";
import { getWars, createWar, endWar, getPacts, getPactMembers } from "../db/diplomacy.js";
import { createPact, addPactMember, removePactMember } from "../db/diplomacy.js";
import { createUltimatum, getPendingUltimatums, updateUltimatum } from "../db/diplomacy.js";
import { createUnion, addUnionMember } from "../db/diplomacy.js";
import { insertGameEvent } from "../db/events.js";
import { recordTrade, insertGameResult } from "../db/trades.js";
import { updateGame } from "../db/games.js";
import { broadcast } from "../ws/broadcaster.js";
import { getCountryName, GAME_CONFIG } from "./config.js";

import { processWorldEvents } from "./systems/world-events.js";
import { processCustomization } from "./systems/customization.js";
import { processUltimatums } from "./systems/ultimatum.js";
import { processCombat } from "./systems/combat.js";
import { processDiplomacy } from "./systems/diplomacy.js";
import { processEspionage } from "./systems/espionage.js";
import { processEconomy } from "./systems/economy.js";
import { processInvestments } from "./systems/investment.js";
import { processPoliticalActions } from "./systems/political.js";
import { processUnionActions } from "./systems/union.js";
import { checkWinConditions } from "./systems/win-conditions.js";
import { processSupplyAndRevolts } from "./systems/supply.js";

import type { Country, Province, Resolution, SubmittedAction, Pact, PactMember } from "../types/index.js";

// In-memory economic leader tracking
const economicLeaderTurns = new Map<string, number>();

export async function resolve(gameId: string) {
  const game = await getGameById(gameId);
  if (!game) return;

  const countries = await getCountries(gameId);
  const allProvinces = await getProvinces(gameId);
  const adjacencyMap = await getCachedAdjacencyMap();
  const wars = await getWars(gameId);
  const pacts = await getPacts(gameId);
  const declarations = await getTurnSubmissions(gameId, game.turn, "declaration");
  const ultimatumSubs = await getTurnSubmissions(gameId, game.turn, "ultimatum_response");

  const countryMap = new Map(countries.map((c) => [c.countryId, c]));
  const provinceMap = new Map(allProvinces.map((p) => [p.nuts2Id, p]));
  const provincesByCountry = new Map<string, Province[]>();
  for (const p of allProvinces) {
    if (!provincesByCountry.has(p.ownerId)) provincesByCountry.set(p.ownerId, []);
    provincesByCountry.get(p.ownerId)!.push(p);
  }

  // Normalize action objects that may arrive with snake_case keys from agents
  function normalizeAction(raw: Record<string, unknown>): SubmittedAction {
    return {
      action: (raw.action as string) as SubmittedAction["action"],
      target: (raw.target as string | undefined),
      targetProvinces: (raw.targetProvinces ?? raw.target_provinces) as string[] | undefined,
      troopAllocation: (raw.troopAllocation ?? raw.troop_allocation) as number | undefined,
      amount: (raw.amount) as number | undefined,
      pactName: (raw.pactName ?? raw.pact_name) as string | undefined,
      pactAbbreviation: (raw.pactAbbreviation ?? raw.pact_abbreviation) as string | undefined,
      pactColor: (raw.pactColor ?? raw.pact_color) as string | undefined,
      newName: (raw.newName ?? raw.new_name) as string | undefined,
      demands: (raw.demands) as SubmittedAction["demands"],
      flagData: (raw.flagData ?? raw.flag_data) as SubmittedAction["flagData"],
    };
  }

  // Parse all submitted actions
  const allActions: { countryId: string; playerId: string; actions: SubmittedAction[] }[] = [];
  for (const sub of declarations) {
    const country = countries.find((c) => c.playerId === sub.playerId);
    if (!country || country.isEliminated) continue;
    const rawActions = (typeof sub.actions === "string" ? JSON.parse(sub.actions) : sub.actions) as Record<string, unknown>[];
    const actions = rawActions.map(normalizeAction);
    allActions.push({ countryId: country.countryId, playerId: sub.playerId, actions });
  }

  // Parse ultimatum responses
  const ultResponses = new Map<string, { ultimatumId: string; response: "accept" | "reject" }[]>();
  for (const sub of ultimatumSubs) {
    const country = countries.find((c) => c.playerId === sub.playerId);
    if (!country) continue;
    const responses = (typeof sub.ultimatumResponses === "string"
      ? JSON.parse(sub.ultimatumResponses)
      : sub.ultimatumResponses) as { ultimatumId: string; response: "accept" | "reject" }[];
    ultResponses.set(country.countryId, responses);
  }

  // Build pact membership map
  const pactMap = new Map<string, { pact: Pact; members: PactMember[] }>();
  for (const pact of pacts) {
    const members = await getPactMembers(pact.id);
    pactMap.set(pact.id, { pact, members });
  }

  // Collect all resolutions
  const allResolutions: Resolution[] = [];

  // Flatten actions for easy filtering
  const flatActions = allActions.flatMap(({ countryId, actions }) =>
    actions.map((a) => ({ countryId, displayName: countryMap.get(countryId)?.displayName ?? countryId, action: a }))
  );

  // ================================================================
  // RESOLUTION PIPELINE
  // ================================================================

  // 1. World events (random)
  const worldRes = processWorldEvents(countries, provincesByCountry);
  allResolutions.push(...worldRes);

  // 2. Customization (name/flag changes)
  const customActions = flatActions.filter((a) =>
    a.action.action === "change_name" || a.action.action === "change_flag"
  );
  const customRes = processCustomization(customActions);
  allResolutions.push(...customRes);

  // Apply customization immediately
  for (const a of customActions) {
    const country = countryMap.get(a.countryId);
    if (!country) continue;
    if (a.action.action === "change_name" && a.action.newName) {
      await updateCountry(country.id, { displayName: a.action.newName });
      country.displayName = a.action.newName;
    }
    if (a.action.action === "change_flag" && a.action.flagData) {
      await updateCountry(country.id, { flagData: a.action.flagData });
    }
  }

  // 3. Ultimatum resolution
  const pendingUltimatums = await getPendingUltimatums(gameId);
  const ultContexts = pendingUltimatums.map((ult) => {
    const responses = ultResponses.get(ult.toCountryId) ?? [];
    const resp = responses.find((r) => r.ultimatumId === ult.id) ?? null;
    return {
      ultimatum: ult,
      response: resp,
      fromCountry: countryMap.get(ult.fromCountryId)!,
      toCountry: countryMap.get(ult.toCountryId)!,
    };
  }).filter((ctx) => ctx.fromCountry && ctx.toCountry);

  const ultResults = processUltimatums(ultContexts);
  allResolutions.push(...ultResults.resolutions);

  // Apply ultimatum results
  for (const ult of pendingUltimatums) {
    const responses = ultResponses.get(ult.toCountryId) ?? [];
    const resp = responses.find((r) => r.ultimatumId === ult.id);
    await updateUltimatum(ult.id, resp?.response === "accept" ? "accepted" : "rejected");
  }
  for (const transfer of ultResults.provincesToTransfer) {
    await updateProvince(gameId, transfer.nuts2Id, { owner_id: transfer.toCountryId });
  }
  for (const mt of ultResults.moneyTransfers) {
    const from = countryMap.get(mt.from);
    const to = countryMap.get(mt.to);
    if (from) await updateCountry(from.id, { money: Math.max(0, from.money - mt.amount) });
    if (to) await updateCountry(to.id, { money: to.money + mt.amount });
  }
  for (const war of ultResults.warsToCreate) {
    const att = countryMap.get(war.attacker);
    const def = countryMap.get(war.defender);
    await createWar({
      gameId,
      attackerCountryId: war.attacker,
      defenderCountryId: war.defender,
      startedOnTurn: game.turn,
      attackerInitialTroops: att?.totalTroops ?? 0,
      defenderInitialTroops: def?.totalTroops ?? 0,
    });
  }

  // 4. New ultimatums sent this turn
  for (const a of flatActions.filter((x) => x.action.action === "send_ultimatum")) {
    if (!a.action.target || !a.action.demands) continue;
    await createUltimatum({
      gameId,
      fromCountryId: a.countryId,
      toCountryId: a.action.target,
      turn: game.turn,
      demands: a.action.demands,
    });
  }

  // 4.5. Auto-declare wars for direct attack actions (no ultimatum required)
  const existingWarPairs = new Set(
    wars.map((w) => `${w.attackerCountryId}:${w.defenderCountryId}`)
  );
  for (const a of flatActions.filter((x) => x.action.action === "attack")) {
    if (!a.action.target) continue;
    const key1 = `${a.countryId}:${a.action.target}`;
    const key2 = `${a.action.target}:${a.countryId}`;
    if (existingWarPairs.has(key1) || existingWarPairs.has(key2)) continue;
    const att = countryMap.get(a.countryId);
    const def = countryMap.get(a.action.target);
    if (!att || !def || att.isEliminated || def.isEliminated) continue;
    await createWar({
      gameId,
      attackerCountryId: a.countryId,
      defenderCountryId: a.action.target,
      startedOnTurn: game.turn,
      attackerInitialTroops: att.totalTroops,
      defenderInitialTroops: def.totalTroops,
    });
    existingWarPairs.add(key1);
  }

  // 5. Combat (province-by-province with adjacency check)
  const attackActions = flatActions
    .filter((a) => a.action.action === "attack")
    .map((a) => {
      const country = countryMap.get(a.countryId);
      const totalTroops = country?.totalTroops ?? 50;
      const intensity = a.action.troopAllocation ?? 5; // 1-10 scale
      // Convert intensity to actual troops: each point = 10% of army
      const actualTroops = Math.max(1, Math.floor(totalTroops * intensity / 10));
      return {
        attackerCountryId: a.countryId,
        attackerDisplayName: a.displayName,
        attackerTech: country?.tech ?? 1,
        targetProvinces: a.action.targetProvinces ?? [],
        troopAllocation: actualTroops,
        isDefending: false,
      };
    });

  const defendingCountries = new Set(
    flatActions.filter((a) => a.action.action === "defend").map((a) => a.countryId)
  );

  // Refresh province data after ultimatum transfers
  const freshProvinces = await getProvinces(gameId);
  const freshProvinceMap = new Map(freshProvinces.map((p) => [p.nuts2Id, p]));

  const combatResults = processCombat({
    provinces: freshProvinceMap,
    countryMap,
    adjacencyMap,
    attackActions,
    defendingCountries,
  });
  allResolutions.push(...combatResults.resolutions);

  // Apply combat results
  for (const flip of combatResults.provincesToFlip) {
    await updateProvince(gameId, flip.nuts2Id, {
      owner_id: flip.newOwnerId,
      troops_stationed: flip.survivingTroops,
    });
  }

  // Apply annexations (capital captured → all provinces transfer)
  for (const annex of combatResults.annexations) {
    await transferAllProvinces(gameId, annex.annexedCountryId, annex.conquerorCountryId);
    await annexCountry(gameId, annex.annexedCountryId, annex.conquerorCountryId);

    // Transfer remaining money
    const annexed = countryMap.get(annex.annexedCountryId);
    const conqueror = countryMap.get(annex.conquerorCountryId);
    if (annexed && conqueror) {
      await updateCountry(conqueror.id, { money: conqueror.money + annexed.money });
    }

    await insertGameEvent({
      gameId,
      type: "annexation",
      turn: game.turn,
      phase: "resolution",
      data: { annexed: annex.annexedCountryId, conqueror: annex.conquerorCountryId },
    });
  }

  // 5.5. Supply lines + stability revolts
  // Query fresh province/country data — combat flips and annexations are now committed to DB
  const postCombatProvinces = await getProvinces(gameId);
  const postCombatCountries = await getCountries(gameId);
  const postCombatWars = await getWars(gameId);

  const supplyResults = processSupplyAndRevolts({
    countries: postCombatCountries,
    provinces: postCombatProvinces,
    adjacencyMap,
    wars: postCombatWars,
  });
  allResolutions.push(...supplyResults.resolutions);

  for (const revolt of supplyResults.provincesToRevolve) {
    await updateProvince(gameId, revolt.nuts2Id, { owner_id: revolt.newOwnerId });
  }

  // 6. Pact operations
  const diplomacyActions = flatActions.filter((a) =>
    ["create_pact", "invite_to_pact", "kick_from_pact", "leave_pact", "betray"].includes(a.action.action)
  );
  const diplomacyResults = processDiplomacy({
    actions: diplomacyActions,
    countryMap,
    pactMap,
    turn: game.turn,
  });
  allResolutions.push(...diplomacyResults.resolutions);

  for (const p of diplomacyResults.pactsToCreate) {
    await createPact({
      gameId, name: p.name, abbreviation: p.abbreviation,
      color: p.color, foundedOnTurn: game.turn, founderCountryId: p.founderCountryId,
    });
  }
  for (const inv of diplomacyResults.pactInvites) {
    await addPactMember(inv.pactId, inv.countryId, game.turn);
  }
  for (const kick of diplomacyResults.pactKicks) {
    await removePactMember(kick.pactId, kick.countryId, game.turn);
  }
  for (const leave of diplomacyResults.pactLeaves) {
    await removePactMember(leave.pactId, leave.countryId, game.turn);
  }

  // 7. Union operations
  const unionActions = flatActions.filter((a) => a.action.action === "propose_union");
  const unionResults = processUnionActions(
    unionActions.map((a) => ({ countryId: a.countryId, displayName: a.displayName, action: a.action })),
    countryMap
  );
  allResolutions.push(...unionResults.resolutions);

  for (const u of unionResults.unionsToPropose) {
    const union = await createUnion({
      gameId, name: u.name ?? "Union", abbreviation: "U",
      foundedOnTurn: game.turn, leaderCountryId: u.proposer,
    });
    await addUnionMember(union.id, u.target, game.turn);
  }

  // 8. Espionage
  const spyActions = flatActions
    .filter((a) => ["spy_intel", "spy_sabotage", "spy_propaganda", "coup_attempt"].includes(a.action.action))
    .map((a) => {
      const c = countryMap.get(a.countryId)!;
      return {
        countryId: a.countryId, displayName: a.displayName,
        tech: c.tech, spyTokens: c.spyTokens, action: a.action,
      };
    });
  const spyRes = processEspionage(spyActions, countryMap);
  allResolutions.push(...spyRes);

  // 9. Trade, sanctions, embargoes (economy)
  const econActions = flatActions
    .filter((a) => ["trade", "sanction", "embargo"].includes(a.action.action))
    .map((a) => ({ countryId: a.countryId, displayName: a.displayName, action: a.action }));

  const claimIncomeCountries = new Set(
    flatActions.filter((a) => a.action.action === "claim_income").map((a) => a.countryId)
  );

  const sanctionCounts = new Map<string, number>();
  const embargoCounts = new Map<string, number>();
  for (const a of flatActions) {
    if (a.action.action === "sanction" && a.action.target) {
      sanctionCounts.set(a.action.target, (sanctionCounts.get(a.action.target) ?? 0) + 1);
    }
    if (a.action.action === "embargo" && a.action.target) {
      embargoCounts.set(a.action.target, (embargoCounts.get(a.action.target) ?? 0) + 1);
    }
  }

  const econResults = processEconomy({
    countries,
    provincesByCountry,
    actions: econActions,
    claimIncomeCountries,
    sanctionCounts,
    embargoCounts,
  });
  allResolutions.push(...econResults.resolutions);

  // 10. Investments
  const investActions = flatActions
    .filter((a) => ["invest_military", "invest_tech", "invest_stability"].includes(a.action.action))
    .map((a) => {
      const c = countryMap.get(a.countryId)!;
      return {
        countryId: a.countryId, displayName: a.displayName,
        money: c.money, tech: c.tech, action: a.action,
      };
    });
  const investResults = processInvestments(investActions);
  allResolutions.push(...investResults.resolutions);

  // 11. Political actions
  const polActions = flatActions
    .filter((a) => ["foreign_aid", "mobilize", "propaganda", "neutral", "arms_deal"].includes(a.action.action))
    .map((a) => {
      const c = countryMap.get(a.countryId)!;
      return {
        countryId: a.countryId, displayName: a.displayName,
        money: c.money, tech: c.tech, totalTroops: c.totalTroops, action: a.action,
      };
    });
  const polResults = processPoliticalActions(polActions, countryMap);
  allResolutions.push(...polResults.resolutions);

  // ================================================================
  // APPLY ALL STATE CHANGES
  // ================================================================

  // Aggregate money/troop/tech/stability changes from all systems
  const moneyDeltas = new Map<string, number>();
  const troopDeltas = new Map<string, number>();
  const techDeltas = new Map<string, number>();
  const stabilityDeltas = new Map<string, number>();
  const spyDeltas = new Map<string, number>();

  function mergeMap(target: Map<string, number>, source: Map<string, number>) {
    for (const [k, v] of source) target.set(k, (target.get(k) ?? 0) + v);
  }

  // From world events
  for (const r of worldRes) {
    for (const sc of r.stateChanges) {
      if (!sc.country) continue;
      if (sc.field === "money") moneyDeltas.set(sc.country, (moneyDeltas.get(sc.country) ?? 0) + sc.delta);
      if (sc.field === "totalTroops") troopDeltas.set(sc.country, (troopDeltas.get(sc.country) ?? 0) + sc.delta);
      if (sc.field === "tech") techDeltas.set(sc.country, (techDeltas.get(sc.country) ?? 0) + sc.delta);
      if (sc.field === "stability") stabilityDeltas.set(sc.country, (stabilityDeltas.get(sc.country) ?? 0) + sc.delta);
    }
  }

  // From combat
  mergeMap(troopDeltas, combatResults.troopLosses);
  // Negate losses (troopLosses are positive, we want negative)
  for (const [k, v] of combatResults.troopLosses) {
    troopDeltas.set(k, (troopDeltas.get(k) ?? 0) - v * 2); // subtract twice to undo the merge then apply negative
  }
  // Actually let's just do it properly
  for (const [k, v] of combatResults.troopLosses) {
    troopDeltas.set(k, -v);
  }

  // From economy
  mergeMap(moneyDeltas, econResults.moneyChanges);
  for (const [k, v] of econResults.troopDesertions) {
    troopDeltas.set(k, (troopDeltas.get(k) ?? 0) - v);
  }

  // From investments
  mergeMap(moneyDeltas, investResults.moneyChanges);
  mergeMap(troopDeltas, investResults.troopChanges);
  mergeMap(techDeltas, investResults.techChanges);
  mergeMap(stabilityDeltas, investResults.stabilityChanges);

  // From political
  mergeMap(moneyDeltas, polResults.moneyChanges);
  mergeMap(troopDeltas, polResults.troopChanges);
  mergeMap(stabilityDeltas, polResults.stabilityChanges);

  // From supply line revolts and stability-based revolts
  mergeMap(stabilityDeltas, supplyResults.stabilityDeltas);

  // From espionage (applied via stateChanges in resolutions)
  for (const r of spyRes) {
    for (const sc of r.stateChanges) {
      if (!sc.country) continue;
      if (sc.field === "money") moneyDeltas.set(sc.country, (moneyDeltas.get(sc.country) ?? 0) + sc.delta);
      if (sc.field === "stability") stabilityDeltas.set(sc.country, (stabilityDeltas.get(sc.country) ?? 0) + sc.delta);
      if (sc.field === "spyTokens") spyDeltas.set(sc.country, (spyDeltas.get(sc.country) ?? 0) + sc.delta);
    }
  }

  // Spy token regen
  for (const c of countries) {
    if (c.isEliminated) continue;
    if (c.spyTokens < GAME_CONFIG.maxSpyTokens) {
      spyDeltas.set(c.countryId, (spyDeltas.get(c.countryId) ?? 0) + GAME_CONFIG.spyTokenRegenPerTurn);
    }
  }

  // Apply to database (batched — parallel updates)
  const countryUpdatePromises: Promise<void>[] = [];
  for (const c of countries) {
    if (c.isEliminated) continue;
    // Skip countries that were annexed this turn
    if (combatResults.annexations.some((a) => a.annexedCountryId === c.countryId)) continue;

    const updates: Record<string, unknown> = {};
    const md = moneyDeltas.get(c.countryId) ?? 0;
    const td = troopDeltas.get(c.countryId) ?? 0;
    const techd = techDeltas.get(c.countryId) ?? 0;
    const stabd = stabilityDeltas.get(c.countryId) ?? 0;
    const spyd = spyDeltas.get(c.countryId) ?? 0;

    if (md !== 0) updates.money = Math.max(0, c.money + md);
    if (td !== 0) updates.totalTroops = Math.max(0, c.totalTroops + td);
    if (techd !== 0) updates.tech = Math.max(0, Math.min(10, c.tech + techd));
    if (stabd !== 0) updates.stability = Math.max(0, Math.min(10, c.stability + stabd));
    if (spyd !== 0) updates.spyTokens = Math.max(0, Math.min(GAME_CONFIG.maxSpyTokens, c.spyTokens + spyd));

    if (Object.keys(updates).length > 0) {
      countryUpdatePromises.push(updateCountry(c.id, updates));
    }
  }
  await Promise.all(countryUpdatePromises);

  // World tension
  let tensionDelta = 0;
  tensionDelta += flatActions.filter((a) => a.action.action === "attack").length * 5;
  tensionDelta += flatActions.filter((a) => a.action.action === "betray").length * 8;
  tensionDelta += flatActions.filter((a) => a.action.action === "embargo").length * 4;
  tensionDelta += flatActions.filter((a) => a.action.action === "coup_attempt").length * 10;
  tensionDelta += flatActions.filter((a) => a.action.action === "mobilize").length * 6;
  tensionDelta -= flatActions.filter((a) => a.action.action === "trade").length * 2;
  tensionDelta -= flatActions.filter((a) => a.action.action === "foreign_aid").length * 3;
  tensionDelta -= flatActions.filter((a) => a.action.action === "neutral").length * 1;

  const newTension = Math.max(0, Math.min(100, game.worldTension + tensionDelta));
  await updateGame(gameId, { worldTension: newTension });

  // Broadcast resolutions
  for (const r of allResolutions) {
    broadcast(gameId, { type: "resolution", turn: game.turn, resolution: r });
    await insertGameEvent({
      gameId, type: "resolution", turn: game.turn, phase: "resolution", data: r,
    });
  }

  // State update broadcast
  const updatedCountries = await getCountries(gameId);
  const updatedProvinces = await getProvinces(gameId);
  broadcast(gameId, {
    type: "state_update",
    turn: game.turn,
    world_tension: newTension,
    countries: updatedCountries.map((c) => ({
      countryId: c.countryId,
      displayName: c.displayName,
      money: c.money,
      totalTroops: c.totalTroops,
      tech: c.tech,
      stability: c.stability,
      isEliminated: c.isEliminated,
      annexedBy: c.annexedBy,
      provinceCount: updatedProvinces.filter((p) => p.ownerId === c.countryId).length,
    })),
  });

  // ================================================================
  // WIN CONDITION CHECK
  // ================================================================

  const winResult = checkWinConditions(
    updatedCountries, updatedProvinces, game.turn, game.maxTurns, economicLeaderTurns
  );

  if (winResult.winner) {
    await endGame(gameId, winResult.winner, updatedCountries, updatedProvinces, winResult.reason!);
  }
}

async function endGame(
  gameId: string,
  winner: Country,
  allCountries: Country[],
  allProvinces: Province[],
  reason: string
) {
  await updateGame(gameId, {
    phase: "ended",
    endedAt: new Date().toISOString(),
    winnerId: winner.playerId,
  });

  const ranked = [...allCountries].sort((a, b) => {
    const aP = allProvinces.filter((p) => p.ownerId === a.countryId).length;
    const bP = allProvinces.filter((p) => p.ownerId === b.countryId).length;
    if (bP !== aP) return bP - aP;
    return b.money - a.money;
  });

  for (let i = 0; i < ranked.length; i++) {
    const c = ranked[i];
    const eloChange = i === 0 ? 25 : Math.max(-15, 10 - i * 5);
    const ownedProvinces = allProvinces.filter((p) => p.ownerId === c.countryId);
    const totalGdp = ownedProvinces.reduce((sum, p) => sum + p.gdpValue, 0);

    await insertGameResult({
      gameId,
      playerId: c.playerId,
      countryId: c.countryId,
      placement: i + 1,
      eloChange,
      finalProvinces: ownedProvinces.length,
      finalTroops: c.totalTroops,
      finalMoney: c.money,
      finalGdp: totalGdp,
    });
  }

  broadcast(gameId, {
    type: "game_end",
    reason,
    winner: { playerId: winner.playerId, countryId: winner.countryId, displayName: winner.displayName },
    standings: ranked.map((c, i) => ({
      placement: i + 1,
      countryId: c.countryId,
      displayName: c.displayName,
      provinces: allProvinces.filter((p) => p.ownerId === c.countryId).length,
      troops: c.totalTroops,
      money: c.money,
    })),
  });

  await insertGameEvent({
    gameId, type: "game_end", turn: 0, phase: "resolution",
    data: { winner: winner.countryId, reason },
  });
}
