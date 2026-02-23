// ============================================================
// STATECRAFT v3 — Country State Database Queries
// ============================================================

import { getSupabase } from "./client.js";
import type { Country } from "../types/index.js";

const db = () => getSupabase();

function snakeToCamel(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    result[camelKey] = value;
  }
  return result;
}

function camelToSnake(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const snakeKey = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    result[snakeKey] = value;
  }
  return result;
}

export async function createCountry(params: {
  gameId: string;
  playerId: string;
  countryId: string;
  displayName: string;
  money: number;
  totalTroops: number;
  tech: number;
  stability: number;
  spyTokens: number;
  capitalProvinceId: string;
  webhookUrl?: string;
}): Promise<Country> {
  const { data, error } = await db()
    .from("countries")
    .insert({
      game_id: params.gameId,
      player_id: params.playerId,
      country_id: params.countryId,
      display_name: params.displayName,
      money: params.money,
      total_troops: params.totalTroops,
      tech: params.tech,
      stability: params.stability,
      spy_tokens: params.spyTokens,
      capital_province_id: params.capitalProvinceId,
      webhook_url: params.webhookUrl ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return snakeToCamel(data) as unknown as Country;
}

export async function getCountries(gameId: string): Promise<Country[]> {
  const { data, error } = await db()
    .from("countries")
    .select()
    .eq("game_id", gameId);
  if (error) throw error;
  return (data ?? []).map((d) => snakeToCamel(d) as unknown as Country);
}

export async function getCountryByPlayer(
  gameId: string,
  playerId: string
): Promise<Country | null> {
  const { data, error } = await db()
    .from("countries")
    .select()
    .eq("game_id", gameId)
    .eq("player_id", playerId)
    .single();
  if (error && error.code !== "PGRST116") throw error;
  return data ? (snakeToCamel(data) as unknown as Country) : null;
}

export async function getCountryById(
  gameId: string,
  countryId: string
): Promise<Country | null> {
  const { data, error } = await db()
    .from("countries")
    .select()
    .eq("game_id", gameId)
    .eq("country_id", countryId)
    .single();
  if (error && error.code !== "PGRST116") throw error;
  return data ? (snakeToCamel(data) as unknown as Country) : null;
}

export async function updateCountry(
  id: string,
  updates: Record<string, unknown>
): Promise<void> {
  const { error } = await db()
    .from("countries")
    .update(camelToSnake(updates))
    .eq("id", id);
  if (error) throw error;
}

export async function annexCountry(
  gameId: string,
  annexedCountryId: string,
  conquerorCountryId: string
): Promise<void> {
  // Mark country as eliminated and annexed
  const { error } = await db()
    .from("countries")
    .update({
      is_eliminated: true,
      annexed_by: conquerorCountryId,
      total_troops: 0,
      money: 0,
    })
    .eq("game_id", gameId)
    .eq("country_id", annexedCountryId);
  if (error) throw error;
}
