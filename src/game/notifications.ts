// ============================================================
// STATECRAFT v3 — Push Notification System
// Sends webhooks to agents when turn phases change
// ============================================================

import type { Game, Country } from "../types/index.js";

const ACTION_LIST = [
  { action: "claim_income", description: "Collect GDP revenue from all provinces", cost: null },
  { action: "invest_tech", description: "Increase technology level", cost: "20M", effect: "+1 tech" },
  { action: "invest_military", description: "Recruit additional troops", cost: "variable", effect: "troops based on spending" },
  { action: "invest_stability", description: "Improve national stability", cost: "20M", effect: "+1 stability" },
  { action: "defend", description: "Fortify all provinces (+25% defense bonus)", cost: null },
  { action: "mobilize", description: "Prepare for military action (+10% troops next turn)", cost: null },
  { action: "attack", description: "Launch invasion on adjacent provinces", requires: "target country + province list + troop allocation" },
  { action: "spy_sabotage", description: "Sabotage enemy economy/stability", requires: "target country", cost: "1 spy token" },
];

interface WebhookPayload {
  event: "turn_phase_change";
  game_id: string;
  turn: number;
  phase: string;
  deadline: string;
  your_country: string;
  prompt: string;
  available_actions: typeof ACTION_LIST;
  game_state: {
    countries: Country[];
    my_state: Country | null;
    world_tension: number;
  };
}

export async function sendTurnNotifications(
  game: Game,
  countries: Country[]
): Promise<void> {
  const deadline = new Date(Date.now() + game.turnDeadlineSeconds * 1000).toISOString();

  const webhookCountries = countries.filter((c) => c.webhookUrl && !c.isEliminated);

  if (webhookCountries.length === 0) {
    console.log(`[notifications] No webhook URLs configured for game ${game.id}`);
    return;
  }

  console.log(`[notifications] Sending webhooks to ${webhookCountries.length} players for game ${game.id}, turn ${game.turn}, phase ${game.phase}`);

  // Send webhooks in parallel
  const promises = webhookCountries.map((country) =>
    sendWebhook(game, countries, country, deadline)
  );

  const results = await Promise.allSettled(promises);

  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length > 0) {
    console.error(`[notifications] ${failed.length}/${webhookCountries.length} webhooks failed`);
  } else {
    console.log(`[notifications] All ${webhookCountries.length} webhooks sent successfully`);
  }
}

async function sendWebhook(
  game: Game,
  allCountries: Country[],
  targetCountry: Country,
  deadline: string
): Promise<void> {
  if (!targetCountry.webhookUrl) return;

  const payload: WebhookPayload = {
    event: "turn_phase_change",
    game_id: game.id,
    turn: game.turn,
    phase: game.phase,
    deadline,
    your_country: targetCountry.countryId,
    prompt: `What actions do you want to submit this turn? (Submit up to 5 actions via POST /turns/respond)`,
    available_actions: ACTION_LIST,
    game_state: {
      countries: allCountries,
      my_state: targetCountry,
      world_tension: 0, // TODO: calculate from game state
    },
  };

  try {
    const response = await fetch(targetCountry.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Moltynation/3.0",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000), // 5s timeout
    });

    if (!response.ok) {
      console.error(`[notifications] Webhook failed for ${targetCountry.countryId}: HTTP ${response.status}`);
    } else {
      console.log(`[notifications] Webhook sent to ${targetCountry.countryId} (${targetCountry.webhookUrl})`);
    }
  } catch (error) {
    console.error(`[notifications] Webhook error for ${targetCountry.countryId}:`, error);
  }
}
