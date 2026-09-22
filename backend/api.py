"""
api.py — FastAPI Server for meridianjourney.ai RAG Pipeline
=====================================================
Exposes the RAG query engine as HTTP endpoints for the Next.js frontend.

USAGE:
  uvicorn api:app --reload --port 8000
"""

import os
import random
import string
import time
from collections import defaultdict
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

import resend
import vertexai
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from google.api_core.exceptions import GoogleAPICallError
from google.cloud import firestore
from pydantic import BaseModel, Field

from query import (
    FALLBACK_MESSAGE,
    classify_intent,
    generate_direct_answer,
    get_recent_qa,
    save_qa_pair,
    update_feedback,
)
from search_client import (
    answer_query,
    get_posting,
    postings_by_handle,
    search_postings,
    search_with_strictness,
    suggested_filters,
)

# ---------------------------------------------------------------------------
# Startup / Shutdown
# ---------------------------------------------------------------------------

# Module-level singletons, initialized at startup
_db: firestore.Client = None
_engine_id: str = ""
_public_engine_id: str = ""
_datastore_id: str = "imm-postings-datastore"
_ds_location: str = "global"
_project_id: str = ""
_region: str = ""


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize Vertex AI Search grounding + Firestore on startup.

    Grounding is served by the managed Discovery Engine Search/Answer API over
    `imm-postings-datastore` (D-016/D-034/D-039) — not the retired self-managed
    Vector Search index.
    """
    global _db, _engine_id, _public_engine_id, _datastore_id, _ds_location, _project_id, _region

    load_dotenv()

    # Support both old and new env var names
    _project_id = os.getenv("GCP_PROJECT_ID") or os.getenv("GCP_PROJECT", "")
    _region = os.getenv("GCP_REGION") or os.getenv("GCP_LOCATION", "us-central1")
    _engine_id = os.getenv("GCP_VERTEX_SEARCH_APP_ID", "imm-postings-search-app")
    _datastore_id = os.getenv("GCP_VERTEX_DATASTORE_ID", "imm-postings-datastore")
    # DS-2 public-reference engine (D-039 tier 3). Off until the website data
    # store finishes indexing; set GCP_VERTEX_PUBLIC_ENGINE_ID to enable.
    _public_engine_id = os.getenv("GCP_VERTEX_PUBLIC_ENGINE_ID", "")
    _ds_location = os.getenv("GCP_VERTEX_DATASTORE_LOCATION", "global")

    if not _project_id:
        raise RuntimeError("GCP_PROJECT_ID or GCP_PROJECT must be set in environment")

    if not _engine_id:
        print("Warning: GCP_VERTEX_SEARCH_APP_ID not set. Grounded search disabled; using direct Gemini.")

    # Vertex AI init is still needed for the direct-Gemini fallback path.
    vertexai.init(project=_project_id, location=_region)

    # Initialize Firestore
    try:
        _db = firestore.Client(project=_project_id)
    except Exception as e:
        print(f"Warning: Could not initialize Firestore: {e}")
        _db = None

    print(f"API ready: grounding={'enabled' if _engine_id else 'disabled'} "
          f"(engine={_engine_id}, location={_ds_location}, "
          f"public_tier={'on:' + _public_engine_id if _public_engine_id else 'off'})")
    yield


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(title="meridianjourney.ai API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "https://meridianjourney.ai",
        "https://www.meridianjourney.ai",
    ],
    # Vercel preview deploys (anchored so it can't match e.g. attacker.vercel.app.evil.com).
    allow_origin_regex=r"https://[a-z0-9-]+\.vercel\.app$",
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Simple rate limiter (in-memory, per IP)
# ---------------------------------------------------------------------------

_rate_limit: dict[str, list[float]] = defaultdict(list)
RATE_LIMIT_MAX = 10  # requests
RATE_LIMIT_WINDOW = 60  # seconds


def check_rate_limit(ip: str) -> bool:
    now = time.time()
    timestamps = _rate_limit[ip]
    # Remove old entries
    _rate_limit[ip] = [t for t in timestamps if now - t < RATE_LIMIT_WINDOW]
    if len(_rate_limit[ip]) >= RATE_LIMIT_MAX:
        return False
    _rate_limit[ip].append(now)
    return True


# AI-Assist anonymous cap (Q7/Q18): its own counter, keyed primarily on the
# client session_id (IP is unreliable behind the Next.js BFF), then a sign-in
# nudge. A soft cost/abuse guard, not a security control.
_assist_anon_rate: dict[str, list[float]] = defaultdict(list)
ASSIST_ANON_MAX = int(os.getenv("AI_ASSIST_ANON_LIMIT", "5"))
ASSIST_ANON_WINDOW = int(os.getenv("AI_ASSIST_ANON_WINDOW_SECONDS", "3600"))


def check_assist_anon_limit(key: str) -> bool:
    now = time.time()
    ts = _assist_anon_rate[key]
    _assist_anon_rate[key] = [t for t in ts if now - t < ASSIST_ANON_WINDOW]
    if len(_assist_anon_rate[key]) >= ASSIST_ANON_MAX:
        return False
    _assist_anon_rate[key].append(now)
    return True


# ---------------------------------------------------------------------------
# Request / Response Models
# ---------------------------------------------------------------------------

class AskRequest(BaseModel):
    question: str = Field(..., min_length=5, max_length=500)


class ExpertRequest(BaseModel):
    question: str = Field(..., min_length=3, max_length=500)
    history: list[dict] = []  # prior [{role, content}] turns for follow-ups


class ExpertResponse(BaseModel):
    answer: str


# --- Posting composer (phase-H) ---
class TagSuggestRequest(BaseModel):
    title: str = Field(..., min_length=3, max_length=300)
    description: str = Field(..., min_length=10, max_length=8000)


class TagGroups(BaseModel):
    visa_applying_for: list[str] = []
    current_visa_or_greencard_category: list[str] = []
    primary_consulate: str = ""
    consulates: list[str] = []
    tags: list[str] = []
    concerns_or_questions_tags: list[str] = []


class TagSuggestResponse(BaseModel):
    groups: TagGroups
    relevant_sections: list[str] = []
    posting_type: str = ""
    key_stages_or_info: dict[str, str] = {}
    key_dates: dict[str, str] = {}


# --- Search query tag chips (features/ui-changes-1/changes-2-.md item 4) ---
class QueryTagsRequest(BaseModel):
    q: str = Field(..., min_length=1, max_length=300)


class QueryTag(BaseModel):
    field: str
    code: str
    label: str


class QueryTagsResponse(BaseModel):
    tags: list[QueryTag] = []


class PostingCreateRequest(BaseModel):
    title: str = Field(..., min_length=3, max_length=300)
    description: str = Field(..., min_length=10, max_length=8000)
    tags: TagGroups = TagGroups()
    key_stages_or_info: dict[str, str] = {}
    key_dates: dict[str, str] = {}
    # Soft analytics field the client reports about itself ("web"/"ios"/
    # "android") — see docs/ingestion/PATH-B-PROVENANCE-PLAN.md. Unlike
    # channel/posting_date, a client lying about its own platform has no
    # content-integrity stakes, so this is safe to accept on the public
    # route; invalid values are clamped to "" server-side, never rejected.
    client_platform: str = ""


class PostingCreateResponse(BaseModel):
    case_id: str
    gcs_path: str
    indexed: bool
    author_handle: str


# --- User profile + onboarding (phase-I) ---
class SeedUser(BaseModel):
    id: str
    username: str
    label: str = ""


class NewUserRequest(BaseModel):
    username: str = ""
    # Optional client-supplied id (a Firebase uid) to REGISTER instead of minting
    # a "new-…" dev id. Idempotent: re-registering returns the existing account.
    uid: str = ""


class JourneyEntry(BaseModel):
    milestone: str = ""
    date: str = ""
    experience: str = ""
    shared: bool = False          # phase-J: consent to make this experience searchable
    experience_case_id: str = ""  # the published searchable doc id (set by the backend)


class ReconcileRequest(BaseModel):
    # The in-progress message/posting being composed (canonical fields or description).
    message: dict = {}


class ReconcileResponse(BaseModel):
    merged: dict
    conflicts: list[dict] = []
    prefilled: list[str] = []
    explainer: str = ""


class ConnectCardRequest(BaseModel):
    note: str = Field("", max_length=2000)


class ContentPublishResponse(BaseModel):
    case_id: str
    doc_kind: str
    gcs_path: str
    indexed: bool


class ProfilePayload(BaseModel):
    username: str = ""
    current_visa_or_greencard_category: list[str] = []
    visa_applying_for: list[str] = []
    primary_consulate: str = ""
    consulates: list[str] = []
    tags: list[str] = []
    key_stages_or_info: dict[str, str] = {}
    key_dates: dict[str, str] = {}
    background_text: str = ""
    journey: list[JourneyEntry] = []


class KeyDatesUpdate(BaseModel):
    key_dates: dict[str, str] = {}


class OnboardRequest(BaseModel):
    messages: list[dict] = []
    draft: ProfilePayload = ProfilePayload()
    stage: str = "basics"  # 'basics' (Stage 1) | 'experiences' (Stage 2, post-save)


class OnboardResponse(BaseModel):
    reply: str
    profile: dict
    done: bool


class SourceInfo(BaseModel):
    chunk_id: str
    text: str
    source: str
    labels: list[str]
    score: float
    as_of: str = ""


class AskResponse(BaseModel):
    answer: str
    sources: list[SourceInfo]
    is_fallback: bool
    id: str


class QAItem(BaseModel):
    id: str
    question: str
    answer: str
    sources: list[str]
    labels: list[str]
    created_at: str | None
    is_fallback: bool
    helpful: bool | None


class QAListResponse(BaseModel):
    items: list[QAItem]


class FeedbackRequest(BaseModel):
    helpful: bool


# --- Email verification (6-digit code) ---
class SendCodeRequest(BaseModel):
    email: str = Field(..., min_length=5, max_length=254)


class SendCodeResponse(BaseModel):
    ok: bool
    message: str = ""


class VerifyCodeRequest(BaseModel):
    email: str = Field(..., min_length=5, max_length=254)
    code: str = Field(..., min_length=6, max_length=6)


class VerifyCodeResponse(BaseModel):
    verified: bool
    error: str = ""


class HealthResponse(BaseModel):
    status: str
    chunks_loaded: int


class PostingCard(BaseModel):
    case_id: str
    title: str
    description: str
    visa: list[str]
    consulates: list[str]
    outcome: str
    subreddit: str
    channel: str
    tags: list[str]
    url: str
    date: str
    timestamp: str = ""  # full ingestion timestamp (for relative "X ago" + recency sort)
    event_timestamp: str = ""  # the ORIGINAL source event date — never ingestion time
    # Authoring app user's uid (first-party postings only), resolved from the
    # Firestore posting↔author link. Lets the client block an author from the
    # feed and hide their cards instantly (App Store Guideline 1.2).
    author_id: str = ""
    # Source author identity — a synthetic per-item handle for app/Reddit
    # postings, or a fixed per-source handle (e.g. "USCIS") for gov-news
    # content. See docs/ingestion/GOV-NEWS-INGESTION-PLAN.md §3.6.
    author_handle: str = ""


class FacetValue(BaseModel):
    code: str
    label: str
    count: int


class SuggestedFilter(BaseModel):
    key: str
    label: str
    field: str
    values: list[FacetValue]


class SearchResponse(BaseModel):
    results: list[PostingCard]
    next_page_token: str
    total: int
    applied_filters: dict = {}
    relaxed: bool = False
    effective_strictness: str = ""
    suggested_filters: list[SuggestedFilter] = []


class TagSection(BaseModel):
    """One labeled tag category for the detail view (e.g. 'Applying for')."""
    label: str
    tags: list[str]


class PostingDetail(PostingCard):
    body: str
    # The authoring app user's id, resolved from the Firestore posting↔author
    # link. Empty for Reddit/other-source postings or app postings published
    # before author capture (kept OUT of the search datastore — anonymity there
    # is preserved; the link lives only in Firestore for this author view).
    author_id: str = ""
    # First-party author handle (synthetic or username). Present for app/website
    # postings, empty for external (Reddit) ingests. Links to the author-by-handle
    # page. Distinct from author_id (the real app uid, only for in-app authoring).
    author_handle: str = ""
    # All tag categories kept SEPARATE (the card's `visa`/`consulates`/`tags`
    # collapse several facet groups into one). Detail view only; empty for
    # postings whose metadata carries no recognised tag groups.
    tag_sections: list[TagSection] = []


class AuthorPostingCard(BaseModel):
    case_id: str
    title: str
    visa: list[str] = []
    consulates: list[str] = []
    outcome: str = ""
    date: str = ""


class AuthorPostingsResponse(BaseModel):
    postings: list[AuthorPostingCard]


class UserReplyCard(BaseModel):
    id: str
    parent_case_id: str
    body: str
    created_at: str = ""


class UserRepliesResponse(BaseModel):
    replies: list[UserReplyCard]


# --- Replies + voting (phase-L) ---
class ReplyCreate(BaseModel):
    body: str = Field(..., min_length=1, max_length=5000)
    parent_reply_id: str = ""  # empty = top-level reply; else the reply being answered


class VoteTally(BaseModel):
    up: int = 0
    down: int = 0
    score: int = 0
    your_vote: int = 0  # the viewer's current vote on this content: -1 | 0 | 1


class ReplyCard(BaseModel):
    id: str
    parent_case_id: str
    parent_reply_id: str = ""  # empty = top-level; else the reply this answers (for client-side threading)
    body: str
    author_handle: str
    author_id: str = ""  # author uid (blank on your own) — for block-user (Apple 1.2)
    created_at: str
    deleted: bool = False
    up: int = 0
    down: int = 0
    score: int = 0
    your_vote: int = 0
    is_author: bool = False


class RepliesResponse(BaseModel):
    replies: list[ReplyCard]
    posting: VoteTally  # the parent posting's own tally + the viewer's vote on it
    total: int


class VoteRequest(BaseModel):
    content_id: str = Field(..., min_length=1, max_length=300)  # posting case_id OR reply id
    dir: int = 0  # -1 | 0 | 1  (0 clears the vote)


class VoteResponse(VoteTally):
    content_id: str


# --- Find users in same boat + groups (phase-M) ---
class Criteria(BaseModel):
    current_visa_or_greencard_category: list[str] = []
    visa_applying_for: list[str] = []
    primary_consulate: str = ""
    consulates: list[str] = []
    tags: list[str] = []
    key_stages_or_info: dict[str, str] = {}
    key_dates: dict[str, str] = {}
    background_text: str = ""


class FindChatRequest(BaseModel):
    messages: list[dict] = []
    draft: Criteria = Criteria()


class FindChatResponse(BaseModel):
    reply: str
    criteria: dict
    done: bool


class MatchesRequest(BaseModel):
    criteria: Criteria = Criteria()


class MatchCard(BaseModel):
    user_id: str
    username: str
    score: float
    shared: list[str] = []
    summary: str = ""
    background: str = ""
    reason: str = ""  # one human sentence for WHY this candidate surfaced


class MatchesResponse(BaseModel):
    matches: list[MatchCard]
    total: int


class GroupMember(BaseModel):
    user_id: str
    username: str = ""
    score: float = 0


class GroupCreate(BaseModel):
    criteria_text: str = ""
    criteria: Criteria = Criteria()
    members: list[GroupMember] = []
    group_type: str = ""  # "" = regular, "timeline" = Timeline Group
    description: str = ""
    validity: str = ""  # e.g. "1_month" | "1_year" | "5_years" — see matching.py _VALIDITY_DAYS
    values: dict[str, str] = {}  # post-join attribute values, if this creates/joins a Timeline group needing them
    notes: str = ""


class InvitationCard(BaseModel):
    """A pending (or resolved) group invitation. Declared BEFORE GroupCard so
    GroupCard can reference it without a forward-reference rebuild; the
    group↔invitation pairing lives on the PendingInvitation wrapper below
    rather than nesting, which would make the two models mutually recursive."""
    invitation_id: str
    group_id: str
    group_name: str = ""
    user_id: str = ""
    username: str = ""
    invited_by: str = ""
    invited_by_username: str = ""
    status: str = "pending"  # pending | accepted | declined | cancelled
    requires_attributes: bool = False  # accepting will demand the post-join form
    created_at: str = ""
    responded_at: str = ""


class SkippedInvite(BaseModel):
    user_id: str
    reason: str = ""  # already_member | already_pending | self | unknown_user


class GroupCard(BaseModel):
    group_id: str
    name: str = ""
    description: str = ""
    group_type: str = ""
    criteria_text: str = ""
    criteria_tags: dict = {}
    members: list[GroupMember] = []
    created_by: str = ""
    created_by_username: str = ""
    is_admin: bool = False  # true for the viewer who created this group
    status: str = "active"  # active | archived | deleted
    expiration_date: str = ""
    created_at: str = ""
    last_activity_at: str = ""
    is_member: bool = False
    joined: bool = False  # true when an existing group was joined (vs. created)
    needs_attributes: bool = False  # viewer-scoped: true if a Timeline post-join attribute template applies and they haven't submitted yet
    score: float = 0.0  # set only on /api/groups/search results (regular groups)
    shared: list[str] = []  # set only on /api/groups/search results (regular groups)
    is_invited: bool = False  # viewer-scoped: they have a PENDING invite (browse lists only)
    invited: list[InvitationCard] = []  # set by POST /api/groups when peers were invited


class GroupsResponse(BaseModel):
    groups: list[GroupCard]


class PendingInvitation(BaseModel):
    invitation: InvitationCard
    group: GroupCard


class PendingInvitationsResponse(BaseModel):
    invitations: list[PendingInvitation] = []
    total: int = 0


class InvitationsResponse(BaseModel):
    invitations: list[InvitationCard] = []
    total: int = 0


class InviteBatchResponse(BaseModel):
    group: GroupCard
    invited: list[InvitationCard] = []
    skipped: list[SkippedInvite] = []


class GroupSearchRequest(BaseModel):
    criteria: Criteria = Criteria()
    group_type: str = ""
    precision: str = "balanced"  # broad | balanced | strict — regular groups only
    max_age_days: int = 0  # 0 = all time


class GroupPreview(BaseModel):
    """What POST /api/groups/preview returns — the name and description these
    criteria would produce, generated by the same code that names the group
    on create."""
    name: str = ""
    description: str = ""


class AddMembersRequest(BaseModel):
    user_ids: list[str] = Field(default=[], max_length=50)


class GroupUpdate(BaseModel):
    name: str | None = None
    description: str | None = None


class GroupArchiveUpdate(BaseModel):
    archived: bool = True


class GroupInvite(BaseModel):
    handle: str = Field(..., min_length=1, max_length=64)


class JoinGroupBody(BaseModel):
    values: dict[str, str] = {}  # post-join attribute values, required if the group needs them (see matching.join_group)
    notes: str = ""


class MemberAttributesUpdate(BaseModel):
    values: dict[str, str] = {}
    notes: str = ""


# --- Group chat messages (phase-N) ---
class MessageCreate(BaseModel):
    text: str = Field(..., min_length=1, max_length=4000)


class MessageCard(BaseModel):
    id: str
    author_handle: str
    author_id: str = ""  # author uid (blank on your own) — for block-user (Apple 1.2)
    text: str
    created_at: str
    deleted: bool = False
    is_author: bool = False


# --- UGC safety / moderation (App Store Guideline 1.2) ---
class ReportRequest(BaseModel):
    content_id: str = Field(..., min_length=1, max_length=300)
    content_type: str = Field(..., pattern="^(posting|reply|message)$")
    container_id: str = ""  # group_id when reporting a group message
    reason: str = "other"


class ReportResponse(BaseModel):
    ok: bool
    report_count: int = 0
    hidden: bool = False


class BlockRequest(BaseModel):
    blocked_uid: str = Field(..., min_length=1, max_length=128)


class BlocksResponse(BaseModel):
    ok: bool = True
    blocked_uids: list[str] = []


class AdminTakedownRequest(BaseModel):
    content_id: str = Field(..., min_length=1, max_length=300)
    content_type: str = Field(..., pattern="^(posting|reply|message)$")
    container_id: str = ""
    eject_author: bool = False


class MessagesResponse(BaseModel):
    messages: list[MessageCard]
    total: int


class ChatRequest(BaseModel):
    question: str = Field(..., min_length=5, max_length=500)
    strictness: str = "balanced"  # broad | balanced | strict
    facets: list[str] = []  # selected chips, each 'field:value' (exact filter)


class ChatResponse(BaseModel):
    mode: str  # "answer" | "search"
    intent: str
    answer: str = ""
    sources: list[SourceInfo] = []
    is_fallback: bool = False
    results: list[PostingCard] = []
    next_page_token: str = ""
    applied_filters: dict = {}
    relaxed: bool = False
    effective_strictness: str = ""
    suggested_filters: list[SuggestedFilter] = []
    id: str = ""


# --- AI Assist (conversational router) ---
class AssistTurn(BaseModel):
    role: str = "user"          # "user" | "ai"
    content: str = ""
    intent: str = ""            # the intent that produced an "ai" turn (echoed back)


class AssistRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=2000)
    history: list[AssistTurn] = []
    session_id: str = ""        # client-generated; anon rate-limit + analytics key only
    force_intent: str = ""      # "" | "post" | "timeline-find" (the A5 override)


class AssistCitation(BaseModel):
    source: str = ""
    title: str = ""
    as_of: str = ""


class AssistCommunityCard(BaseModel):
    case_id: str = ""
    title: str = ""
    snippet: str = ""
    url: str = ""               # external permalink, or /case/{case_id}
    channel: str = ""


class AssistPostDraft(BaseModel):
    title: str = ""
    description: str = ""
    groups: dict = {}
    key_stages_or_info: dict[str, str] = {}
    key_dates: dict[str, str] = {}


class AssistTimeline(BaseModel):
    status: str = ""            # "found" | "not_found" | "unresolved"
    group_id: str = ""
    group_name: str = ""
    criteria: dict = {}
    find_url: str = ""          # /find Timeline-mode deep-link, prefilled from criteria


class AssistResponse(BaseModel):
    intent: str
    confidence: float = 0.0
    answer: str = ""
    source_tier: str = ""       # "gov" | "community" | "ungrounded" | ""
    citations: list[AssistCitation] = []
    community_cards: list[AssistCommunityCard] = []
    clarify_questions: list[str] = []
    post_draft: AssistPostDraft | None = None
    timeline: AssistTimeline | None = None
    find_url: str = ""
    search_suggestions_html: str = ""   # web tier: Google Search-Suggestion chips (UI must render)
    disclaimer: str = ""
    can_post: bool = True
    can_find_timeline: bool = False
    can_find_similar: bool = False
    rationale: str = ""
    id: str = ""
    turns_used: int = 0


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

def _grounded_answer(question: str) -> dict:
    """Grounded answer over the datastore (tier 1+2), with the public DS-2
    fallback (tier 3) when ingested content can't answer. Falls back to direct
    Gemini only if no search engine is configured."""
    if not _engine_id:
        return {"answer": generate_direct_answer(question), "chunks": [], "is_fallback": False}
    result = answer_query(question, _project_id, _ds_location, _engine_id)
    if result["is_fallback"] and _public_engine_id:
        public = answer_query(question, _project_id, _ds_location, _public_engine_id)
        if not public["is_fallback"]:
            result = public
    return result


def _save(question: str, result: dict) -> str:
    if not _db:
        return ""
    try:
        return save_qa_pair(question, result, _db)
    except Exception as e:
        print(f"Warning: Could not save to Firestore: {e}")
        return ""


def _save_assist(question: str, result: dict) -> str:
    """Log an AI-Assist turn to qa_pairs with the routing decision + grounding
    tier (Q15). Sources come from the citations and community-card links."""
    if not _db:
        return ""
    try:
        chunks = [{"source": c.get("source", "")} for c in result.get("citations", [])]
        chunks += [{"source": c.get("url", "")} for c in result.get("community_cards", [])]
        payload = {"answer": result.get("answer", ""), "chunks": chunks,
                   "is_fallback": result.get("is_fallback", False)}
        return save_qa_pair(question, payload, _db,
                            route=result.get("intent", ""),
                            source_tier=result.get("source_tier", ""))
    except Exception as e:
        print(f"Warning: could not save assist qa: {e}")
        return ""


def _guard(fn):
    """Run a grounding call; turn a persistent GCP/network error into a clean
    503 instead of a 500 traceback (transient blips are already retried)."""
    try:
        return fn()
    except GoogleAPICallError as e:
        print(f"Grounding service error: {type(e).__name__}: {e}")
        raise HTTPException(
            status_code=503,
            detail="The assistant is temporarily unavailable. Please try again in a moment.",
        )


# Dev-only user impersonation via X-User-Id. Fail-closed: defaults OFF so a
# missing env var in prod can never enable it — dev/test opt in with =1. When
# off, the uid comes ONLY from a verified Firebase ID token (same users/{id}
# schema).
ALLOW_USER_IMPERSONATION = os.getenv("ALLOW_USER_IMPERSONATION", "0") == "1"

# --- Firebase ID-token verification (BLOCKER-0 / docs/AUTH-INTEGRATION.md).
# Optional import so local/dev without the dep still runs on the X-User-Id path;
# on Cloud Run the dep is installed and bearer tokens are verified via ADC. ---
try:
    import firebase_admin as _fb
    from firebase_admin import auth as _fb_auth
except ImportError:  # dep absent (dev) → token path disabled, header path stays
    _fb = None
    _fb_auth = None

_fb_inited = False


def _firebase_ready() -> bool:
    """Lazily initialize the Admin SDK once (ADC; no key file). False if
    firebase-admin isn't installed or init fails — callers then fall back."""
    global _fb_inited
    if _fb is None:
        return False
    if _fb_inited:
        return True
    try:
        if not _fb._apps:
            proj = os.getenv("GCP_PROJECT_ID") or os.getenv("GCP_PROJECT")
            _fb.initialize_app(options={"projectId": proj} if proj else None)
        _fb_inited = True
    except Exception as e:  # noqa: BLE001
        print(f"firebase init failed: {e}")
        return False
    return True


def _verify_bearer(request: Request) -> tuple[str, str] | None:
    """Verify `Authorization: Bearer <Firebase ID token>`. Returns (uid, name_hint)
    or None when the header is absent / malformed / invalid / expired."""
    hdr = request.headers.get("authorization", "")
    if len(hdr) < 8 or hdr[:7].lower() != "bearer ":
        return None
    token = hdr[7:].strip()
    if not token or not _firebase_ready():
        return None
    try:
        d = _fb_auth.verify_id_token(token)
    except Exception as e:  # noqa: BLE001 — invalid/expired → caller returns 401
        print(f"_verify_bearer: rejected ({type(e).__name__})")
        return None
    uid = d.get("uid") or d.get("sub") or ""
    name = d.get("name") or (d.get("email", "") or "").split("@")[0] or ""
    return (uid, name) if uid else None

# Registered uids (e.g. Firebase accounts) accepted by the X-User-Id gate.
# Source of truth is the Firestore users/{uid} doc created by POST /api/users;
# this set just caches positive lookups. NOTE: the header is still UNVERIFIED —
# server-side Firebase ID-token verification is the Option-A follow-up.
_KNOWN_UIDS: set[str] = set()


def _uid_registered(uid: str) -> bool:
    """True if a users/{uid} profile doc exists (cached after first hit)."""
    if uid in _KNOWN_UIDS:
        return True
    if _db is None:
        return False
    try:
        if _db.collection("users").document(uid).get().exists:
            _KNOWN_UIDS.add(uid)
            return True
    except Exception as e:  # noqa: BLE001 — gate lookup must never 500
        print(f"_uid_registered({uid}): {e}")
    return False


def _uid_accepted(uid: str) -> bool:
    """Baked roster, dev-created 'new-…' ids, or registered (Firebase) accounts."""
    import profile
    return uid in profile.seed_ids() or uid.startswith("new-") or _uid_registered(uid)


def _ensure_registered(uid: str, name_hint: str = "") -> None:
    """Create a minimal users/{uid} profile for a freshly-verified Firebase uid
    (idempotent; never blocks the request)."""
    if not uid or _db is None or _uid_registered(uid):
        return
    import profile
    # Anonymity: assign a random Reddit-style handle — NEVER the real name in
    # `name_hint` (the Firebase token's display name / email prefix).
    username = profile.random_username(_db)
    try:
        profile.save_profile(_db, uid, {"username": username})
        _KNOWN_UIDS.add(uid)
    except Exception as e:  # noqa: BLE001 — registration must not 500 the request
        print(f"_ensure_registered({uid}): {e}")


def _resolve_uid(request: Request, *, required: bool) -> str:
    """Identity resolution. Prefers a VERIFIED Firebase ID token; falls back to the
    unverified `X-User-Id` header ONLY when `ALLOW_USER_IMPERSONATION` (dev/test).
    In prod (impersonation off) a request without a valid token is unauthenticated."""
    verified = _verify_bearer(request)
    if verified:
        uid, name = verified
        _ensure_registered(uid, name)
        return uid
    if ALLOW_USER_IMPERSONATION:
        hdr = request.headers.get("x-user-id", "").strip()
        if hdr and _uid_accepted(hdr):
            return hdr
        if not required:
            return ""
        if not hdr:
            raise HTTPException(status_code=400, detail="X-User-Id header is required (pick a user).")
        raise HTTPException(status_code=404, detail=f"Unknown user '{hdr}'.")
    if not required:
        return ""
    raise HTTPException(status_code=401, detail="Authentication required.")


def _active_user(request: Request) -> str:
    """Verified-token uid (preferred) or, in dev, the X-User-Id header. Raises 401/400/404."""
    return _resolve_uid(request, required=True)


def _optional_user(request: Request) -> str:
    """Like `_active_user` but never raises — returns '' when unauthenticated.
    Used by read endpoints that personalize (e.g. the viewer's own votes) but
    are still usable anonymously."""
    return _resolve_uid(request, required=False)


@app.post("/api/ask", response_model=AskResponse)
def ask_question(body: AskRequest, request: Request):
    """Submit a question and get a RAG-powered answer."""
    client_ip = request.client.host if request.client else "unknown"
    if not check_rate_limit(client_ip):
        raise HTTPException(status_code=429, detail="Rate limit exceeded. Try again in a minute.")

    result = _guard(lambda: _grounded_answer(body.question))
    doc_id = _save(body.question, result)

    return AskResponse(
        answer=result["answer"],
        sources=[SourceInfo(**c) for c in result["chunks"]],
        is_fallback=result["is_fallback"],
        id=doc_id,
    )


@app.post("/api/expert", response_model=ExpertResponse)
def expert(body: ExpertRequest, request: Request):
    """A US-immigration-expert answer from Gemini's general knowledge — NOT
    grounded on the ingested postings (the 'AI mode' panel). Supports follow-ups
    via the optional conversation history."""
    client_ip = request.client.host if request.client else "unknown"
    if not check_rate_limit(client_ip):
        raise HTTPException(status_code=429, detail="Rate limit exceeded. Try again in a minute.")

    question = body.question
    if body.history:
        convo = "\n".join(
            f"{str(t.get('role', 'user')).capitalize()}: {t.get('content', '')}"
            for t in body.history[-6:]
        )
        question = f"Conversation so far:\n{convo}\n\nFollow-up question: {body.question}"

    return ExpertResponse(answer=_guard(lambda: generate_direct_answer(question)))


@app.post("/api/tag-suggest", response_model=TagSuggestResponse)
def tag_suggest(body: TagSuggestRequest, request: Request):
    """Auto-derive controlled-vocabulary tags from the composer's title+description,
    plus the expert-curated set of relevant sections to show. Pure read; no side effects."""
    client_ip = request.client.host if request.client else "unknown"
    if not check_rate_limit(client_ip):
        raise HTTPException(status_code=429, detail="Rate limit exceeded. Try again in a minute.")

    import posting

    out = _guard(lambda: posting.suggest_tags(body.title, body.description))
    return TagSuggestResponse(
        groups=TagGroups(**out["groups"]),
        relevant_sections=out["relevant_sections"],
        posting_type=out["posting_type"],
        key_stages_or_info=out.get("key_stages_or_info", {}),
        key_dates=out.get("key_dates", {}),
    )


@app.post("/api/search/query-tags", response_model=QueryTagsResponse)
def search_query_tags(body: QueryTagsRequest, request: Request):
    """Auto-derive controlled-vocabulary tags from a search query string, using
    the same Gemini-based tagging principles as posting composition (see
    posting.suggest_query_tags). Meant to be called once per search submit
    (not per keystroke) in parallel with /api/search — a slow/failed call here
    must never block or delay showing search results."""
    client_ip = request.client.host if request.client else "unknown"
    if not check_rate_limit(client_ip):
        raise HTTPException(status_code=429, detail="Rate limit exceeded. Try again in a minute.")

    import posting

    out = _guard(lambda: posting.suggest_query_tags(body.q))
    return QueryTagsResponse(tags=[QueryTag(**t) for t in out])


@app.get("/api/tag-vocab")
def tag_vocab():
    """Controlled vocabularies (visa / consulate / tag) for the composer's
    add-tag autocomplete, plus the Timeline attribute templates.

    The vocabulary half is static. The attribute half is externalised config
    (attribute_config) and changes without a deploy, so clients should cache
    this on the order of the config TTL, not indefinitely."""
    import posting

    return posting.vocab_lists()


@app.get("/api/config/attributes")
def get_attribute_config():
    """The Timeline attribute spec currently in force, plus where it came
    from. `source` is the operational answer to "is prod running my edit?":

      firestore  — serving the published document
      last-good  — the document is unreadable or failed validation; still
                   serving the previous good one (see last_error)
      default    — nothing published, or nothing has ever validated; serving
                   the spec baked into the image

    Read-only by design: the API never writes config, so a bad spec cannot
    arrive over HTTP. Publishing goes through
    scripts/publish_attribute_config.py, which validates first."""
    import attribute_config

    return {"meta": attribute_config.meta(), "spec": attribute_config.get()}


@app.post("/api/config/attributes/refresh")
def refresh_attribute_config(request: Request):
    """Force an immediate re-read instead of waiting out the TTL — for the
    moment after publishing when you want to confirm the rollout rather than
    watch a clock. Admin-token gated: it is cheap, but it is an unauthenticated
    Firestore read amplifier otherwise."""
    _require_admin(request)
    import attribute_config

    attribute_config.refresh(force=True)
    return {"ok": True, "meta": attribute_config.meta()}


@app.post("/api/postings", response_model=PostingCreateResponse)
def create_posting(body: PostingCreateRequest, request: Request):
    """Publish a new posting: build canonical sidecar JSON → write GCS sidecar →
    documents.import into DS-1 → BigQuery row. Returns the new case_id."""
    client_ip = request.client.host if request.client else "unknown"
    if not check_rate_limit(client_ip):
        raise HTTPException(status_code=429, detail="Rate limit exceeded. Try again in a minute.")

    import posting
    import profile

    # A trusted offline/curated publish (the manual publish.sh) carries the
    # internal secret and is NOT a signed-in user client — bypass the user +
    # profile gates and record NO author link (curated/system content). This
    # restores the pre-auth-hardening path for that trusted caller only; the
    # public UI path stays locked down below.
    #
    # Otherwise: posting requires a signed-in user. A personal-case message
    # additionally requires a set-up profile (a visa/status), but a general
    # discussion/blog (tagged `discussion`/`blog`) is NOT tied to the author's
    # own case, so it is exempt from that profile requirement. Author is kept OUT
    # of the posting itself / search datastore — only in the Firestore link below.
    if _is_internal_request(request):
        author_uid = ""
    else:
        author_uid = _active_user(request)
        is_discussion = bool({"discussion", "blog"} & set(body.tags.tags or []))
        if not is_discussion:
            _prof = _guard(lambda: profile.get_profile(_db, author_uid))
            if not (_prof.get("current_visa_or_greencard_category") or _prof.get("visa_applying_for")):
                raise HTTPException(status_code=422,
                                    detail="Set up your profile (add your visa/status) before posting a message.")

    try:
        result = _guard(lambda: posting.publish_posting(
            body.title, body.description, body.tags.model_dump(),
            body.key_stages_or_info, body.key_dates,
            client_platform=body.client_platform,
        ))
    except ValueError as e:
        # vocabulary / schema validation failure → 422
        raise HTTPException(status_code=422, detail=f"Posting failed validation: {e}")

    # Record the author link (Firestore only) so the author's profile + their
    # other postings can be shown on the case page. Best-effort — never blocks
    # the publish.
    if author_uid and _db is not None:
        try:
            visa = list(dict.fromkeys(
                (body.tags.visa_applying_for or []) + (body.tags.current_visa_or_greencard_category or [])
            ))
            _db.collection("posting_authors").document(result["case_id"]).set({
                "case_id": result["case_id"],
                "author_uid": author_uid,
                "channel": "app",
                "title": body.title,
                "visa": visa,
                "consulates": body.tags.consulates or [],
                "outcome": (body.key_stages_or_info or {}).get("outcome_status", ""),
                "created_at": firestore.SERVER_TIMESTAMP,
            })
        except Exception as e:  # noqa: BLE001 — author link is non-critical
            print(f"posting_authors write failed for {result['case_id']}: {e}")

    return PostingCreateResponse(**result)


# ---------------------------------------------------------------------------
# User profile + AI onboarding (phase-I)
# ---------------------------------------------------------------------------

@app.get("/api/users", response_model=list[SeedUser])
def list_users():
    """The baked seed roster for the dev user-picker (no auth yet)."""
    import profile
    return [SeedUser(**u) for u in profile.seed_users()]


@app.post("/api/users", response_model=SeedUser)
def create_user(body: NewUserRequest):
    """Create/register a user account.

    - No `uid` (dev picker): mint a fresh "new-…" id to onboard from scratch.
    - With `uid` (Firebase sign-in/up): register that uid so the X-User-Id gate
      accepts it. Idempotent — an already-registered uid returns its existing
      account and NEVER overwrites the stored profile. The header remains
      unverified dev-mode identity until ID-token verification lands (Option A).
    """
    import re as _re
    import secrets
    import profile
    if not ALLOW_USER_IMPERSONATION:
        raise HTTPException(status_code=403, detail="User creation is disabled.")

    uid = (body.uid or "").strip()
    if uid:
        if uid in profile.seed_ids() or not _re.fullmatch(r"[A-Za-z0-9_-]{6,128}", uid):
            raise HTTPException(status_code=422, detail="Invalid uid.")
        if _uid_registered(uid):
            # Already registered — return the existing account untouched.
            existing = _guard(lambda: profile.get_profile(_db, uid))
            return SeedUser(id=uid, username=existing.get("username") or uid, label=existing.get("username") or uid)
        # Anonymity: always mint a random handle — ignore any client-supplied
        # `body.username` (which historically carried the real display name).
        # Users rename themselves later via PUT /api/profile.
        username = profile.random_username(_db)
        _guard(lambda: profile.save_profile(_db, uid, {"username": username}))
        _KNOWN_UIDS.add(uid)
        return SeedUser(id=uid, username=username, label=username)

    new_id = "new-" + secrets.token_hex(4)
    username = profile.random_username(_db)
    # Register by creating the (empty) profile doc with the chosen username.
    _guard(lambda: profile.save_profile(_db, new_id, {"username": username}))
    return SeedUser(id=new_id, username=username, label=f"🆕 {username}")


@app.get("/api/profile")
def get_profile(request: Request):
    """The active user's profile (empty shell if not yet set up)."""
    import profile
    uid = _active_user(request)
    return _guard(lambda: profile.get_profile(_db, uid))


@app.put("/api/profile")
def put_profile(body: ProfilePayload, request: Request):
    """Validate + save the active user's profile. Returns the stored profile."""
    import profile
    uid = _active_user(request)
    return _guard(lambda: profile.save_profile(_db, uid, body.model_dump()))


@app.post("/api/profile/key-dates")
def update_key_dates(body: KeyDatesUpdate, request: Request):
    """Partial key_dates update — merges the given dates into the active
    user's existing profile (new keys added, matching keys overwritten,
    every other profile field round-trips unchanged). Used by the post-join
    Timeline attribute form (POST_JOIN_ATTRIBUTE_TEMPLATES); a plain PUT
    /api/profile would require resubmitting the whole profile, which the
    caller doesn't have on hand there."""
    import profile
    uid = _active_user(request)
    def _do():
        current = profile.get_profile(_db, uid)
        merged = profile.merge_profile(current, {**current, "key_dates": body.key_dates})
        return profile.save_profile(_db, uid, merged)
    return _guard(_do)


@app.delete("/api/users/me")
def delete_account(request: Request):
    """Delete the authenticated user's account and all associated data.

    This is an irreversible operation that:
    1. Deletes the user's profile from Firestore (users/{uid})
    2. Removes all posting author links (posting_authors where author_uid == uid)
    3. Soft-deletes all replies by the user (interactions where author_uid == uid)
    4. Removes user from groups they're a member of
    5. Soft-deletes messages authored by the user in group chats
    6. Deletes the Firebase Auth account
    """
    uid = _active_user(request)

    if _db is None:
        raise HTTPException(status_code=503, detail="Database not available")

    errors = []

    # 1. Delete user profile
    try:
        _db.collection("users").document(uid).delete()
        # Also remove from cached known uids
        _KNOWN_UIDS.discard(uid)
    except Exception as e:
        errors.append(f"profile: {e}")

    # 2. Delete posting author links (the postings themselves remain anonymous in the datastore)
    try:
        author_docs = list(_db.collection("posting_authors").where("author_uid", "==", uid).stream())
        for doc in author_docs:
            doc.reference.delete()
    except Exception as e:
        errors.append(f"posting_authors: {e}")

    # 3. Soft-delete all replies by the user (set deleted=True, clear body)
    try:
        reply_docs = list(_db.collection("interactions").where("author_uid", "==", uid).stream())
        for doc in reply_docs:
            doc.reference.update({"deleted": True, "body": "[deleted]"})
    except Exception as e:
        errors.append(f"interactions: {e}")

    # 4. Remove user from groups + soft-delete their messages
    try:
        # Find all groups the user is a member of
        groups = list(_db.collection("groups").stream())
        for group_doc in groups:
            group_data = group_doc.to_dict() or {}
            members = group_data.get("members", [])
            # Check if user is in this group's members list
            updated_members = [m for m in members if m.get("user_id") != uid]
            if len(updated_members) != len(members):
                # User was a member, update the group
                group_doc.reference.update({"members": updated_members})

            # Soft-delete any messages by this user in this group
            try:
                msg_docs = list(_db.collection("groups").document(group_doc.id)
                               .collection("messages").where("author_uid", "==", uid).stream())
                for msg_doc in msg_docs:
                    msg_doc.reference.update({"deleted": True, "text": "[deleted]"})
            except Exception:
                pass  # Group might not have messages subcollection
    except Exception as e:
        errors.append(f"groups: {e}")

    # 5. Delete votes by the user (cleanup, not critical)
    try:
        vote_docs = list(_db.collection("votes").where("user_id", "==", uid).stream())
        for doc in vote_docs:
            doc.reference.delete()
    except Exception:
        pass  # votes collection might not exist or have different schema

    # 5b. Delete group invitations ADDRESSED to the user. Invitations they
    # sent are left alone (they carry a now-dead invited_by uid, consistent
    # with how groups.created_by already retains a deleted user's uid).
    try:
        for doc in _db.collection("group_invitations").where("user_id", "==", uid).stream():
            doc.reference.delete()
    except Exception:
        pass  # collection may not exist yet

    # 6. Delete Firebase Auth account
    if _firebase_ready() and _fb_auth is not None:
        try:
            _fb_auth.delete_user(uid)
        except Exception as e:
            errors.append(f"firebase_auth: {e}")

    if errors:
        # Log errors but still return success - data cleanup is best-effort
        print(f"delete_account({uid}) partial errors: {errors}")

    return {"ok": True, "deleted_uid": uid}


# ---------------------------------------------------------------------------
# Email Verification (6-digit code via Resend)
# ---------------------------------------------------------------------------

# Rate limit for code requests: max 3 per email per hour
_code_rate_limit: dict[str, list[float]] = defaultdict(list)
CODE_RATE_LIMIT_MAX = 3
CODE_RATE_LIMIT_WINDOW = 3600  # 1 hour


def _check_code_rate_limit(email: str) -> bool:
    """Rate limit code requests per email address."""
    now = time.time()
    key = email.lower().strip()
    timestamps = _code_rate_limit[key]
    _code_rate_limit[key] = [t for t in timestamps if now - t < CODE_RATE_LIMIT_WINDOW]
    if len(_code_rate_limit[key]) >= CODE_RATE_LIMIT_MAX:
        return False
    _code_rate_limit[key].append(now)
    return True


def _generate_code() -> str:
    """Generate a 6-digit verification code (avoids sequential patterns)."""
    while True:
        code = "".join(random.choices(string.digits, k=6))
        # Reject obvious patterns like 123456, 111111, etc.
        if code not in ("123456", "654321", "000000", "111111", "222222",
                        "333333", "444444", "555555", "666666", "777777",
                        "888888", "999999"):
            return code


@app.post("/api/auth/send-code", response_model=SendCodeResponse)
def send_verification_code(body: SendCodeRequest, request: Request):
    """Generate and send a 6-digit verification code to the user's email.

    Stores the code in Firestore with a 10-minute TTL. Invalidates any
    previous code for this email. Rate limited to 3 requests per hour.
    """
    email = body.email.lower().strip()

    # Validate email format
    if "@" not in email or "." not in email.split("@")[-1]:
        raise HTTPException(status_code=422, detail="Invalid email address")

    # Rate limit per email
    if not _check_code_rate_limit(email):
        raise HTTPException(
            status_code=429,
            detail="Too many code requests. Please wait before requesting another code."
        )

    if _db is None:
        raise HTTPException(status_code=503, detail="Database not available")

    # Generate code and expiration
    code = _generate_code()
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=10)

    # Store in Firestore (overwrites any existing code for this email)
    try:
        _db.collection("verification_codes").document(email).set({
            "code": code,
            "email": email,
            "expires_at": expires_at,
            "attempts": 0,
            "created_at": firestore.SERVER_TIMESTAMP,
        })
    except Exception as e:
        print(f"Failed to store verification code: {e}")
        raise HTTPException(status_code=500, detail="Failed to generate verification code")

    # Send email via Resend
    resend_api_key = os.getenv("RESEND_API_KEY")
    if not resend_api_key:
        print("Warning: RESEND_API_KEY not set, code not sent")
        # In dev, return success but log the code
        print(f"[DEV] Verification code for {email}: {code}")
        return SendCodeResponse(ok=True, message="Code generated (check server logs in dev)")

    try:
        resend.api_key = resend_api_key
        resend.Emails.send({
            "from": "Meridian <noreply@meridianjourney.ai>",
            "to": [email],
            "subject": "Your Meridian verification code",
            "html": f"""
                <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #AE0000;">Verify your email</h2>
                    <p>Your verification code is:</p>
                    <div style="font-size: 32px; font-weight: bold; letter-spacing: 8px;
                                padding: 20px; background: #f5f5f5; text-align: center;
                                border-radius: 8px; margin: 20px 0;">
                        {code}
                    </div>
                    <p style="color: #666;">This code expires in 10 minutes.</p>
                    <p style="color: #666; font-size: 12px;">
                        If you didn't request this code, you can safely ignore this email.
                    </p>
                </div>
            """,
        })
    except Exception as e:
        print(f"Failed to send verification email: {e}")
        raise HTTPException(status_code=500, detail="Failed to send verification email")

    return SendCodeResponse(ok=True, message="Verification code sent")


@app.post("/api/auth/verify-code", response_model=VerifyCodeResponse)
def verify_code(body: VerifyCodeRequest, request: Request):
    """Verify a 6-digit code and mark the user's email as verified.

    On success, sets `email_verified: true` in the user's Firestore profile
    and deletes the verification code document.

    Max 5 attempts per code to prevent brute force.
    """
    email = body.email.lower().strip()
    code = body.code.strip()

    if _db is None:
        raise HTTPException(status_code=503, detail="Database not available")

    # Look up the code
    try:
        doc_ref = _db.collection("verification_codes").document(email)
        doc = doc_ref.get()
    except Exception as e:
        print(f"Failed to retrieve verification code: {e}")
        raise HTTPException(status_code=500, detail="Verification failed")

    if not doc.exists:
        return VerifyCodeResponse(verified=False, error="No verification code found. Please request a new one.")

    data = doc.to_dict() or {}
    stored_code = data.get("code", "")
    expires_at = data.get("expires_at")
    attempts = data.get("attempts", 0)

    # Check attempts (brute force protection)
    if attempts >= 5:
        # Delete the code - user must request a new one
        try:
            doc_ref.delete()
        except Exception:
            pass
        return VerifyCodeResponse(verified=False, error="Too many attempts. Please request a new code.")

    # Check expiration
    now = datetime.now(timezone.utc)
    if expires_at:
        # Handle both datetime and Firestore timestamp
        if hasattr(expires_at, "tzinfo") and expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if now > expires_at:
            try:
                doc_ref.delete()
            except Exception:
                pass
            return VerifyCodeResponse(verified=False, error="Code expired. Please request a new one.")

    # Check code match
    if code != stored_code:
        # Increment attempts
        try:
            doc_ref.update({"attempts": attempts + 1})
        except Exception:
            pass
        return VerifyCodeResponse(verified=False, error="Invalid code. Please try again.")

    # Success! Mark user as verified and delete the code
    # Find the user by email and update their profile
    try:
        # Query users by email (Firebase auth stores email on the user)
        # For now, we'll store email_verified keyed by email in a separate collection
        # and check it during auth flow
        _db.collection("verified_emails").document(email).set({
            "email": email,
            "verified_at": firestore.SERVER_TIMESTAMP,
        })

        # Delete the verification code
        doc_ref.delete()
    except Exception as e:
        print(f"Failed to mark email as verified: {e}")
        raise HTTPException(status_code=500, detail="Verification failed")

    return VerifyCodeResponse(verified=True)


@app.get("/api/auth/check-verified/{email}")
def check_email_verified(email: str):
    """Check if an email address has been verified."""
    email = email.lower().strip()

    if _db is None:
        raise HTTPException(status_code=503, detail="Database not available")

    try:
        doc = _db.collection("verified_emails").document(email).get()
        return {"verified": doc.exists}
    except Exception as e:
        print(f"Failed to check verification status: {e}")
        raise HTTPException(status_code=500, detail="Failed to check verification status")


@app.post("/api/onboard", response_model=OnboardResponse)
def onboard(body: OnboardRequest, request: Request):
    """One AI-onboarding turn: expert bot message + updated validated draft + done flag."""
    client_ip = request.client.host if request.client else "unknown"
    if not check_rate_limit(client_ip):
        raise HTTPException(status_code=429, detail="Rate limit exceeded. Try again in a minute.")
    import profile
    uid = _active_user(request)
    draft = body.draft.model_dump()
    if not draft.get("username"):
        draft["username"] = profile.username_for(uid)
    stage = "experiences" if body.stage == "experiences" else "basics"
    out = _guard(lambda: profile.onboard_turn(body.messages, draft, stage))
    return OnboardResponse(**out)


@app.post("/api/reconcile", response_model=ReconcileResponse)
def reconcile(body: ReconcileRequest, request: Request):
    """Phase-J (D-042): merge the active user's saved profile with an in-progress
    message → reconciled field values + conflicts + a friendly 'update profile?' prompt.
    The profile is never indexed; this only shapes the single posting JSON."""
    import profile
    import reconcile as rc
    uid = _active_user(request)
    prof = _guard(lambda: profile.get_profile(_db, uid))
    out = rc.reconcile_profile_message(prof, body.message or {})
    explainer = rc.explain_conflicts(out["conflicts"]) if out["conflicts"] else ""
    return ReconcileResponse(merged=out["merged"], conflicts=out["conflicts"],
                             prefilled=out["prefilled"], explainer=explainer)


@app.post("/api/connect-card", response_model=ContentPublishResponse)
def connect_card(body: ConnectCardRequest, request: Request):
    """Phase-J: publish an explicit 'looking to connect' card (doc_kind=connect_card)
    from the active user's current profile state."""
    client_ip = request.client.host if request.client else "unknown"
    if not check_rate_limit(client_ip):
        raise HTTPException(status_code=429, detail="Rate limit exceeded. Try again in a minute.")
    import posting
    import profile
    uid = _active_user(request)
    prof = _guard(lambda: profile.get_profile(_db, uid))
    if not (prof.get("current_visa_or_greencard_category") or prof.get("visa_applying_for")):
        raise HTTPException(status_code=422, detail="Set up your profile (a visa/status) before publishing a connect card.")
    return ContentPublishResponse(**_guard(lambda: posting.publish_connect_card(prof, body.note)))


@app.post("/api/chat", response_model=ChatResponse)
def chat(body: ChatRequest, request: Request):
    """Conversational turn: routes to a synthesized answer (ask) or a ranked
    list of posting cards (search), based on classified intent. `strictness`
    (broad|balanced|strict) controls search precision."""
    client_ip = request.client.host if request.client else "unknown"
    if not check_rate_limit(client_ip):
        raise HTTPException(status_code=429, detail="Rate limit exceeded. Try again in a minute.")

    intent = classify_intent(body.question)

    if intent == "search" and _engine_id:
        data = _guard(lambda: search_with_strictness(
            body.question, _project_id, _ds_location, _engine_id,
            page_size=10, strictness=body.strictness,
            extra_filter=_facets_filter(body.facets),
        ))
        # If search found nothing, fall through to an answer rather than an empty list.
        if data["results"]:
            return ChatResponse(
                mode="search",
                intent=intent,
                results=[PostingCard(**c) for c in data["results"]],
                next_page_token=data["next_page_token"],
                applied_filters=data.get("applied_filters", {}),
                relaxed=data.get("relaxed", False),
                effective_strictness=data.get("effective_strictness", ""),
                suggested_filters=[SuggestedFilter(**g) for g in _suggest(body.question)],
            )

    result = _guard(lambda: _grounded_answer(body.question))
    doc_id = _save(body.question, result)
    return ChatResponse(
        mode="answer",
        intent=intent,
        answer=result["answer"],
        sources=[SourceInfo(**c) for c in result["chunks"]],
        is_fallback=result["is_fallback"],
        # Situation-relevant refinements even on an answer turn (e.g. "see related
        # experiences: RFE / Denial / Premium processing").
        suggested_filters=[SuggestedFilter(**g) for g in _suggest(body.question)],
        id=doc_id,
    )


@app.post("/api/assist", response_model=AssistResponse)
def assist_turn(body: AssistRequest, request: Request):
    """AI-Assist conversational turn: the router (backend/assist.py) classifies the
    turn and returns a grounded answer (gov->community->ungrounded), a /post draft,
    an EAD/H-1B timeline group handoff, or clarifying questions. Anonymous users
    may ask (F3); posting/finding a group still requires login on those pages."""
    import assist as assist_mod

    client_ip = request.client.host if request.client else "unknown"
    uid = _optional_user(request)

    # Anonymous -> session-keyed soft cap + sign-in nudge (Q7/Q18); authenticated
    # -> the standard per-IP limiter.
    turns_used = 0
    if uid:
        if not check_rate_limit(client_ip):
            raise HTTPException(status_code=429, detail="Rate limit exceeded. Try again in a minute.")
    else:
        key = body.session_id or client_ip
        if not check_assist_anon_limit(key):
            raise HTTPException(status_code=429,
                                detail="You've reached the guest limit — sign in to keep asking.")
        turns_used = len(_assist_anon_rate[key])

    history = [t.model_dump() for t in body.history][-8:]
    result = _guard(lambda: assist_mod.handle_turn(
        body.message, history,
        force_intent=body.force_intent,
        project_id=_project_id, location=_ds_location, engine_id=_engine_id, db=_db,
    ))
    result["id"] = _save_assist(body.message, result)
    result["turns_used"] = turns_used
    return AssistResponse(**result)


@app.get("/api/qa", response_model=QAListResponse)
def list_qa(limit: int = 20, offset: int = 0, category: str = ""):
    """List recent Q&A pairs, optionally filtered by category label."""
    if not _db:
        return QAListResponse(items=[])
    if limit > 50:
        limit = 50
    items = get_recent_qa(_db, limit=limit, offset=offset)

    qa_items = []
    for item in items:
        # Extract labels from retrieved_chunks
        labels = set()
        for chunk in item.get("retrieved_chunks", []):
            labels.update(chunk.get("labels", []))
        labels_list = sorted(labels)

        # Filter by category if specified
        if category and category not in labels_list:
            continue

        qa_items.append(QAItem(
            id=item["id"],
            question=item.get("question", ""),
            answer=item.get("answer", ""),
            sources=item.get("sources", []),
            labels=labels_list,
            created_at=item.get("created_at"),
            is_fallback=item.get("is_fallback", False),
            helpful=item.get("helpful"),
        ))

    return QAListResponse(items=qa_items)


@app.post("/api/qa/{doc_id}/feedback")
def submit_feedback(doc_id: str, body: FeedbackRequest):
    """Submit feedback on a Q&A pair."""
    if not _db:
        return {"ok": False, "error": "Firestore not configured"}
    try:
        update_feedback(doc_id, body.helpful, _db)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=404, detail=f"Q&A pair not found: {e}")


@app.get("/api/qa/stats")
def qa_stats():
    """Get Q&A quality statistics."""
    if not _db:
        return {"total": 0, "successful": 0, "fallbacks": 0, "fallback_rate": 0, "helpful": 0, "not_helpful": 0, "top_categories": {}, "knowledge_gaps": []}

    from collections import Counter

    items = get_recent_qa(_db, limit=200, offset=0)
    total = len(items)
    fallbacks = [i for i in items if i.get("is_fallback")]
    successful = [i for i in items if not i.get("is_fallback")]

    # Label distribution
    all_labels = []
    for item in successful:
        for chunk in item.get("retrieved_chunks", []):
            all_labels.extend(chunk.get("labels", []))
    label_counts = dict(Counter(all_labels).most_common(20))

    # Feedback
    helpful = sum(1 for i in items if i.get("helpful") is True)
    not_helpful = sum(1 for i in items if i.get("helpful") is False)

    # Knowledge gaps
    gaps = [{"question": f.get("question", "")[:100]} for f in fallbacks[:10]]

    return {
        "total": total,
        "successful": len(successful),
        "fallbacks": len(fallbacks),
        "fallback_rate": len(fallbacks) / total if total > 0 else 0,
        "helpful": helpful,
        "not_helpful": not_helpful,
        "top_categories": label_counts,
        "knowledge_gaps": gaps,
    }


def _suggest(query: str) -> list:
    """Context-aware refinement facets (best-effort; never breaks search)."""
    if not _engine_id:
        return []
    try:
        return suggested_filters(query, _project_id, _ds_location, _engine_id)
    except Exception as e:  # noqa: BLE001
        print(f"suggested_filters failed: {e}")
        return []


def _build_filter(visa: str, consulate: str, outcome: str) -> str:
    """Build a Discovery Engine filter expression from optional facet params."""
    clauses = []
    if visa:
        clauses.append(f'visa_applying_for: ANY("{visa}")')
    if consulate:
        clauses.append(f'consulates: ANY("{consulate}")')
    if outcome:
        clauses.append(f'key_stages_or_info.outcome_status: ANY("{outcome}")')
    return " AND ".join(clauses)


def _facets_filter(facets: list[str]) -> str:
    """Hard filter from selected chips. Each item is 'field:value' (field from the
    suggested_filters response). ANDed; values on the same field are ORed."""
    by_field: dict[str, list[str]] = {}
    for item in facets or []:
        if ":" not in item:
            continue
        field, value = item.split(":", 1)
        field, value = field.strip(), value.strip()
        # allow only known facet fields (avoid arbitrary filter injection).
        # doc_kind added for the News tab (gov-news content) — see
        # docs/ingestion/GOV-NEWS-INGESTION-PLAN.md §7. NOT `channel`: live-
        # checked the Discovery Engine schema and `channel` is registered as
        # a bare {"type": "string"} only — not indexable/searchable/
        # dynamicFacetable — so `channel: ANY(...)` filter expressions 400.
        # `doc_kind` is fully indexed (same as "post"/"experience"/
        # "connect_card" already rely on), so that's the real filter field.
        if field in {"consulates", "visa_applying_for", "current_visa_or_greencard_category",
                     "key_stages_or_info.outcome_status", "tags", "concerns_or_questions_tags",
                     "derived_topic_cluster", "doc_kind"} and value:
            by_field.setdefault(field, []).append(value)
    clauses = []
    for field, values in by_field.items():
        ors = " OR ".join(f'{field}: ANY("{v}")' for v in values)
        clauses.append(f"({ors})")
    return " AND ".join(clauses)


def _recency_news_clause(include_news: bool | None, max_age_days: int) -> str:
    """Optional extra filter clause from Advanced Search's "Include news" /
    "Cutoff period" controls. `None`/0 (the defaults) mean the caller hasn't
    specified either — each /api/search branch keeps its own pre-existing
    default behavior in that case (see call sites); this only returns a
    clause once a caller has explicitly opted into one of these controls.
    `max_age_days` restricts every doc_kind, not just news — a general
    recency window, not a news-only one."""
    clauses = []
    if include_news is False:
        clauses.append('(NOT doc_kind: ANY("gov_news"))')
    if max_age_days > 0:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=max_age_days)).strftime("%Y-%m-%d")
        clauses.append(f'posting_date > "{cutoff}"')
    return " AND ".join(clauses)


@app.get("/api/search", response_model=SearchResponse)
def search(
    request: Request,
    q: str = "",
    visa: str = "",
    consulate: str = "",
    outcome: str = "",
    strictness: str = "balanced",
    facet: list[str] = Query(default=[]),
    page_size: int = 10,
    page_token: str = "",
    sort: str = "event",
    include_news: bool | None = None,
    max_age_days: int = 0,
):
    """Ranked posting search (result cards). Browse/search mode, not Q&A.

    Explicit `visa`/`consulate`/`outcome` params and selected `facet` chips
    ('field:value') apply exact filters. `strictness` (broad|balanced|strict)
    controls how the NL query's extracted facets are applied. `sort`
    ("recent" | "event" — see search_client.py's _SORT_FIELDS): "event"
    (default) orders by the source's own original publish date — ingestion
    can lag days behind the source, so this is what "most recent" means
    everywhere now, not just for the News tab that introduced it; "recent"
    orders by ingestion time instead, for any caller that wants that.
    `include_news`/`max_age_days` are Advanced Search's explicit News/Cutoff
    controls (see _recency_news_clause) — omitted entirely by every other
    caller, which keeps each branch's own legacy default unchanged."""
    client_ip = request.client.host if request.client else "unknown"
    if not check_rate_limit(client_ip):
        raise HTTPException(status_code=429, detail="Rate limit exceeded. Try again in a minute.")
    if not _engine_id:
        return SearchResponse(results=[], next_page_token="", total=0)

    page_size = max(1, min(page_size, 50))
    selected = _facets_filter(facet)

    explicit = _build_filter(visa, consulate, outcome)
    recency_news = _recency_news_clause(include_news, max_age_days)
    hard = " AND ".join(e for e in (explicit, selected, recency_news) if e)
    if hard:
        # A hard filter (facet chips / visa / consulate / outcome) already
        # scopes results correctly on its own — don't ALSO force a fallback
        # query string here. Confirmed live: with no filter this fallback
        # ("immigration experience") is harmless, but combined with a facet
        # filter it does real damage — e.g. `doc_kind: ANY("gov_news")`
        # alone correctly matches all 250 USCIS articles, but adding that
        # fallback text drops it to 6, because Discovery Engine's relevance
        # matching excludes non-matching documents entirely regardless of
        # order_by. This is exactly what silently starved the News tab
        # (facet-only, no typed query) down to a handful of items. An empty
        # `query` here still returns the full, correctly-filtered set.
        data = search_postings(q, _project_id, _ds_location, _engine_id,
                               page_size=page_size, page_token=page_token, filter_expr=hard, sort=sort)
        explicit_filters = {k: v for k, v in {
            "consulate": [consulate] if consulate else [],
            "visa": [visa] if visa else [],
            "outcome": [outcome] if outcome else [],
        }.items() if v}
        data.setdefault("applied_filters", explicit_filters)
        data.setdefault("effective_strictness", "strict")
        data.setdefault("relaxed", False)
    elif not q.strip():
        # Empty query, no hard filter = BROWSE the feed most-recent-first. Use
        # the News tab's proven empty-query + doc_kind filter + order_by recipe:
        # a relevance fallback here (below) would re-rank by relevance and drop
        # the recency order entirely. The doc_kind filter scopes the feed to
        # user postings/experiences (gov_news has its own surface) AND keeps us
        # on the hard-filter path where `order_by ... desc` actually governs.
        # (Only reachable with include_news is not False and max_age_days==0
        # — anything else already routed through the hard-filter branch above
        # via _recency_news_clause — so include_news here can only be
        # None/True; True means Advanced Search explicitly asked for gov-news
        # in an otherwise-empty search.)
        browse_kinds = ["post", "experience"] + (["gov_news"] if include_news else [])
        browse_filter = "doc_kind: ANY(" + ", ".join(f'"{k}"' for k in browse_kinds) + ")"
        data = search_postings("", _project_id, _ds_location, _engine_id,
                               page_size=page_size, page_token=page_token,
                               filter_expr=browse_filter, sort=sort or "event")
        data.setdefault("applied_filters", {})
        data.setdefault("effective_strictness", "recent")
        data.setdefault("relaxed", False)
    else:
        # Free-text/relevance search, where Discovery Engine genuinely needs
        # some query text to rank against. Default to relevance ordering
        # (search_client._SORT_FIELDS comment) rather than forcing
        # posting_date-desc — a strongly-matching-but-older posting used to
        # get buried under unrelated recent ones within the same
        # facet-filtered set (features/ui-changes-1/changes-2-.md item 3).
        # A caller that explicitly wants ingestion-recency (sort="recent")
        # is still honored; "event" (the general default elsewhere) and any
        # other value both mean "let relevance govern" here.
        effective_sort = "recent" if sort == "recent" else "relevance"
        if include_news is not None or max_age_days > 0:
            # Advanced Search explicitly set News/Cutoff — that replaces the
            # legacy 7-day carve-out below entirely, including "no
            # restriction at all" when include_news=True and no cutoff is
            # set (an explicit ask to see everything, unfiltered).
            news_recency_filter = _recency_news_clause(include_news, max_age_days)
        else:
            # gov-news items shouldn't pollute ordinary keyword search — the
            # empty-query browse path already excludes them (browse_filter
            # above) and the News tab reaches them via its own explicit
            # doc_kind:gov_news facet chip (the hard-filter branch above, left
            # untouched). This is the one remaining path with no doc_kind
            # handling at all. Carve out anything still within the last 7 days
            # (by source event date, not ingestion) so breaking news can still
            # surface in a relevant keyword search while it's still news.
            # Only applies when the caller hasn't opted into the explicit
            # News/Cutoff controls above (i.e. every caller but Advanced
            # Search) — see _recency_news_clause.
            news_cutoff = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%d")
            news_recency_filter = f'((NOT doc_kind: ANY("gov_news")) OR posting_date > "{news_cutoff}")'
        data = search_with_strictness(q, _project_id, _ds_location, _engine_id,
                                      page_size=page_size, page_token=page_token,
                                      strictness=strictness, sort=effective_sort,
                                      extra_filter=news_recency_filter)

    # Hide moderation-taken-down postings and any authored by users the viewer
    # has blocked; also stamps each card's author_id for client-side blocking.
    data["results"] = _filter_feed(data["results"], _optional_user(request))

    return SearchResponse(
        results=[PostingCard(**c) for c in data["results"]],
        next_page_token=data["next_page_token"],
        total=data["total"],
        applied_filters=data.get("applied_filters", {}),
        relaxed=data.get("relaxed", False),
        effective_strictness=data.get("effective_strictness", ""),
        suggested_filters=[SuggestedFilter(**g) for g in _suggest(q)],
    )


def _posting_author_uid(case_id: str) -> str:
    """The app user who authored this posting, from the Firestore link (or '')."""
    if _db is None:
        return ""
    try:
        snap = _db.collection("posting_authors").document(case_id).get()
        return (snap.to_dict() or {}).get("author_uid", "") if snap.exists else ""
    except Exception as e:  # noqa: BLE001
        print(f"_posting_author_uid({case_id}): {e}")
        return ""


def _batch_posting_authors(case_ids: list[str]) -> dict[str, str]:
    """case_id → author_uid for first-party postings, resolved in ONE batched
    Firestore read (get_all) — the old per-card `.get()` cost a sequential
    round-trip per search result (N+1)."""
    if not case_ids or _db is None:
        return {}
    out: dict[str, str] = {}
    try:
        refs = [_db.collection("posting_authors").document(c) for c in case_ids]
        for snap in _db.get_all(refs):
            if snap.exists:
                out[snap.id] = (snap.to_dict() or {}).get("author_uid", "")
    except Exception as e:  # noqa: BLE001 — author stamping is best-effort
        print(f"_batch_posting_authors: {e}")
    return out


def _filter_feed(results: list[dict], viewer: str) -> list[dict]:
    """Stamp each first-party card with its author uid (so the client can block
    from the feed), then drop cards that are moderation-hidden or authored by a
    user the viewer has blocked (App Store Guideline 1.2 — hide instantly)."""
    if not results:
        return results
    import moderation
    blocked = moderation.blocked_uids(_db, viewer)
    case_ids = [c.get("case_id", "") for c in results if c.get("case_id")]
    hidden = moderation.hidden_content_ids(_db, case_ids)
    authors = _batch_posting_authors(
        [c["case_id"] for c in results if c.get("case_id") and c.get("channel") == "app"])
    out: list[dict] = []
    for c in results:
        cid = c.get("case_id", "")
        author = authors.get(cid, "") if c.get("channel") == "app" else ""
        c["author_id"] = author
        if cid in hidden:
            continue
        if author and author in blocked:
            continue
        out.append(c)
    return out


@app.get("/api/postings/{case_id}", response_model=PostingDetail)
def posting_detail(case_id: str):
    """Full detail for one posting (card fields + Markdown body + author link)."""
    card = get_posting(case_id, _project_id, _ds_location, _datastore_id)
    if card is None:
        raise HTTPException(status_code=404, detail="Posting not found")
    # Resolve the author only for first-party app postings (Reddit/others omit).
    card["author_id"] = _posting_author_uid(case_id) if card.get("channel") == "app" else ""
    return PostingDetail(**card)


@app.get("/api/authors/by-handle/{handle}/postings", response_model=AuthorPostingsResponse)
def author_postings_by_handle(handle: str):
    """All first-party postings authored under `handle` (newest first). Powers the
    public author-by-handle page; works for every first-party posting since they
    all carry an author_handle. Empty for unknown/blank handles."""
    cards = postings_by_handle(handle, _project_id, _ds_location, _datastore_id)
    items = [
        AuthorPostingCard(
            case_id=c.get("case_id", ""),
            title=c.get("title", ""),
            visa=c.get("visa", []),
            consulates=c.get("consulates", []),
            outcome=c.get("outcome", ""),
            date=c.get("date", ""),
        )
        for c in cards
    ]
    return AuthorPostingsResponse(postings=items)


@app.get("/api/users/{uid}/public-profile")
def public_profile(uid: str):
    """A posting author's structured profile (the same PII-free profile shown in
    setup). Returned for the case-page author section. 404 if no profile."""
    import profile
    prof = _guard(lambda: profile.get_profile(_db, uid))
    if not prof:
        raise HTTPException(status_code=404, detail="Profile not found")
    return prof


@app.get("/api/users/{uid}/postings", response_model=AuthorPostingsResponse)
def user_postings(uid: str):
    """All app postings authored by a user (newest first), from the Firestore
    posting↔author link. Used by the case-page 'other postings by this author'."""
    if _db is None:
        return AuthorPostingsResponse(postings=[])
    try:
        docs = list(_db.collection("posting_authors").where("author_uid", "==", uid).stream())
    except Exception as e:  # noqa: BLE001
        print(f"user_postings({uid}): {e}")
        return AuthorPostingsResponse(postings=[])
    rows = [d.to_dict() or {} for d in docs]

    def _created_key(r: dict):
        ts = r.get("created_at")
        return ts.isoformat() if hasattr(ts, "isoformat") else str(ts or "")

    rows.sort(key=_created_key, reverse=True)
    cards = [
        AuthorPostingCard(
            case_id=r.get("case_id", ""),
            title=r.get("title", ""),
            visa=r.get("visa", []) or [],
            consulates=r.get("consulates", []) or [],
            outcome=r.get("outcome", "") or "",
            date=_created_key(r)[:10],
        )
        for r in rows if r.get("case_id")
    ]
    return AuthorPostingsResponse(postings=cards)


@app.get("/api/users/{uid}/replies", response_model=UserRepliesResponse)
def user_replies(uid: str):
    """All replies a user has authored (newest first) — the profile 'your
    activity' section. Each carries the parent posting id for linking."""
    import interactions
    rows = _guard(lambda: interactions.list_user_replies(_db, uid))
    return UserRepliesResponse(replies=[UserReplyCard(**r) for r in rows])


# ---------------------------------------------------------------------------
# Replies + voting (phase-L). Replies/votes live in Firestore (interactions
# store), separate from the datastore-backed posting corpus, so the search feed
# is unaffected. Replying/voting require an active user; reads are anonymous.
# ---------------------------------------------------------------------------

@app.get("/api/postings/{case_id}/replies", response_model=RepliesResponse)
def list_replies_route(case_id: str, request: Request, sort: str = "top"):
    """Flat replies on a posting (each with its vote tally + the viewer's vote),
    plus the posting's own tally. Anonymous-safe (your_vote = 0 with no user)."""
    import interactions
    import moderation
    viewer = _optional_user(request)
    replies = _guard(lambda: interactions.list_replies(_db, case_id, viewer, sort))
    # Drop moderation-hidden replies and those from users the viewer has blocked.
    blocked = moderation.blocked_uids(_db, viewer)
    hidden = moderation.hidden_content_ids(_db, [r["id"] for r in replies])
    replies = [r for r in replies
               if r["id"] not in hidden and (not r.get("author_id") or r["author_id"] not in blocked)]
    posting_tally = _guard(lambda: interactions.vote_state(_db, [case_id], viewer))[case_id]
    return RepliesResponse(
        replies=[ReplyCard(**r) for r in replies],
        posting=VoteTally(**posting_tally),
        total=len(replies),
    )


@app.post("/api/postings/{case_id}/replies", response_model=ReplyCard)
def create_reply_route(case_id: str, body: ReplyCreate, request: Request):
    """Post a reply to a posting (requires an active user)."""
    client_ip = request.client.host if request.client else "unknown"
    if not check_rate_limit(client_ip):
        raise HTTPException(status_code=429, detail="Rate limit exceeded. Try again in a minute.")
    import interactions
    import profile
    uid = _active_user(request)
    handle = profile.username_for(uid)
    try:
        reply = _guard(lambda: interactions.add_reply(
            _db, case_id, body.body, uid, handle, body.parent_reply_id))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return ReplyCard(**reply)


@app.delete("/api/postings/{case_id}/replies/{reply_id}")
def delete_reply_route(case_id: str, reply_id: str, request: Request):
    """Soft-delete one of your own replies (author-only)."""
    import interactions
    uid = _active_user(request)
    try:
        _guard(lambda: interactions.delete_reply(_db, reply_id, uid))
    except KeyError:
        raise HTTPException(status_code=404, detail="Reply not found")
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    return {"ok": True}


@app.post("/api/votes", response_model=VoteResponse)
def cast_vote_route(body: VoteRequest, request: Request):
    """Up/down/clear a vote on a posting or reply (requires an active user).
    `dir` is the desired resulting direction (-1 | 0 | 1); the client toggles."""
    client_ip = request.client.host if request.client else "unknown"
    if not check_rate_limit(client_ip):
        raise HTTPException(status_code=429, detail="Rate limit exceeded. Try again in a minute.")
    import interactions
    uid = _active_user(request)
    res = _guard(lambda: interactions.cast_vote(_db, body.content_id, uid, body.dir))
    return VoteResponse(**res)


# ---------------------------------------------------------------------------
# UGC safety / moderation (App Store Guideline 1.2): report content, block
# abusive users, and an admin takedown/eject path. State lives in Firestore
# (reports/, blocks/, content_meta flags) — see moderation.py.
# ---------------------------------------------------------------------------

@app.post("/api/reports", response_model=ReportResponse)
def report_content_route(body: ReportRequest, request: Request):
    """Flag a posting/reply/message as objectionable. One report per user per
    item; auto-hides the content once enough distinct users report it and emails
    the moderation inbox so a human can act within 24 hours."""
    client_ip = request.client.host if request.client else "unknown"
    if not check_rate_limit(client_ip):
        raise HTTPException(status_code=429, detail="Rate limit exceeded. Try again in a minute.")
    import moderation
    uid = _active_user(request)
    try:
        out = _guard(lambda: moderation.report_content(
            _db, content_id=body.content_id, content_type=body.content_type,
            reporter_uid=uid, reason=body.reason, container_id=body.container_id))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return ReportResponse(**out)


@app.post("/api/blocks", response_model=BlocksResponse)
def block_user_route(body: BlockRequest, request: Request):
    """Block an abusive user. Their content is filtered out of the blocker's feeds
    and the block notifies the moderation inbox."""
    import moderation
    uid = _active_user(request)
    try:
        out = _guard(lambda: moderation.block_user(_db, uid, body.blocked_uid))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return BlocksResponse(**out)


@app.delete("/api/blocks/{blocked_uid}", response_model=BlocksResponse)
def unblock_user_route(blocked_uid: str, request: Request):
    """Remove a user from the caller's block list."""
    import moderation
    uid = _active_user(request)
    out = _guard(lambda: moderation.unblock_user(_db, uid, blocked_uid))
    return BlocksResponse(**out)


@app.get("/api/blocks", response_model=BlocksResponse)
def list_blocks_route(request: Request):
    """The caller's current block list (uids)."""
    import moderation
    uid = _active_user(request)
    return BlocksResponse(ok=True, blocked_uids=sorted(moderation.blocked_uids(_db, uid)))


def _require_admin(request: Request) -> None:
    """Gate admin moderation actions on a shared secret header. 403 unless
    `X-Admin-Token` matches MODERATION_ADMIN_TOKEN (unset ⇒ always 403).
    Timing-safe compare so the token can't be recovered via timing analysis."""
    import secrets as _secrets
    token = os.getenv("MODERATION_ADMIN_TOKEN", "")
    supplied = request.headers.get("x-admin-token", "")
    if not token or not _secrets.compare_digest(supplied, token):
        raise HTTPException(status_code=403, detail="Admin access required.")


@app.post("/api/admin/takedown")
def admin_takedown_route(body: AdminTakedownRequest, request: Request):
    """Human moderation action (24h SLA): remove reported content and optionally
    eject its author by disabling their Firebase account. Admin-token gated."""
    _require_admin(request)
    import moderation
    if _db is None:
        raise HTTPException(status_code=503, detail="Database not available")
    moderation._takedown(_db, body.content_type, body.content_id, body.container_id)
    ejected = ""
    if body.eject_author:
        author = moderation._resolve_author(_db, body.content_type, body.content_id, body.container_id)
        if author and _firebase_ready() and _fb_auth is not None:
            try:
                _fb_auth.update_user(author, disabled=True)
                ejected = author
            except Exception as e:  # noqa: BLE001
                print(f"admin_takedown: eject {author} failed ({e})")
    return {"ok": True, "content_id": body.content_id, "ejected": ejected}


def _require_internal(request: Request) -> None:
    """Gate internal/system-triggered routes (not for any user client) on a
    shared secret header — same pattern as _require_admin(), separate env
    var/header so this route's secret can rotate independently of the
    moderation admin token. 403 unless `X-Internal-Poll-Secret` matches
    GOV_NEWS_POLL_SECRET (unset ⇒ always 403)."""
    import secrets as _secrets
    token = os.getenv("GOV_NEWS_POLL_SECRET", "")
    supplied = request.headers.get("x-internal-poll-secret", "")
    if not token or not _secrets.compare_digest(supplied, token):
        raise HTTPException(status_code=403, detail="Internal access required.")


def _is_internal_request(request: Request) -> bool:
    """Non-raising counterpart to _require_internal(): True when the request
    carries the valid internal secret. Used to grant a trusted server-side
    caller (e.g. the offline curated publish script) a bypass of the UI
    signed-in-user gate, rather than to block. Never logs the secret."""
    import secrets as _secrets
    token = os.getenv("GOV_NEWS_POLL_SECRET", "")
    supplied = request.headers.get("x-internal-poll-secret", "")
    return bool(token) and _secrets.compare_digest(supplied, token)


@app.post("/internal/gov-news/poll")
def gov_news_poll_route(request: Request, source: str = "", dry_run: bool = False):
    """Cloud Scheduler's target (GOV-NEWS-INGESTION-PLAN.md §5) — polls
    registered gov-news sources (backend/news_sources.py) and publishes any
    new/edited items. NOT a public route: gated by _require_internal(), and
    deliberately not something any user client calls. `source` limits the run
    to one registered slug; `dry_run=true` classifies without publishing."""
    _require_internal(request)
    from gov_news_poll import poll_all
    return {"results": poll_all(source_slug=source, dry_run=dry_run)}


@app.post("/internal/official-reference/poll")
def official_reference_poll_route(request: Request, dry_run: bool = False):
    """Cloud Scheduler target — fetch the registered authoritative reference
    pages (backend/official_reference_poll.py SOURCES) and upsert each into DS-1
    (one stable doc per URL; unchanged pages are skipped via the content_hash
    guardrail). NOT public: gated by _require_internal() on the same
    X-Internal-Poll-Secret as the gov-news poll. `dry_run=true` fetches +
    classifies without writing."""
    _require_internal(request)
    from official_reference_poll import poll_all
    return {"results": poll_all(dry_run=dry_run)}


# ---------------------------------------------------------------------------
# Find users in same boat + groups (phase-M). The expert chat builds match
# criteria; criteria are validated against the profile via the existing
# /api/reconcile (and applied via PUT /api/profile). Matching ranks other users'
# Firestore profiles by tag overlap; a group of selected matches is persisted.
# ---------------------------------------------------------------------------

@app.post("/api/find/chat", response_model=FindChatResponse)
def find_chat_route(body: FindChatRequest, request: Request):
    """One expert-chat turn that captures the user's match criteria."""
    client_ip = request.client.host if request.client else "unknown"
    if not check_rate_limit(client_ip):
        raise HTTPException(status_code=429, detail="Rate limit exceeded. Try again in a minute.")
    import matching
    _active_user(request)
    out = _guard(lambda: matching.find_turn(body.messages, body.draft.model_dump()))
    return FindChatResponse(**out)


@app.post("/api/find/matches", response_model=MatchesResponse)
def find_matches_route(body: MatchesRequest, request: Request):
    """Rank other users by similarity to the criteria (excludes the caller)."""
    import matching
    uid = _active_user(request)
    matches = _guard(lambda: matching.find_matches(_db, uid, body.criteria.model_dump()))
    return MatchesResponse(matches=[MatchCard(**m) for m in matches], total=len(matches))


@app.post("/api/groups/{group_id}/find-candidates", response_model=MatchesResponse)
def find_candidates_route(group_id: str, request: Request):
    """Rank candidate users against an EXISTING group's own criteria — the
    relocated counterpart of the old top-level chat-based matching flow,
    now scoped to a specific group and reachable only by its members."""
    import matching
    uid = _active_user(request)
    try:
        group = _guard(lambda: matching.get_group(_db, group_id))
    except KeyError:
        raise HTTPException(status_code=404, detail="Group not found")
    member_ids = {m.get("user_id") for m in (group.get("members") or [])}
    if uid not in member_ids:
        raise HTTPException(status_code=403, detail="Only group members can find candidates.")
    # Exclusions are passed INTO find_matches so its top_n caps the eligible
    # pool. Filtering after the fact (as this route used to) meant a group
    # with more members than top_n could return almost nothing. Pending
    # invitees are excluded too, so we stop re-offering someone who already
    # has an outstanding invitation.
    exclude = member_ids | _guard(lambda: matching.pending_invitee_ids(_db, group_id))
    matches = _guard(lambda: matching.find_matches(
        _db, uid, group.get("criteria_tags") or {}, exclude_ids=exclude))
    return MatchesResponse(matches=[MatchCard(**m) for m in matches], total=len(matches))


@app.post("/api/groups/{group_id}/add-members", response_model=InviteBatchResponse)
def add_members_route(group_id: str, body: AddMembersRequest, request: Request):
    """A current member INVITES one or more found candidates — the "Find
    candidates" counterpart to /invite (which invites by typed handle). They
    become members only once they accept, so `group.members` is unchanged
    here. Per-candidate problems come back in `skipped` rather than failing
    the batch."""
    import matching
    uid = _active_user(request)
    try:
        r = _guard(lambda: matching.add_members(_db, group_id, uid, body.user_ids))
    except KeyError:
        raise HTTPException(status_code=404, detail="Group not found")
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return InviteBatchResponse(
        group=GroupCard(**r["group"]),
        invited=[InvitationCard(**i) for i in r["invited"]],
        skipped=[SkippedInvite(**s) for s in r["skipped"]],
    )


@app.post("/api/groups", response_model=GroupCard)
def create_group_route(body: GroupCreate, request: Request):
    """Join the existing group for this criteria signature, or create it. Only
    the acting user becomes a member — any selected peers are INVITED and
    appear in `invited`. `joined`=true on join."""
    import matching
    uid = _active_user(request)
    try:
        g = _guard(lambda: matching.find_or_create_group(
            _db, uid, body.criteria_text, body.criteria.model_dump(),
            [m.model_dump() for m in body.members], body.group_type, body.description, body.validity,
            body.values, body.notes))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    g["needs_attributes"] = matching.compute_needs_attributes(_db, g["group_id"], g, uid)
    return GroupCard(**g)


@app.post("/api/groups/search", response_model=GroupsResponse)
def search_groups_route(body: GroupSearchRequest):
    """Search existing groups by criteria — the group-search counterpart to
    Advanced Search's posting search. Public, like Advanced Search itself;
    joining/creating still requires auth."""
    import matching
    groups = _guard(lambda: matching.search_groups(
        _db, body.criteria.model_dump(), body.group_type, body.precision, body.max_age_days))
    return GroupsResponse(groups=[GroupCard(**g) for g in groups])


# Must stay ABOVE GET /api/groups/{group_id} — same reason /all and /search
# do: a literal segment declared after the dynamic one is swallowed as an id.
@app.post("/api/groups/preview", response_model=GroupPreview)
def preview_group_route(body: GroupSearchRequest):
    """The name and description a group WOULD get for these criteria, without
    creating anything. Public, like /search.

    Exists so the create screen can show the generated name before you commit
    to it. The name has to come from the server: Timeline dedup is name-based,
    so a client that computed its own would eventually disagree with the one
    that decides whether you get a new group or join an existing one."""
    import matching
    preview = _guard(lambda: matching.preview_timeline_group(
        body.criteria.model_dump(), body.group_type))
    return GroupPreview(**preview)


@app.get("/api/groups", response_model=GroupsResponse)
def list_groups_route(request: Request):
    """The groups the active user is a member of (newest first)."""
    import matching
    uid = _active_user(request)
    groups = _guard(lambda: matching.my_groups(_db, uid))
    return GroupsResponse(groups=[GroupCard(**g) for g in groups])


@app.get("/api/groups/all", response_model=GroupsResponse)
def list_all_groups_route(request: Request):
    """All groups (browse), flagged with the viewer's membership and with
    `is_invited` for groups they have a pending invitation to."""
    import matching
    uid = _active_user(request)
    groups = _guard(lambda: matching.list_all_groups(_db, uid))
    return GroupsResponse(groups=[GroupCard(**g) for g in groups])


@app.get("/api/groups/invitations", response_model=PendingInvitationsResponse)
def my_invitations_route(request: Request):
    """Every pending invitation addressed to the active user, across all
    groups — the "Pending invitations" section on the Groups tab. Each entry
    carries the live group card alongside the invitation.

    MUST stay declared above GET /api/groups/{group_id} (further down this
    file) or "invitations" is captured as a group_id and this 404s."""
    import matching
    uid = _active_user(request)
    rows = _guard(lambda: matching.list_pending_invitations_for_user(_db, uid))
    return PendingInvitationsResponse(
        invitations=[PendingInvitation(invitation=InvitationCard(**r["invitation"]),
                                       group=GroupCard(**r["group"])) for r in rows],
        total=len(rows),
    )


@app.post("/api/groups/{group_id}/join", response_model=GroupCard)
def join_group_route(group_id: str, request: Request, body: JoinGroupBody = JoinGroupBody()):
    """Join an existing group directly (browse → join). `values`/`notes` are
    required if the group is a Timeline group with a registered post-join
    attribute template and the user hasn't already submitted them (422 if
    the required field is missing — see matching.join_group)."""
    import matching
    uid = _active_user(request)
    try:
        g = _guard(lambda: matching.join_group(_db, group_id, uid, body.values, body.notes))
    except KeyError:
        raise HTTPException(status_code=404, detail="Group not found")
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    g["needs_attributes"] = matching.compute_needs_attributes(_db, group_id, g, uid)
    return GroupCard(**g)


@app.post("/api/groups/{group_id}/archive", response_model=GroupCard)
def archive_group_route(group_id: str, body: GroupArchiveUpdate, request: Request):
    """Admin-only archive/unarchive toggle."""
    import matching
    uid = _active_user(request)
    try:
        g = _guard(lambda: matching.archive_group(_db, group_id, uid, body.archived))
    except KeyError:
        raise HTTPException(status_code=404, detail="Group not found")
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return GroupCard(**g)


@app.post("/api/groups/{group_id}/leave", response_model=GroupCard)
def leave_group_route(group_id: str, request: Request):
    """Leave a group. Reassigns admin to the next member if the creator leaves."""
    import matching
    uid = _active_user(request)
    try:
        g = _guard(lambda: matching.leave_group(_db, group_id, uid))
    except KeyError:
        raise HTTPException(status_code=404, detail="Group not found")
    return GroupCard(**g)


@app.put("/api/groups/{group_id}", response_model=GroupCard)
def rename_group_route(group_id: str, body: GroupUpdate, request: Request):
    """Rename and/or re-describe a group. Creator-only."""
    import matching
    uid = _active_user(request)
    try:
        g = _guard(lambda: matching.rename_group(_db, group_id, uid, body.name, body.description))
    except KeyError:
        raise HTTPException(status_code=404, detail="Group not found")
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return GroupCard(**g)


@app.post("/api/groups/{group_id}/invite", response_model=InvitationCard)
def invite_member_route(group_id: str, body: GroupInvite, request: Request):
    """A current member INVITES someone they know by handle. Returns the
    invitation, not a group card — the group is unchanged until the invitee
    accepts, and returning a group card here would render a member who isn't
    one yet."""
    import matching
    uid = _active_user(request)
    try:
        inv = _guard(lambda: matching.invite_member(_db, group_id, uid, body.handle))
    except KeyError:
        raise HTTPException(status_code=404, detail="Group not found")
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return InvitationCard(**inv)


@app.get("/api/groups/{group_id}/invitations", response_model=InvitationsResponse)
def group_invitations_route(group_id: str, request: Request):
    """Pending invitations for one group. Members-only — any member can see
    them because any member can invite."""
    import matching
    uid = _active_user(request)
    try:
        rows = _guard(lambda: matching.list_pending_invitations_for_group(_db, group_id, uid))
    except KeyError:
        raise HTTPException(status_code=404, detail="Group not found")
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    return InvitationsResponse(invitations=[InvitationCard(**i) for i in rows], total=len(rows))


@app.post("/api/groups/{group_id}/invitations/accept", response_model=GroupCard)
def accept_invitation_route(group_id: str, request: Request, body: JoinGroupBody = JoinGroupBody()):
    """Accept a pending invitation and become a member. Runs the same
    post-join attribute gate as /join — if this is a Timeline group with a
    registered template, the required field must be in `values` (422
    otherwise, and the invitation stays pending so it can be retried)."""
    import matching
    uid = _active_user(request)
    try:
        g = _guard(lambda: matching.accept_invitation(_db, group_id, uid, body.values, body.notes))
    except KeyError:
        raise HTTPException(status_code=404, detail="Invitation not found")
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    g["needs_attributes"] = matching.compute_needs_attributes(_db, group_id, g, uid)
    return GroupCard(**g)


@app.post("/api/groups/{group_id}/invitations/decline", response_model=InvitationCard)
def decline_invitation_route(group_id: str, request: Request):
    """Decline a pending invitation. Never touches the group's members — the
    invitee was never one."""
    import matching
    uid = _active_user(request)
    try:
        inv = _guard(lambda: matching.decline_invitation(_db, group_id, uid))
    except KeyError:
        raise HTTPException(status_code=404, detail="Invitation not found")
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return InvitationCard(**inv)


@app.delete("/api/groups/{group_id}")
def delete_group_route(group_id: str, request: Request):
    """Soft-delete a group (status="deleted", hidden from every list/lookup
    from then on; data retained). Creator-only."""
    import matching
    uid = _active_user(request)
    try:
        _guard(lambda: matching.delete_group(_db, group_id, uid))
    except KeyError:
        raise HTTPException(status_code=404, detail="Group not found")
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    return {"ok": True}


# ---------------------------------------------------------------------------
# Group chat (phase-N). Members-only messages in Firestore groups/{id}/messages
# (app-state, never the datastore). v1 real-time = client polling with `since`.
# Declared AFTER /api/groups/all so the literal route wins over {group_id}.
# ---------------------------------------------------------------------------

@app.get("/api/groups/{group_id}", response_model=GroupCard)
def get_group_route(group_id: str, request: Request):
    """One group (name, members, is_member) for the group detail / chat page."""
    import matching
    uid = _active_user(request)
    g = next((x for x in _guard(lambda: matching.list_all_groups(_db, uid))
              if x["group_id"] == group_id), None)
    if g is None:
        raise HTTPException(status_code=404, detail="Group not found")
    g["needs_attributes"] = matching.compute_needs_attributes(_db, group_id, g, uid)
    return GroupCard(**g)


@app.post("/api/groups/{group_id}/attributes", response_model=GroupCard)
def save_member_attributes_route(group_id: str, body: MemberAttributesUpdate, request: Request):
    """A current member submits (or updates) their post-join attributes —
    the mandatory-gate fill-in path for a member added via invite (who
    never went through /join), or anyone revisiting to complete it."""
    import matching
    uid = _active_user(request)
    try:
        g = _guard(lambda: matching.save_member_attributes(_db, group_id, uid, body.values, body.notes))
    except KeyError:
        raise HTTPException(status_code=404, detail="Group not found")
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    g["needs_attributes"] = matching.compute_needs_attributes(_db, group_id, g, uid)
    return GroupCard(**g)


@app.get("/api/groups/{group_id}/attributes")
def list_member_attributes_route(group_id: str, request: Request):
    """Members-only — every member's submitted post-join attributes, shared
    with the whole group (not just the submitter)."""
    import matching
    uid = _active_user(request)
    try:
        attrs = _guard(lambda: matching.list_member_attributes(_db, group_id, uid))
    except KeyError:
        raise HTTPException(status_code=404, detail="Group not found")
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    return {"attributes": attrs}


@app.get("/api/groups/{group_id}/messages", response_model=MessagesResponse)
def list_messages_route(group_id: str, request: Request, since: str = "", limit: int = 200):
    """Members-only message list (polled). `since` = an ISO created_at cursor → only newer."""
    import group_messages
    import moderation
    uid = _active_user(request)
    try:
        msgs = _guard(lambda: group_messages.list_messages(_db, group_id, uid, since, limit))
    except KeyError:
        raise HTTPException(status_code=404, detail="Group not found")
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    # Hide messages from users the viewer has blocked (App Store Guideline 1.2).
    blocked = moderation.blocked_uids(_db, uid)
    if blocked:
        msgs = [m for m in msgs if not m.get("author_id") or m["author_id"] not in blocked]
    return MessagesResponse(messages=[MessageCard(**m) for m in msgs], total=len(msgs))


@app.post("/api/groups/{group_id}/messages", response_model=MessageCard)
def post_message_route(group_id: str, body: MessageCreate, request: Request):
    """Post a message to a group (members only; PII-scrubbed)."""
    client_ip = request.client.host if request.client else "unknown"
    if not check_rate_limit(client_ip):
        raise HTTPException(status_code=429, detail="Rate limit exceeded. Try again in a minute.")
    import group_messages
    uid = _active_user(request)
    try:
        msg = _guard(lambda: group_messages.post_message(_db, group_id, uid, body.text))
    except KeyError:
        raise HTTPException(status_code=404, detail="Group not found")
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return MessageCard(**msg)


@app.delete("/api/groups/{group_id}/messages/{message_id}")
def delete_message_route(group_id: str, message_id: str, request: Request):
    """Soft-delete one of your own messages (author-only)."""
    import group_messages
    uid = _active_user(request)
    try:
        _guard(lambda: group_messages.delete_message(_db, group_id, message_id, uid))
    except KeyError:
        raise HTTPException(status_code=404, detail="Message not found")
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    return {"ok": True}


@app.get("/api/health", response_model=HealthResponse)
def health_check():
    """Health check endpoint.

    `chunks_loaded` is retained for client compatibility; it now reports
    grounding readiness (1 = Search/Answer engine configured) since chunks are
    no longer preloaded (grounding is served by the managed datastore).
    """
    return HealthResponse(
        status="ok",
        chunks_loaded=1 if _engine_id else 0,
    )
