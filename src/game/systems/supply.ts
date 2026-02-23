// ============================================================
// STATECRAFT v3 — Supply Line & Stability Revolt System
// BFS connectivity from capital + low-stability province loss
// Runs AFTER combat flips are applied to DB (step 5.5 in pipeline)
// ============================================================

import type { Country, Province, Resolution } from "../../types/index.js";
import { GAME_CONFIG } from "../config.js";

export interface SupplyContext {
  countries: Country[];                   // full list, including eliminated
  provinces: Province[];                  // FRESH from DB after combat flips + annexations
  adjacencyMap: Map<string, string[]>;    // nuts2Id → adjacent nuts2Ids
  wars: { attackerCountryId: string; defenderCountryId: string }[];  // active wars
}

export interface SupplyResults {
  resolutions: Resolution[];
  provincesToRevolve: { nuts2Id: string; newOwnerId: string }[];
  stabilityDeltas: Map<string, number>;
}

/**
 * BFS from a capital province through only the attacker's owned provinces.
 * Returns the set of nuts2Ids reachable from the capital.
 * Any province NOT in this set is disconnected (cut off from supply lines).
 */
function getConnectedProvinces(
  capitalId: string,
  ownedSet: Set<string>,
  adjacencyMap: Map<string, string[]>
): Set<string> {
  if (!ownedSet.has(capitalId)) return new Set<string>();

  const visited = new Set<string>();
  const queue: string[] = [capitalId];
  visited.add(capitalId);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbors = adjacencyMap.get(current) ?? [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor) && ownedSet.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  return visited;
}

export function processSupplyAndRevolts(ctx: SupplyContext): SupplyResults {
  const resolutions: Resolution[] = [];
  const provincesToRevolve: SupplyResults["provincesToRevolve"] = [];
  const stabilityDeltas = new Map<string, number>();

  function addStability(countryId: string, delta: number) {
    stabilityDeltas.set(countryId, (stabilityDeltas.get(countryId) ?? 0) + delta);
  }

  const countryMap = new Map(ctx.countries.map((c) => [c.countryId, c]));

  const provincesByCountry = new Map<string, Province[]>();
  for (const p of ctx.provinces) {
    if (!provincesByCountry.has(p.ownerId)) provincesByCountry.set(p.ownerId, []);
    provincesByCountry.get(p.ownerId)!.push(p);
  }

  // Track provinces already revolted this pass to prevent double-processing
  const revolvedThisTurn = new Set<string>();

  // Build set of countries that are AT WAR (for supply line checks)
  const countriesAtWar = new Set<string>();
  for (const war of ctx.wars) {
    countriesAtWar.add(war.attackerCountryId);
    countriesAtWar.add(war.defenderCountryId);
  }

  for (const country of ctx.countries) {
    if (country.isEliminated) continue;

    const owned = provincesByCountry.get(country.countryId) ?? [];
    if (owned.length === 0) continue;

    const ownedSet = new Set(owned.map((p) => p.nuts2Id));

    // ================================================================
    // MECHANIC 1: Supply Line Connectivity
    // Disconnected provinces (not reachable from capital via owned land)
    // have a 30% chance to revolt back to their original owner each turn.
    // ONLY APPLIES WHEN THE COUNTRY IS AT WAR.
    // ================================================================
    if (countriesAtWar.has(country.countryId)) {
      const connected = getConnectedProvinces(
        country.capitalProvinceId,
        ownedSet,
        ctx.adjacencyMap
      );

      const disconnected = owned.filter((p) => !connected.has(p.nuts2Id));

      for (const province of disconnected) {
        if (revolvedThisTurn.has(province.nuts2Id)) continue;
        if (Math.random() >= GAME_CONFIG.supplyRevoltChance) continue;

        const originalOwner = countryMap.get(province.originalOwnerId);
        if (!originalOwner || originalOwner.isEliminated) continue;

        revolvedThisTurn.add(province.nuts2Id);
        provincesToRevolve.push({ nuts2Id: province.nuts2Id, newOwnerId: province.originalOwnerId });
        addStability(country.countryId, -1);

        resolutions.push({
          type: "revolt",
          countries: [country.countryId, province.originalOwnerId],
          provinces: [province.nuts2Id],
          description: `${province.name} is cut off from ${country.displayName}'s supply lines and revolts back to ${originalOwner.displayName}! (-1 stability)`,
          stateChanges: [{ country: country.countryId, field: "stability", delta: -1 }],
        });
      }
    }

    // ================================================================
    // MECHANIC 2: Low Stability Province Loss
    // stability <= 2: captured provinces revolt at 10%
    // stability = 0: home provinces revolt at 5% (max once per country)
    // ================================================================
    const currentStability = country.stability;

    if (currentStability <= GAME_CONFIG.lowStabilityRevoltThreshold) {
      const capturedProvinces = owned.filter(
        (p) => p.originalOwnerId !== country.countryId && !revolvedThisTurn.has(p.nuts2Id)
      );

      for (const province of capturedProvinces) {
        if (Math.random() >= GAME_CONFIG.lowStabilityCapturedRevoltChance) continue;

        const originalOwner = countryMap.get(province.originalOwnerId);
        if (!originalOwner || originalOwner.isEliminated) continue;

        revolvedThisTurn.add(province.nuts2Id);
        provincesToRevolve.push({ nuts2Id: province.nuts2Id, newOwnerId: province.originalOwnerId });
        addStability(country.countryId, -1);

        resolutions.push({
          type: "revolt",
          countries: [country.countryId, province.originalOwnerId],
          provinces: [province.nuts2Id],
          description: `Unrest in ${country.displayName}! ${province.name} revolts and returns to ${originalOwner.displayName}! (-1 stability)`,
          stateChanges: [{ country: country.countryId, field: "stability", delta: -1 }],
        });
      }
    }

    if (currentStability === 0) {
      // Home provinces can collapse too — max once per country per turn
      const homeProvinces = owned.filter(
        (p) => p.originalOwnerId === country.countryId && !revolvedThisTurn.has(p.nuts2Id)
      );

      if (homeProvinces.length > 0 && Math.random() < GAME_CONFIG.zeroStabilityHomeRevoltChance) {
        const province = homeProvinces[Math.floor(Math.random() * homeProvinces.length)];
        addStability(country.countryId, -1);

        resolutions.push({
          type: "revolt",
          countries: [country.countryId],
          provinces: [province.nuts2Id],
          description: `Civil collapse in ${country.displayName}! ${province.name} descends into chaos — the government is losing control!`,
          stateChanges: [{ country: country.countryId, field: "stability", delta: -1 }],
        });
      }
    }
  }

  return { resolutions, provincesToRevolve, stabilityDeltas };
}
