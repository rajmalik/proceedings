#!/usr/bin/env python3
"""SPIKE — Option B: Gemini "Grounding with Google Search" for the uscis.gov long
tail (questions not covered by our curated DS-1 grounding).

Calls Gemini with the google_search tool, prompted to answer only from
authoritative U.S. government sources, and returns the answer + the web citations
from grounding metadata. NOT wired into the app — a measurement spike.

  python scripts/spike_web_search_grounding.py "How long is naturalization taking?"
  python scripts/spike_web_search_grounding.py            # runs a default battery

Env: GCP_PROJECT_ID / GCP_REGION (+ ADC). Model via GCP_GEMINI_ASSIST_MODEL.
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # backend/ on path

from google.genai import types as t  # noqa: E402
import posting  # noqa: E402

_MODEL = os.getenv("GCP_GEMINI_ASSIST_MODEL", "gemini-2.5-flash")

_PROMPT = (
    "You are a concise U.S. immigration assistant. Answer the question directly and briefly, "
    "using ONLY authoritative official U.S. government sources (prefer uscis.gov, travel.state.gov, "
    "dhs.gov). If those sources don't cover it, say you don't have that information. "
    "Question: {q}"
)


def _tool():
    # Newer models: Tool(google_search=GoogleSearch()); fall back to the 1.5-era
    # GoogleSearchRetrieval if the SDK/model wants that shape.
    try:
        return t.Tool(google_search=t.GoogleSearch())
    except Exception:
        return t.Tool(google_search_retrieval=t.GoogleSearchRetrieval())


def web_search_answer(question: str) -> dict:
    client = posting.genai_client()
    resp = client.models.generate_content(
        model=_MODEL,
        contents=_PROMPT.format(q=question),
        config=t.GenerateContentConfig(tools=[_tool()], temperature=0.1, max_output_tokens=1024),
    )
    answer = (resp.text or "").strip()
    citations, entry = [], ""
    try:
        gm = resp.candidates[0].grounding_metadata
        for ch in (gm.grounding_chunks or []):
            if ch.web and ch.web.uri:
                citations.append({"title": ch.web.title or "", "uri": ch.web.uri})
        if gm.search_entry_point and gm.search_entry_point.rendered_content:
            entry = "present"  # the Google "Search Suggestions" chips (must be shown in UI)
    except Exception as e:  # noqa: BLE001
        print(f"  (no grounding metadata: {type(e).__name__}: {e})")
    return {"answer": answer, "citations": citations, "search_entry_point": entry}


def _run(q: str) -> None:
    print(f"\n=== Q: {q} ===")
    r = web_search_answer(q)
    print("answer:", r["answer"][:400])
    uscis = [c for c in r["citations"] if "uscis.gov" in c["uri"] or "uscis" in (c.get("title") or "").lower()]
    print(f"citations: {len(r['citations'])} (uscis-ish: {len(uscis)}) | search-entry-point: {r['search_entry_point'] or 'none'}")
    for c in r["citations"][:6]:
        print(f"    - {c['uri'][:90]}  ({c['title'][:50]})")


if __name__ == "__main__":
    if len(sys.argv) > 1:
        _run(sys.argv[1])
    else:
        for q in [
            "What are the eligibility requirements for naturalization (US citizenship)?",
            "What is the H-1B cap-gap and who qualifies for it?",
            "How do I apply for asylum in the United States?",
            "What is a re-entry permit and how do I get one?",
            "How long is naturalization currently taking to process?",
        ]:
            _run(q)
