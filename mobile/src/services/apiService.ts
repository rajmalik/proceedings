// API Service for Meridian Mobile
// Connects to the same backend API as the website

import AsyncStorage from '@react-native-async-storage/async-storage';
import { assertAIConsent } from './aiConsent';

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'https://immiguide-api-971592620882.us-central1.run.app';

// Active user management (stored in AsyncStorage)
let activeUserId: string | null = null;

// Firebase ID token for Authorization header (kept fresh by AuthContext via onIdTokenChanged)
let idToken: string | null = null;

/**
 * Set the Firebase ID token for API calls. Called by AuthContext's onIdTokenChanged.
 * This token is sent as `Authorization: Bearer` on every authed request.
 */
export function setIdToken(token: string | null): void {
  idToken = token;
}

export function getActiveUserId(): string | null {
  return activeUserId;
}

export async function loadActiveUser(): Promise<string | null> {
  try {
    activeUserId = await AsyncStorage.getItem('activeUserId');
    return activeUserId;
  } catch {
    return null;
  }
}

export async function setActiveUserId(id: string | null): Promise<void> {
  activeUserId = id;
  try {
    if (id) {
      await AsyncStorage.setItem('activeUserId', id);
    } else {
      await AsyncStorage.removeItem('activeUserId');
    }
  } catch {
    // Ignore storage errors
  }
}

function userHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  // Attach the Firebase ID token as Bearer auth (prod requires this; backend verifies)
  if (idToken) {
    headers['Authorization'] = `Bearer ${idToken}`;
  }
  // Keep X-User-Id for backward compat (backend uses it as fallback when ALLOW_USER_IMPERSONATION=1)
  if (activeUserId) {
    headers['X-User-Id'] = activeUserId;
  }
  return headers;
}

/** Error carrying the HTTP status (0 = network/timeout) so callers can branch on it. */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

// 30s: long enough for a slow RAG+Gemini answer, short enough that a truly hung
// socket surfaces an error instead of spinning at the OS default (~60s+).
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Drop-in replacement for `fetch` that aborts after `timeoutMs` so a stalled
 * (not failed) connection can't hang the UI forever. On timeout/network error it
 * rejects with an `ApiError` carrying a user-readable message (status 0).
 * (Audit P0: no request had a timeout — a captive-portal/hung socket froze screens.)
 */
async function apiFetch(
  input: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new ApiError('Request timed out. Check your connection and try again.', 0);
    }
    throw new ApiError(
      e instanceof Error ? e.message : 'Network error. Check your connection and try again.',
      0,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Parse a JSON body but never throw on a non-JSON (e.g. HTML 5xx) body. */
async function safeJson<T = any>(response: Response): Promise<T> {
  return (await response.json().catch(() => ({}))) as T;
}

/**
 * Register a Firebase uid with the backend (idempotent POST /api/users) so the
 * X-User-Id gate accepts it, then make it the active user for all API calls.
 *
 * No username is sent: the backend assigns a random anonymous handle
 * (adj-noun-NNNN) so a user's real name never becomes their username. Users can
 * rename themselves later from the profile screen.
 */
export async function registerBackendUser(uid: string): Promise<void> {
  try {
    await apiFetch(`${API_URL}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid }),
    });
  } catch {
    // Best-effort - re-run on the next auth-state change; calls 404 until then.
  }
  await setActiveUserId(uid);
}

export interface Source {
  chunk_id: string;
  text: string;
  source: string;
  labels: string[];
  score: number;
}

export interface AskResponse {
  answer: string;
  sources: Source[];
  is_fallback: boolean;
  id: string;
}

export interface QAItem {
  id: string;
  question: string;
  answer: string;
  sources: string[];
  labels: string[];
  created_at: string | null;
  is_fallback: boolean;
  helpful: boolean | null;
}

/**
 * Submit an immigration question to the AI
 */
export async function askQuestion(question: string): Promise<AskResponse> {
  // Do not transmit the user's question to the AI backend without consent
  // (App Store 5.1.1(i)/5.1.2(i)).
  assertAIConsent();
  const response = await apiFetch(`${API_URL}/api/ask`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ question }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail || `Request failed: ${response.status}`);
  }

  return response.json();
}

// ============= AI Assist (POST /api/assist — the conversational assistant) ====
// Same contract as the website's /api/assist. A single call returns an
// AssistResponse whose `source_tier` + `can_*` flags drive the whole UI.

export interface AssistCitation {
  source: string;
  title: string;
  as_of: string;
}
export interface AssistCommunityCard {
  case_id: string;
  title: string;
  snippet: string;
  url: string;
  channel: string;
}
export interface AssistPostDraft {
  title: string;
  description: string;
  groups: PostingGroups;
  key_stages_or_info: Record<string, string>;
  key_dates: Record<string, string>;
}
export interface AssistTimeline {
  status: string; // "found" | "not_found" | "unresolved"
  group_id: string;
  group_name: string;
  criteria: unknown;
  find_url: string; // /find?type=timeline&… deep-link, prefilled from criteria
}
export interface AssistResponse {
  intent: string;
  confidence: number;
  answer: string;
  source_tier: string; // "gov" | "community" | "web" | "ungrounded" | ""
  citations: AssistCitation[];
  community_cards: AssistCommunityCard[];
  clarify_questions: string[];
  post_draft: AssistPostDraft | null;
  timeline: AssistTimeline | null;
  find_url: string; // find-similar (/find?type=regular&…) deep-link
  search_suggestions_html: string; // web tier: Google search-suggestion chips (HTML)
  disclaimer: string;
  can_post: boolean;
  can_find_timeline: boolean;
  can_find_similar: boolean;
  rationale: string;
  id: string;
  turns_used: number;
}
export interface AssistHistoryTurn {
  role: string;
  content: string;
  intent: string;
}

// A stable per-install session id — the anon rate-limit key the backend uses
// (website parity: assistSession.ts). Cached after first read.
let assistSessionId: string | null = null;
export async function getAssistSessionId(): Promise<string> {
  if (assistSessionId) return assistSessionId;
  const fresh = () => `sess-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    let id = await AsyncStorage.getItem('assistSessionId');
    if (!id) {
      id = fresh();
      await AsyncStorage.setItem('assistSessionId', id);
    }
    assistSessionId = id;
  } catch {
    assistSessionId = fresh();
  }
  return assistSessionId;
}

/** One conversational turn. `forceIntent` re-runs the router for an affordance
 *  (e.g. 'post', 'timeline-find'). Throws an Error carrying `.status` (429 on
 *  the guest cap) so the UI can branch. */
export async function assistTurn(
  message: string,
  history: AssistHistoryTurn[],
  sessionId: string,
  forceIntent = ''
): Promise<AssistResponse> {
  // Don't transmit the user's message to the AI backend without consent
  // (App Store 5.1.1(i)/5.1.2(i)) — same gate as askQuestion/onboard.
  assertAIConsent();
  const response = await apiFetch(`${API_URL}/api/assist`, {
    method: 'POST',
    headers: userHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ message, history, session_id: sessionId, force_intent: forceIntent }),
  });
  const data = await safeJson(response);
  if (!response.ok) {
    const err = new Error(data.detail || 'Assist request failed') as Error & { status?: number };
    err.status = response.status;
    throw err;
  }
  return data as AssistResponse;
}

/**
 * Get recent Q&A history
 */
export async function getQAHistory(limit = 20, offset = 0): Promise<{ items: QAItem[] }> {
  const response = await apiFetch(
    `${API_URL}/api/qa?limit=${limit}&offset=${offset}`
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch Q&A history: ${response.status}`);
  }

  return response.json();
}

/**
 * Submit feedback on an answer
 */
export async function submitFeedback(qaId: string, helpful: boolean): Promise<{ ok: boolean }> {
  const response = await apiFetch(`${API_URL}/api/qa/${qaId}/feedback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ helpful }),
  });

  if (!response.ok) {
    throw new Error(`Failed to submit feedback: ${response.status}`);
  }

  return response.json();
}

/**
 * Check if the API is healthy
 */
export async function checkHealth(): Promise<{ status: string; chunks_loaded: number }> {
  const response = await apiFetch(`${API_URL}/api/health`);
  return response.json();
}

// ============= Users =============

export interface SeedUser {
  id: string;
  username: string;
  label?: string;
}

export async function getUsers(): Promise<SeedUser[]> {
  const response = await apiFetch(`${API_URL}/api/users`);
  if (!response.ok) {
    throw new Error(`Failed to fetch users: ${response.status}`);
  }
  const data = await safeJson(response);
  return Array.isArray(data) ? data : [];
}

// ============= Voting =============

export interface VoteResult {
  score: number;
  your_vote: number;
}

export async function castVote(contentId: string, dir: -1 | 0 | 1): Promise<VoteResult> {
  const response = await apiFetch(`${API_URL}/api/votes`, {
    method: 'POST',
    headers: userHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ content_id: contentId, dir }),
  });
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Vote failed');
  }
  return data;
}

// ============= UGC safety: report + block (App Store Guideline 1.2) =============

export type ContentType = 'posting' | 'reply' | 'message';
export type ReportReason =
  | 'harassment' | 'hate' | 'violence' | 'sexual' | 'spam'
  | 'self_harm' | 'illegal' | 'other';

export interface ReportResult {
  ok: boolean;
  report_count: number;
  hidden: boolean;
}

/** Flag a posting/reply/message as objectionable. `containerId` is the group id
 *  when reporting a group message. */
export async function reportContent(
  contentId: string,
  contentType: ContentType,
  reason: ReportReason = 'other',
  containerId = ''
): Promise<ReportResult> {
  const response = await apiFetch(`${API_URL}/api/reports`, {
    method: 'POST',
    headers: userHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      content_id: contentId,
      content_type: contentType,
      container_id: containerId,
      reason,
    }),
  });
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Could not submit report');
  }
  return data;
}

/** Block an abusive user. Returns the caller's updated block list (uids). */
export async function blockUser(blockedUid: string): Promise<string[]> {
  const response = await apiFetch(`${API_URL}/api/blocks`, {
    method: 'POST',
    headers: userHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ blocked_uid: blockedUid }),
  });
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Could not block user');
  }
  return data.blocked_uids || [];
}

export async function unblockUser(blockedUid: string): Promise<string[]> {
  const response = await apiFetch(`${API_URL}/api/blocks/${encodeURIComponent(blockedUid)}`, {
    method: 'DELETE',
    headers: userHeaders(),
  });
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Could not unblock user');
  }
  return data.blocked_uids || [];
}

/** The caller's current block list (uids). Best-effort — returns [] on error. */
export async function getBlockedUsers(): Promise<string[]> {
  try {
    const response = await apiFetch(`${API_URL}/api/blocks`, { headers: userHeaders() });
    const data = await safeJson(response);
    if (!response.ok) return [];
    return data.blocked_uids || [];
  } catch {
    return [];
  }
}

// ============= Replies =============

export interface ReplyCardData {
  id: string;
  parent_case_id: string;
  parent_reply_id?: string; // empty/absent = top-level; else the reply this answers (threading)
  body: string;
  author_handle: string;
  author_id?: string; // author uid (blank on your own) — enables block-user
  created_at: string;
  deleted: boolean;
  up: number;
  down: number;
  score: number;
  your_vote: number;
  is_author: boolean;
}

export interface RepliesResponse {
  replies: ReplyCardData[];
  posting?: { up: number; down: number; score: number; your_vote: number };
}

export async function getReplies(postingId: string, sort: 'top' | 'new' = 'new'): Promise<RepliesResponse> {
  const response = await apiFetch(
    `${API_URL}/api/postings/${encodeURIComponent(postingId)}/replies?sort=${sort}`,
    { headers: userHeaders() }
  );
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Could not load replies');
  }
  return data;
}

export async function postReply(
  postingId: string,
  body: string,
  parentReplyId = '',
): Promise<ReplyCardData> {
  const response = await apiFetch(`${API_URL}/api/postings/${encodeURIComponent(postingId)}/replies`, {
    method: 'POST',
    headers: userHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ body, parent_reply_id: parentReplyId }),
  });
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Could not post reply');
  }
  return data;
}

export async function deleteReply(postingId: string, replyId: string): Promise<void> {
  const response = await apiFetch(
    `${API_URL}/api/postings/${encodeURIComponent(postingId)}/replies/${encodeURIComponent(replyId)}`,
    { method: 'DELETE', headers: userHeaders() }
  );
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.detail || 'Delete failed');
  }
}

// ============= Postings =============

// One labeled tag category on the detail view (mirrors the website right panel).
export interface TagSection {
  label: string;
  tags: string[];
}

export interface PostingData {
  case_id: string;
  title: string;
  description: string;
  visa: string[];
  consulates: string[];
  outcome: string;
  subreddit: string;
  channel: string;
  tags: string[];
  url: string;
  date: string;
  body: string; // full posting text (markdown on the website; rendered plain here)
  author_id: string; // authoring app user (empty for reddit/unknown)
  author_handle?: string; // first-party author handle (empty for external ingests)
  tag_sections?: TagSection[]; // every tag category kept separate (detail view)
}

// A posting author's structured profile (the PII-free profile shown in setup).
export interface PublicProfile {
  username: string;
  current_visa_or_greencard_category: string[];
  visa_applying_for: string[];
  primary_consulate: string;
  consulates: string[];
  tags: string[];
  key_stages_or_info: Record<string, string>;
  key_dates: Record<string, string>;
  background_text: string;
  journey: { milestone: string; date: string; experience: string; shared?: boolean }[];
}

export interface AuthorPostingCard {
  case_id: string;
  title: string;
  visa: string[];
  consulates: string[];
  outcome: string;
  date: string;
}

export async function getPublicProfile(uid: string): Promise<PublicProfile | null> {
  try {
    const r = await apiFetch(`${API_URL}/api/users/${encodeURIComponent(uid)}/public-profile`);
    if (!r.ok) return null;
    return (await r.json()) as PublicProfile;
  } catch {
    return null;
  }
}

export async function getUserPostings(uid: string): Promise<AuthorPostingCard[]> {
  try {
    const r = await apiFetch(`${API_URL}/api/users/${encodeURIComponent(uid)}/postings`);
    if (!r.ok) return [];
    const d = await r.json();
    return (d.postings || []) as AuthorPostingCard[];
  } catch {
    return [];
  }
}

// All first-party postings authored under a given handle (newest first). Powers
// the author-by-handle screen (mirrors the website /author-by-handle/[handle]).
export async function getPostingsByHandle(handle: string): Promise<AuthorPostingCard[]> {
  try {
    const r = await apiFetch(`${API_URL}/api/authors/by-handle/${encodeURIComponent(handle)}/postings`);
    if (!r.ok) return [];
    const d = await r.json();
    return (d.postings || []) as AuthorPostingCard[];
  } catch {
    return [];
  }
}

export interface UserReplyCard {
  id: string;
  parent_case_id: string;
  body: string;
  created_at: string;
}

// All replies a user has authored (their 'activity'), newest first.
export async function getUserReplies(uid: string): Promise<UserReplyCard[]> {
  try {
    const r = await apiFetch(`${API_URL}/api/users/${encodeURIComponent(uid)}/replies`);
    if (!r.ok) return [];
    const d = await r.json();
    return (d.replies || []) as UserReplyCard[];
  } catch {
    return [];
  }
}

export interface PostingGroups {
  visa_applying_for: string[];
  current_visa_or_greencard_category: string[];
  primary_consulate: string;
  consulates: string[];
  tags: string[];
  concerns_or_questions_tags: string[];
}

export async function getPosting(caseId: string): Promise<PostingData> {
  const response = await apiFetch(`${API_URL}/api/postings/${encodeURIComponent(caseId)}`, {
    headers: userHeaders(),
  });
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Could not load posting');
  }
  return data;
}

export async function createPosting(
  title: string,
  description: string,
  tags: PostingGroups,
  key_stages_or_info: Record<string, string>,
  key_dates: Record<string, string>,
  client_platform: string = ''
): Promise<{ case_id: string; author_handle: string }> {
  const response = await apiFetch(`${API_URL}/api/postings`, {
    method: 'POST',
    // The backend requires a signed-in author (Bearer/X-User-Id); a personal-case
    // post also needs a set-up profile, while a discussion/blog is exempt.
    headers: userHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ title, description, tags, key_stages_or_info, key_dates, client_platform }),
  });
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Could not publish posting');
  }
  return data;
}

export async function suggestTags(
  title: string,
  description: string
): Promise<{
  groups: PostingGroups;
  key_stages_or_info: Record<string, string>;
  key_dates: Record<string, string>;
  relevant_sections: string[];
  posting_type: string;
}> {
  const response = await apiFetch(`${API_URL}/api/tag-suggest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, description }),
  });
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Could not analyze posting');
  }
  return data;
}

// ============= Tag Vocabulary =============

// ============= AI Onboarding (same contract as the website's /api/onboard) ====

export interface OnboardJourneyEntry {
  milestone: string;
  date: string;
  experience: string;
  shared?: boolean;
  experience_case_id?: string;
}

// The backend ProfilePayload shape used as the onboarding draft.
export interface OnboardProfile {
  username?: string;
  current_visa_or_greencard_category: string[];
  visa_applying_for: string[];
  primary_consulate: string;
  consulates: string[];
  tags: string[];
  key_stages_or_info: Record<string, string>;
  key_dates: Record<string, string>;
  background_text: string;
  journey?: OnboardJourneyEntry[];
}

export interface OnboardResponse {
  reply: string;
  profile: OnboardProfile;
  done: boolean;
}

/** One conversational AI-onboarding turn (stage 1 'basics' | stage 2 'experiences'). */
export async function onboardTurn(
  stage: 'basics' | 'experiences',
  messages: { role: string; content: string }[],
  draft: OnboardProfile
): Promise<OnboardResponse> {
  // Onboarding sends profile/background details to the AI backend — gated on consent.
  assertAIConsent();
  const response = await apiFetch(`${API_URL}/api/onboard`, {
    method: 'POST',
    headers: userHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ stage, messages, draft }),
  });
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Onboarding assistant error');
  }
  return data;
}

// ============= Search (same contract as the website's /api/search) =============

export type Strictness = 'broad' | 'balanced' | 'strict';

export interface SearchResultItem {
  case_id: string;
  title: string;
  description: string;
  visa: string[];
  consulates: string[];
  outcome: string;
  subreddit: string;
  channel: string;
  tags: string[];
  url: string;
  date: string;
  timestamp?: string; // full ingestion timestamp (for relative "X ago")
  author_id?: string; // authoring app user (first-party only) — enables block-user
}

export interface SearchFacetValue {
  code: string;
  label: string;
  count: number;
}

export interface SuggestedFilterGroup {
  key: string;
  label: string;
  field: string;
  values: SearchFacetValue[];
}

export interface SearchResponse {
  results: SearchResultItem[];
  next_page_token: string;
  suggested_filters: SuggestedFilterGroup[];
}

// Selection id used for the backend `facet` param - mirrors the website's facetId().
export const facetId = (field: string, code: string) => `${field}:${code}`;

export async function searchPostings(
  q: string,
  opts: {
    strictness?: Strictness;
    facets?: string[];
    pageToken?: string;
    pageSize?: number;
    // Advanced Search's explicit News/Cutoff controls — omitted by every
    // other caller, which keeps the backend's own legacy default behavior
    // unchanged (see backend/api.py's _recency_news_clause).
    includeNews?: boolean;
    maxAgeDays?: number;
  } = {}
): Promise<SearchResponse> {
  const p = new URLSearchParams();
  // No filler text when q is empty (a facet-only refine): Discovery Engine
  // relevance-ranks against `q` IN ADDITION TO applying the facet filter,
  // so a non-empty filler string here silently drops facet-matching
  // documents that don't also relevance-match the filler text — confirmed
  // live: `tags:asylum` alone returns the correct 24 postings; with a
  // filler `q` it drops to 3.
  if (q) p.set('q', q);
  (opts.facets || []).forEach((f) => p.append('facet', f));
  p.set('strictness', opts.strictness || 'balanced');
  p.set('page_size', String(opts.pageSize ?? 15));
  if (opts.pageToken) p.set('page_token', opts.pageToken);
  if (opts.includeNews !== undefined) p.set('include_news', String(opts.includeNews));
  if (opts.maxAgeDays) p.set('max_age_days', String(opts.maxAgeDays));
  const response = await apiFetch(`${API_URL}/api/search?${p.toString()}`);
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Search failed');
  }
  return {
    results: data.results || [],
    next_page_token: data.next_page_token || '',
    suggested_filters: data.suggested_filters || [],
  };
}

/**
 * Browse the postings feed most-recent-first. Unlike searchPostings, it sends an
 * EMPTY query (no 'immigration visa experience' relevance fallback) + sort, so
 * the backend returns the recent user-content feed ordered by recency instead of
 * ranking by relevance. Used for the default (un-searched) feed / experiences /
 * home views.
 */
export async function browsePostings(
  opts: { sort?: 'recent' | 'event'; pageToken?: string; pageSize?: number } = {}
): Promise<SearchResponse> {
  const p = new URLSearchParams();
  p.set('q', ''); // empty => backend browse path (recency), not relevance
  p.set('sort', opts.sort || 'recent');
  p.set('page_size', String(opts.pageSize ?? 15));
  if (opts.pageToken) p.set('page_token', opts.pageToken);
  const response = await apiFetch(`${API_URL}/api/search?${p.toString()}`);
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Could not load feed');
  }
  return {
    results: data.results || [],
    next_page_token: data.next_page_token || '',
    suggested_filters: data.suggested_filters || [],
  };
}

export interface QueryTag {
  field: string;
  code: string;
  label: string;
}

/**
 * Tags derived from the search query text itself (same Gemini-based tagging
 * principles as posting composition), in the same {field, code, label} shape
 * suggested_filters() uses — so a toggled query-tag chip's facetId(field,
 * code) plugs directly into the existing selectedFacets mechanism. Meant to
 * be called once per search submit (not per keystroke) and in parallel with
 * searchPostings — a slow/failed call here must never block results.
 * features/ui-changes-1/changes-2-.md item 4.
 */
export async function fetchQueryTags(q: string): Promise<QueryTag[]> {
  const response = await apiFetch(`${API_URL}/api/search/query-tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q }),
  });
  const data = await safeJson(response);
  if (!response.ok) return [];
  return data.tags || [];
}

export interface ConsulateCountry {
  country: string;
  country_code: string;
  cities: { code: string; city: string }[];
}

/**
 * One group-SCOPE row: what a Timeline group is scoped by, entered on the
 * find/create panel and stored in the group's criteria. `field` decides which
 * criteria map it lands in — a date row (I-485's priority date) goes to
 * key_dates, the period rows to key_stages_or_info. `name_prefix`, when set,
 * labels this value's segment in the generated group name.
 */
export type AttributeField = 'key_dates' | 'key_stages_or_info';
export type TagAttributeRow =
  | { kind: 'date'; label: string; field: AttributeField; key: string; name_prefix?: string }
  | { kind: 'select'; label: string; field: AttributeField; key: string; options: string[]; name_prefix?: string }
  | { kind: 'year'; label: string; field: AttributeField; key: string; name_prefix?: string };

/**
 * One row of backend/posting.py's POST_JOIN_ATTRIBUTE_TEMPLATES.
 *
 * `kind` drives BOTH the control and the server-side validation (a 'select'
 * value outside `options` is rejected with a 422), and `field` decides which
 * profile map the value merges into. Older rows carry no `kind` — treat a
 * missing one as 'date'.
 */
export type PostJoinAttributeRow = {
  label: string;
  field: 'key_dates' | 'key_stages_or_info';
  key: string;
  kind?: 'date' | 'select' | 'checkbox';
  options?: string[];
  /** Must be supplied to join. Configured per template server-side. */
  required?: boolean;
};

/**
 * Which rows a member must fill in to join. Mirrors posting.required_keys():
 * if ANY row declares `required` the declarations are taken literally — the
 * only way to say "nothing here is mandatory" — and a template that declares
 * nothing falls back to row 0, the convention every template predating the
 * flag was written to.
 */
export function requiredAttributeKeys(rows: PostJoinAttributeRow[]): string[] {
  if (rows.some((r) => r.required !== undefined)) {
    return rows.filter((r) => r.required).map((r) => r.key);
  }
  return rows.length ? [rows[0].key] : [];
}

/**
 * A ticked checkbox stores this exact string; an unticked one stores nothing
 * at all — never "no" — so unticked and never-answered are the same absent
 * key (mirrors posting.CHECKBOX_ON).
 */
export const CHECKBOX_ON = 'yes';

/**
 * backend/posting.py's EAD_ELIGIBILITY_CATEGORIES / PROCESSING_TYPES.
 *
 * Both a type and a category carry the `scope_rows` their selection implies,
 * already resolved server-side (the base period rows plus whatever that
 * type/category configures on top), so a screen renders whichever rows it is
 * handed rather than knowing any of them.
 */
export type EligibilityCategory = {
  code: string; label: string; tag: string;
  scope_rows?: TagAttributeRow[]; post_join_rows?: PostJoinAttributeRow[];
};
export type ProcessingTypeOption = {
  value: string; label: string;
  // What the second picker is called for THIS type — EAD's list is 8 CFR
  // eligibility categories, H-1B's is application types. Optional; omitted
  // falls back to the EAD wording.
  category_label?: string;
  eligibility_categories: EligibilityCategory[];
  scope_rows?: TagAttributeRow[]; post_join_rows?: PostJoinAttributeRow[];
};

export interface TagVocab {
  visa: string[];
  consulate: string[];
  consulate_options: { code: string; label: string }[];
  consulate_tree: ConsulateCountry[];
  tag: string[];
  misc: string[];
  misc_options: { code: string; label: string }[];
  stage_key: string[];
  date_key: string[];
  profile_stage_key: string[];
  stage_value_domains: Record<string, string>;
  country: string[];
  outcome: string[];
  tag_attribute_templates: Record<string, TagAttributeRow[]>;
  post_join_attribute_templates: Record<string, PostJoinAttributeRow[]>;
  processing_types: ProcessingTypeOption[];
}

// Cached per app session; returns null offline so callers can fall back to the
// curated constants in constants/onboardingData.
let vocabCache: TagVocab | null = null;

export async function getTagVocab(): Promise<TagVocab | null> {
  if (vocabCache) return vocabCache;
  try {
    const response = await apiFetch(`${API_URL}/api/tag-vocab`);
    if (!response.ok) return null;
    const data = await safeJson(response);
    vocabCache = {
      visa: data.visa || [],
      consulate: data.consulate || [],
      consulate_options: data.consulate_options || [],
      consulate_tree: data.consulate_tree || [],
      tag: data.tag || [],
      misc: data.misc || [],
      misc_options: data.misc_options || [],
      stage_key: data.stage_key || [],
      date_key: data.date_key || [],
      profile_stage_key: data.profile_stage_key || [],
      stage_value_domains: data.stage_value_domains || {},
      country: data.country || [],
      outcome: data.outcome || [],
      tag_attribute_templates: data.tag_attribute_templates || {},
      post_join_attribute_templates: data.post_join_attribute_templates || {},
      processing_types: data.processing_types || [],
    };
    return vocabCache;
  } catch {
    return null;
  }
}

// ============= Matching / Find =============

export interface MatchData {
  user_id: string;
  username: string;
  score: number;
  shared: string[];
  summary: string;
  background?: string;
}

export interface Criteria {
  current_visa_or_greencard_category: string[];
  visa_applying_for: string[];
  primary_consulate: string;
  consulates: string[];
  tags: string[];
  key_stages_or_info: Record<string, string>;
  key_dates: Record<string, string>;
  background_text: string;
}

export async function findChat(
  messages: { role: string; content: string }[],
  draft: Criteria
): Promise<{ reply: string; criteria: Criteria }> {
  const response = await apiFetch(`${API_URL}/api/find/chat`, {
    method: 'POST',
    headers: userHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ messages, draft }),
  });
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Find chat error');
  }
  return data;
}

export async function findMatches(criteria: Criteria): Promise<{ matches: MatchData[] }> {
  const response = await apiFetch(`${API_URL}/api/find/matches`, {
    method: 'POST',
    headers: userHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ criteria }),
  });
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Could not find matches');
  }
  return data;
}

// ============= Groups =============

export interface GroupMember {
  user_id: string;
  username: string;
}

export interface GroupInfo {
  group_id: string;
  name: string;
  description: string;
  group_type: string;
  criteria_text: string;
  criteria_tags?: Partial<Criteria>;
  members: GroupMember[];
  created_by: string;
  created_by_username?: string;
  is_admin: boolean;
  status?: string;
  expiration_date?: string;
  is_member: boolean;
  created_at: string;
  last_activity_at: string;
  score: number;
  shared: string[];
  needs_attributes?: boolean;
  // You have a pending invitation to this group (browse cards only).
  is_invited?: boolean;
  invited?: Invitation[];
}

// A pending ask to join a group. Nobody is added to `GroupInfo.members` until
// they accept, so an invitee is invisible to every membership check until then.
export interface Invitation {
  invitation_id: string;
  group_id: string;
  group_name: string;
  user_id: string;
  username: string;
  invited_by: string;
  invited_by_username: string;
  status: string;
  // Accepting will demand the group's attribute form — the caller has to
  // collect those values rather than accepting blind.
  requires_attributes: boolean;
  created_at: string;
  responded_at: string;
}

export interface MemberAttributes {
  user_id: string;
  username: string;
  processing_type: string;
  values: Record<string, string>;
  notes: string;
  submitted_at: string;
  updated_at: string;
}

export interface GroupResult {
  group_id: string;
  name: string;
  group_type: string;
  joined: boolean;
  members: GroupMember[];
}

export async function getGroup(groupId: string): Promise<GroupInfo> {
  const response = await apiFetch(`${API_URL}/api/groups/${encodeURIComponent(groupId)}`, {
    headers: userHeaders(),
  });
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Could not load group');
  }
  return data;
}

export async function getAllGroups(): Promise<{ groups: GroupInfo[] }> {
  const response = await apiFetch(`${API_URL}/api/groups/all`, {
    headers: userHeaders(),
  });
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Could not load groups');
  }
  return data;
}

export async function createGroup(
  criteriaText: string,
  criteria: Criteria,
  members: GroupMember[],
  groupType: string = '',
  description: string = '',
  validity: string = '',
  values: Record<string, string> = {},
  notes: string = ''
): Promise<GroupResult> {
  const response = await apiFetch(`${API_URL}/api/groups`, {
    method: 'POST',
    headers: userHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ criteria_text: criteriaText, criteria, members, group_type: groupType, description, validity, values, notes }),
  });
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Could not create group');
  }
  return data;
}

// Admin-only archive/unarchive toggle.
export async function archiveGroup(groupId: string, archived: boolean): Promise<GroupInfo> {
  const response = await apiFetch(`${API_URL}/api/groups/${encodeURIComponent(groupId)}/archive`, {
    method: 'POST',
    headers: userHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ archived }),
  });
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Could not update group status');
  }
  return data;
}

// Post-join Timeline attribute form's save — merges a partial key_dates
// update into the caller's OWN profile (personal per-member facts, e.g.
// STEM-OPT dates — not the group's shared criteria).
export async function saveKeyDates(keyDates: Record<string, string>): Promise<void> {
  const response = await apiFetch(`${API_URL}/api/profile/key-dates`, {
    method: 'POST',
    headers: userHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ key_dates: keyDates }),
  });
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Could not save your dates');
  }
}

// Search EXISTING groups by criteria — the group-search counterpart to
// findMatches() (candidate-user matching, now scoped to inside a group's own
// page as "Find candidates"). Public, like Advanced Search's own posting
// search — no auth required to search; joining/creating still require it.
export async function searchGroups(
  criteria: Criteria,
  groupType: string,
  precision: Strictness,
  maxAgeDays: number
): Promise<{ groups: GroupInfo[] }> {
  const response = await apiFetch(`${API_URL}/api/groups/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ criteria, group_type: groupType, precision, max_age_days: maxAgeDays }),
  });
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Could not search groups');
  }
  return data;
}

/**
 * The name and description these criteria WOULD produce, without creating
 * anything — so the create screen can show the name before you commit to it.
 *
 * Server-generated on purpose: Timeline dedup is name-based, so a local
 * reimplementation that drifted would promise a new cohort and deliver a join
 * into an existing one. A failure is cosmetic, so this resolves to empty
 * strings rather than throwing — the create screen stays usable.
 */
export async function previewGroup(
  criteria: Criteria,
  groupType: string
): Promise<{ name: string; description: string }> {
  try {
    const response = await apiFetch(`${API_URL}/api/groups/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ criteria, group_type: groupType }),
    });
    const data = await safeJson(response);
    if (!response.ok) return { name: '', description: '' };
    return { name: data.name || '', description: data.description || '' };
  } catch {
    return { name: '', description: '' };
  }
}

// Rank candidate users against a specific group's own stored criteria —
// member-only (enforced backend-side).
export async function findCandidates(groupId: string): Promise<{ matches: MatchData[] }> {
  const response = await apiFetch(`${API_URL}/api/groups/${encodeURIComponent(groupId)}/find-candidates`, {
    method: 'POST',
    headers: userHeaders(),
  });
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Could not find candidates');
  }
  return data;
}

// A current member invites one or more found candidates — the "Find
// candidates" counterpart to inviteToGroup() (which invites by typed handle).
// Nobody joins until they accept, so `group` comes back unchanged; a bad
// candidate lands in `skipped` rather than failing the whole batch.
export async function addMembers(
  groupId: string,
  userIds: string[]
): Promise<{ group: GroupInfo; invited: Invitation[]; skipped: { user_id: string; reason: string }[] }> {
  const response = await apiFetch(`${API_URL}/api/groups/${encodeURIComponent(groupId)}/add-members`, {
    method: 'POST',
    headers: userHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ user_ids: userIds }),
  });
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Could not invite candidates');
  }
  return data;
}

export async function joinGroup(
  groupId: string,
  values: Record<string, string> = {},
  notes: string = ''
): Promise<GroupInfo> {
  const response = await apiFetch(`${API_URL}/api/groups/${encodeURIComponent(groupId)}/join`, {
    method: 'POST',
    headers: userHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ values, notes }),
  });
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Could not join group');
  }
  return data;
}

// The mandatory-gate fill-in path for a member already added to the group
// (e.g. via invite, who never went through joinGroup()) — same server-side
// validation as join, but membership-gated instead of join-gated.
export async function saveMemberAttributes(
  groupId: string,
  values: Record<string, string>,
  notes: string = ''
): Promise<GroupInfo> {
  const response = await apiFetch(`${API_URL}/api/groups/${encodeURIComponent(groupId)}/attributes`, {
    method: 'POST',
    headers: userHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ values, notes }),
  });
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Could not save your attributes');
  }
  return data;
}

// Members-only — every member's submitted post-join attributes, shared with
// the whole group (not just the caller's own submission).
export async function getMemberAttributes(groupId: string): Promise<{ attributes: MemberAttributes[] }> {
  const response = await apiFetch(`${API_URL}/api/groups/${encodeURIComponent(groupId)}/attributes`, {
    headers: userHeaders(),
  });
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Could not load attributes');
  }
  return data;
}

export async function leaveGroup(groupId: string): Promise<void> {
  const response = await apiFetch(`${API_URL}/api/groups/${encodeURIComponent(groupId)}/leave`, {
    method: 'POST',
    headers: userHeaders({ 'Content-Type': 'application/json' }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.detail || 'Could not leave group');
  }
}

// Sends an invitation — it does NOT add the person. The group is unchanged
// until they accept, so this returns the invitation, not a group card.
export async function inviteToGroup(groupId: string, handle: string): Promise<Invitation> {
  const response = await apiFetch(`${API_URL}/api/groups/${encodeURIComponent(groupId)}/invite`, {
    method: 'POST',
    headers: userHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ handle }),
  });
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Could not invite that handle');
  }
  return data;
}

// Every invitation waiting on the signed-in user, across all groups — the feed
// behind the Find tab's "Pending invitations" section. Each entry carries the
// group so the row can be rendered without a second round-trip per invite.
export async function getMyInvitations(): Promise<{
  invitations: { invitation: Invitation; group: GroupInfo }[];
}> {
  const response = await apiFetch(`${API_URL}/api/groups/invitations`, {
    headers: userHeaders(),
  });
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Could not load invitations');
  }
  return data;
}

// Who this group has invited but who hasn't answered yet. Members only.
export async function getGroupInvitations(groupId: string): Promise<{ invitations: Invitation[] }> {
  const response = await apiFetch(`${API_URL}/api/groups/${encodeURIComponent(groupId)}/invitations`, {
    headers: userHeaders(),
  });
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Could not load invitations');
  }
  return data;
}

// Accepting is what actually joins the group, so it carries the same attribute
// payload as joinGroup() — for a group with a required field, accepting without
// it is rejected and nobody is added.
export async function acceptInvitation(
  groupId: string,
  values: Record<string, string> = {},
  notes: string = ''
): Promise<GroupInfo> {
  const response = await apiFetch(
    `${API_URL}/api/groups/${encodeURIComponent(groupId)}/invitations/accept`,
    {
      method: 'POST',
      headers: userHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ values, notes }),
    }
  );
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Could not accept the invitation');
  }
  return data;
}

export async function declineInvitation(groupId: string): Promise<Invitation> {
  const response = await apiFetch(
    `${API_URL}/api/groups/${encodeURIComponent(groupId)}/invitations/decline`,
    {
      method: 'POST',
      headers: userHeaders({ 'Content-Type': 'application/json' }),
    }
  );
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Could not decline the invitation');
  }
  return data;
}

export async function renameGroup(
  groupId: string,
  updates: { name?: string; description?: string }
): Promise<GroupInfo> {
  const response = await apiFetch(`${API_URL}/api/groups/${encodeURIComponent(groupId)}`, {
    method: 'PUT',
    headers: userHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(updates),
  });
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Could not rename group');
  }
  return data;
}

export async function deleteGroup(groupId: string): Promise<void> {
  const response = await apiFetch(`${API_URL}/api/groups/${encodeURIComponent(groupId)}`, {
    method: 'DELETE',
    headers: userHeaders({ 'Content-Type': 'application/json' }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.detail || 'Could not delete group');
  }
}

// ============= Group Chat =============

export interface ChatMessage {
  id: string;
  author_handle: string;
  author_id?: string; // author uid (blank on your own) — enables block-user
  text: string;
  created_at: string;
  deleted: boolean;
  is_author: boolean;
}

export async function getGroupMessages(
  groupId: string,
  since?: string
): Promise<{ messages: ChatMessage[]; denied?: boolean }> {
  const url = since
    ? `${API_URL}/api/groups/${encodeURIComponent(groupId)}/messages?since=${encodeURIComponent(since)}`
    : `${API_URL}/api/groups/${encodeURIComponent(groupId)}/messages`;
  const response = await apiFetch(url, { headers: userHeaders() });
  if (response.status === 403) {
    return { messages: [], denied: true };
  }
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Could not load messages');
  }
  return { messages: data.messages || [] };
}

export async function sendGroupMessage(groupId: string, text: string): Promise<ChatMessage> {
  const response = await apiFetch(`${API_URL}/api/groups/${encodeURIComponent(groupId)}/messages`, {
    method: 'POST',
    headers: userHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ text }),
  });
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Could not send message');
  }
  return data;
}

export async function deleteGroupMessage(groupId: string, messageId: string): Promise<void> {
  const response = await apiFetch(
    `${API_URL}/api/groups/${encodeURIComponent(groupId)}/messages/${encodeURIComponent(messageId)}`,
    { method: 'DELETE', headers: userHeaders() }
  );
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.detail || 'Delete failed');
  }
}

// ============= Profile / Reconcile =============

export interface ReconcileResult {
  conflicts: { field: string; profile_value: unknown; message_value: unknown }[];
  explainer: string;
  merged: Criteria;
  prefilled: string[];
}

export async function reconcile(message: Partial<Criteria>): Promise<ReconcileResult> {
  // Reconciliation runs the user's message/profile through the AI backend — gated.
  assertAIConsent();
  const response = await apiFetch(`${API_URL}/api/reconcile`, {
    method: 'POST',
    headers: userHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ message }),
  });
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Reconcile failed');
  }
  return data;
}

// Profile cache key
// Profile cache is namespaced per active uid so one account never reads another's
// cached profile on a shared device (audit P1: cross-user profile leak).
const PROFILE_CACHE_PREFIX = 'proceedings_profile_cache';
const profileCacheKey = (uid: string | null = activeUserId): string =>
  `${PROFILE_CACHE_PREFIX}_${uid ?? 'anon'}`;

// Get cached profile for the active user (returns null if not cached)
export async function getCachedProfile(): Promise<Record<string, unknown> | null> {
  try {
    const cached = await AsyncStorage.getItem(profileCacheKey());
    if (cached) {
      return JSON.parse(cached);
    }
  } catch {
    // Ignore cache errors
  }
  return null;
}

// Save the active user's profile to cache
async function cacheProfile(profile: Record<string, unknown>): Promise<void> {
  try {
    await AsyncStorage.setItem(profileCacheKey(), JSON.stringify(profile));
  } catch {
    // Ignore cache errors
  }
}

// Clear the active user's profile cache (call on sign out, before clearing the uid)
export async function clearProfileCache(): Promise<void> {
  try {
    await AsyncStorage.removeItem(profileCacheKey());
  } catch {
    // Ignore cache errors
  }
}

export async function getProfile(): Promise<Record<string, unknown>> {
  const response = await apiFetch(`${API_URL}/api/profile`, {
    headers: userHeaders(),
  });
  const data = await safeJson<Record<string, unknown>>(response);
  // Only cache a real profile — never cache a 4xx/5xx error body (audit P1).
  if (!response.ok) {
    throw new ApiError((data as any)?.detail || `Request failed: ${response.status}`, response.status);
  }
  await cacheProfile(data);
  return data;
}

export async function updateProfile(profile: Record<string, unknown>): Promise<void> {
  const response = await apiFetch(`${API_URL}/api/profile`, {
    method: 'PUT',
    headers: userHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(profile),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.detail || 'Could not update profile');
  }
}

/**
 * Delete the current user's account and all associated data.
 * This is an irreversible operation that removes:
 * - User profile
 * - Posting author links
 * - Replies (soft-deleted)
 * - Group memberships
 * - Group messages (soft-deleted)
 * - Firebase Auth account
 */
export async function deleteAccount(): Promise<{ ok: boolean; deleted_uid: string }> {
  const response = await apiFetch(`${API_URL}/api/users/me`, {
    method: 'DELETE',
    headers: userHeaders(),
  });
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Could not delete account');
  }
  return data;
}

// ============= Email Verification =============

/**
 * Send a 6-digit verification code to the user's email.
 * Rate limited to 3 requests per hour per email.
 */
export async function sendVerificationCode(email: string): Promise<{ ok: boolean; message?: string }> {
  const response = await apiFetch(`${API_URL}/api/auth/send-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Failed to send verification code');
  }
  return data;
}

/**
 * Verify a 6-digit code entered by the user.
 * Returns { verified: true } on success, or { verified: false, error: string } on failure.
 */
export async function verifyCode(email: string, code: string): Promise<{ verified: boolean; error?: string }> {
  const response = await apiFetch(`${API_URL}/api/auth/verify-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code }),
  });
  const data = await safeJson(response);
  if (!response.ok) {
    throw new Error(data.detail || 'Verification failed');
  }
  return data;
}

/**
 * Check if an email address has been verified.
 */
export async function checkEmailVerified(email: string): Promise<boolean> {
  try {
    const response = await apiFetch(`${API_URL}/api/auth/check-verified/${encodeURIComponent(email)}`);
    if (!response.ok) return false;
    const data = await safeJson(response);
    return data.verified === true;
  } catch {
    return false;
  }
}
