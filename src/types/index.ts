// ============================================================
// STATECRAFT v3 — Core TypeScript Types
// Province-based (NUTS2) system with pacts, unions, ultimatums
// ============================================================

// ---- Enums ----

export type GamePhase = "lobby" | "active" | "ended";
export type TurnPhase = "negotiation" | "declaration" | "ultimatum_response" | "resolution";
export type TerrainType = "plains" | "mountains" | "urban" | "coastal";
export type UltimatumStatus = "pending" | "accepted" | "rejected" | "expired";

// ---- Flag Constructor ----

export type FlagPattern =
  | "solid"
  | "horizontal_stripes"
  | "vertical_stripes"
  | "diagonal"
  | "quartered"
  | "cross"
  | "saltire";

export type FlagSymbol =
  | "star"
  | "crescent"
  | "eagle"
  | "lion"
  | "hammer_sickle"
  | "cross"
  | "crown"
  | "sword"
  | "shield"
  | "sun"
  | "none";

export interface FlagData {
  background: string;
  pattern: FlagPattern;
  stripeColors: string[];
  symbolType: FlagSymbol;
  symbolColor: string;
  symbolPosition: "center" | "left" | "right" | "top" | "bottom";
}

// ---- Player ----

export interface Player {
  id: string;
  agentName: string;
  token: string;
  elo: number;
  gamesPlayed: number;
  gamesWon: number;
  createdAt: string;
}

// ---- Game ----

export interface Game {
  id: string;
  phase: GamePhase;
  turn: number;
  turnPhase: TurnPhase;
  maxTurns: number;
  minPlayers: number;
  turnDeadlineSeconds: number;
  turnDeadlineAt: string | null;
  worldTension: number;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  winnerId: string | null;
}

// ---- Country (per-game state) ----

export interface Country {
  id: string;
  gameId: string;
  playerId: string;
  countryId: string;        // base country ID (e.g. "france")
  displayName: string;      // can be changed via change_name action
  flagData: FlagData | null;
  money: number;            // in M (millions)
  totalTroops: number;      // in K (thousands), derived from provinces
  tech: number;             // 0-10
  stability: number;        // 0-10
  spyTokens: number;
  isEliminated: boolean;
  annexedBy: string | null;
  capitalProvinceId: string; // nuts2_id of this country's capital
  unionId: string | null;
  joinedAt: string;
  webhookUrl: string | null; // URL to POST turn notifications to
}

// ---- Province ----

export interface Province {
  id: string;
  gameId: string;
  nuts2Id: string;          // NUTS2 code (e.g. "FR10", "DE11")
  name: string;
  ownerId: string;          // country_id of the owner
  originalOwnerId: string;  // who started with this province
  isCapital: boolean;       // capital province — capturing this annexes the country
  gdpValue: number;         // GDP in M (millions)
  terrain: TerrainType;
  troopsStationed: number;  // in K (thousands)
  population: number;       // for display
}

// ---- Province Adjacency (reference table) ----

export interface ProvinceAdjacency {
  nuts2IdA: string;
  nuts2IdB: string;
}

// ---- Ultimatum ----

export interface Ultimatum {
  id: string;
  gameId: string;
  fromCountryId: string;
  toCountryId: string;
  turn: number;
  demands: UltimatumDemand;
  status: UltimatumStatus;
  respondedAt: string | null;
  createdAt: string;
}

export interface UltimatumDemand {
  type: "cede_province" | "pay_money" | "break_pact" | "become_vassal" | "custom";
  provinceIds?: string[];   // for cede_province
  amount?: number;          // for pay_money
  pactId?: string;          // for break_pact
  description?: string;     // for custom demands
}

// ---- Pact (named multi-member alliance) ----

export interface Pact {
  id: string;
  gameId: string;
  name: string;
  abbreviation: string;     // max 5 chars
  color: string;            // hex color
  foundedOnTurn: number;
  isActive: boolean;
  createdAt: string;
}

export interface PactMember {
  id: string;
  pactId: string;
  countryId: string;
  joinedOnTurn: number;
  leftOnTurn: number | null;
  isActive: boolean;
}

// ---- War ----

export interface War {
  id: string;
  gameId: string;
  attackerCountryId: string;
  defenderCountryId: string;
  startedOnTurn: number;
  endedOnTurn: number | null;
  isActive: boolean;
  attackerInitialTroops: number;
  defenderInitialTroops: number;
}

// ---- Union (political union like USSR) ----

export interface Union {
  id: string;
  gameId: string;
  name: string;
  abbreviation: string;
  foundedOnTurn: number;
  isActive: boolean;
  createdAt: string;
}

export interface UnionMember {
  id: string;
  unionId: string;
  countryId: string;
  isLeader: boolean;
  joinedOnTurn: number;
  leftOnTurn: number | null;
  isActive: boolean;
}

// ---- Turn Submission ----

export interface TurnSubmission {
  id: string;
  gameId: string;
  playerId: string;
  turn: number;
  phase: TurnPhase;
  actions: SubmittedAction[];
  messages: NegotiationMessage[];
  ultimatumResponses: UltimatumResponseEntry[];
  reasoning: string | null;
  publicStatement: string | null;
  createdAt: string;
}

export interface SubmittedAction {
  action: ActionType;
  target?: string;                // country_id
  targetProvinces?: string[];     // nuts2_ids for attacks
  troopAllocation?: number;       // troops to commit
  amount?: number;                // money amount for trades
  pactName?: string;
  pactAbbreviation?: string;
  pactColor?: string;
  flagData?: FlagData;
  newName?: string;
  demands?: UltimatumDemand;
}

export interface NegotiationMessage {
  to: string;        // country ID or "broadcast"
  content: string;
  private: boolean;
}

export interface UltimatumResponseEntry {
  ultimatumId: string;
  response: "accept" | "reject";
}

// ---- Diplomatic Message ----

export interface DiplomaticMessage {
  id: string;
  gameId: string;
  fromPlayerId: string;
  fromCountryId: string;
  toPlayerId: string | null;
  toCountryId: string;
  content: string;
  isPrivate: boolean;
  turn: number;
  phase: TurnPhase;
  createdAt: string;
}

// ---- Trade ----

export interface Trade {
  id: string;
  gameId: string;
  turn: number;
  fromCountryId: string;
  toCountryId: string;
  fromAmount: number;
  toAmount: number;
  createdAt: string;
}

// ---- Game Event ----

export type GameEventType =
  | "game_start"
  | "game_end"
  | "turn_start"
  | "phase_change"
  | "negotiation_message"
  | "declarations_revealed"
  | "resolution"
  | "state_update"
  | "world_event"
  | "combat"
  | "annexation"
  | "ultimatum_sent"
  | "ultimatum_response"
  | "war_declared"
  | "ceasefire"
  | "peace"
  | "pact_formed"
  | "pact_dissolved"
  | "union_formed"
  | "union_dissolved"
  | "player_joined"
  | "player_kicked"
  | "coalition_warning"
  | "province_captured";

export interface GameEvent {
  id?: string;
  gameId: string;
  type: GameEventType;
  turn: number;
  phase: TurnPhase | string;
  data: unknown;
  createdAt?: string;
}

// ---- Game Result ----

export interface GameResult {
  id: string;
  gameId: string;
  playerId: string;
  countryId: string;
  placement: number;
  eloChange: number;
  finalProvinces: number;
  finalTroops: number;
  finalMoney: number;
  finalGdp: number;
  createdAt: string;
}

// ---- Resolution (internal engine type) ----

export type ResolutionType =
  | "combat"
  | "province_captured"
  | "annexation"
  | "world_event"
  | "ultimatum_accepted"
  | "ultimatum_rejected"
  | "war_declared"
  | "ceasefire"
  | "peace"
  | "pact_formed"
  | "pact_invite"
  | "pact_kick"
  | "pact_leave"
  | "betrayal"
  | "union_proposed"
  | "union_formed"
  | "union_dissolved"
  | "trade_success"
  | "trade_failed"
  | "sanction_applied"
  | "embargo_applied"
  | "invest_military"
  | "invest_tech"
  | "invest_stability"
  | "claim_income"
  | "spy_intel"
  | "spy_sabotage"
  | "spy_propaganda"
  | "coup_attempt"
  | "coup_failed"
  | "arms_deal"
  | "foreign_aid"
  | "mobilize"
  | "propaganda"
  | "change_name"
  | "change_flag"
  | "neutral"
  | "revolt"
  | "troop_desertion"
  | "win_condition";

export interface Resolution {
  type: ResolutionType;
  countries: string[];
  provinces?: string[];
  description: string;
  stateChanges: StateChange[];
}

export interface StateChange {
  country?: string;
  province?: string;
  field: string;
  delta: number;
}

// ---- Agent Turn Input (what agents GET) ----

export interface ProvinceView {
  nuts2Id: string;
  name: string;
  ownerId: string;
  gdpValue: number;
  terrain: TerrainType;
  troopsStationed: number;
}

export interface CountryView {
  countryId: string;
  displayName: string;
  flagData: FlagData | null;
  money: number;
  totalTroops: number;
  tech: number;
  stability: number;
  provinceCount: number;
  totalGdp: number;
  isEliminated: boolean;
  unionId: string | null;
}

export interface AgentTurnInput {
  gameId: string;
  turn: number;
  totalTurns: number;
  phase: TurnPhase;
  deadline: string;
  worldTension: number;
  countries: CountryView[];
  provinces: ProvinceView[];
  pacts: { id: string; name: string; abbreviation: string; members: string[] }[];
  wars: { attacker: string; defender: string; startedOnTurn: number }[];
  unions: { id: string; name: string; members: string[]; leader: string }[];
  pendingUltimatums?: Ultimatum[];  // only during ultimatum_response phase
  myState: {
    countryId: string;
    displayName: string;
    money: number;
    totalTroops: number;
    tech: number;
    stability: number;
    spyTokens: number;
    provinces: ProvinceView[];
    pactIds: string[];
    warIds: string[];
    unionId: string | null;
  };
  inboundMessages: {
    from: string;
    fromCountry: string;
    content: string;
    private: boolean;
  }[];
  recentEvents: string[];
}

// ---- Agent Response (what agents POST) ----

export interface NegotiationResponse {
  messages: NegotiationMessage[];
}

export interface DeclarationResponse {
  actions: SubmittedAction[];  // up to 5 per turn
  reasoning: string;
  publicStatement: string;
}

export interface UltimatumResponse {
  responses: UltimatumResponseEntry[];
}

// ---- Action Types ----

import type { ActionType } from "./actions.js";
export type { ActionType };
