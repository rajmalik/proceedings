# CLAUDE.md

This file guides Claude Code when working inside the **`proceedings-obsidian/`** documentation vault.

## What this vault is

An Obsidian vault of analysis notes for the Proceedings codebase (a RAG immigration-intake assistant). Each note documents one file or area of the project — backend modules, the mobile app, the website, infrastructure, the tag taxonomy, and business documents. It is documentation only; there is no build system or tests here.

Start at [[Welcome]] (the map of content) or [[Proceedings — Project Overview]].

## How the vault is organized

| Group | Notes |
|---|---|
| Backend modules | `api.py.md`, `search_client.py.md`, `query.py.md`, `posting.py.md`, `profile.py.md`, `reconcile.py.md`, `matching.py.md`, `interactions.py.md`, `group_messages.py.md`, `moderation.py.md` |
| Frontends | `Mobile App.md`, `Design System.md`, `Website.md` |
| Infrastructure | `Deployment.md`, `GCP Setup.md`, `Environment Setup.md`, `Docs Map.md` |
| Taxonomy & tagging | `us_immigration_tag_specification.md`, `JSON-SCHEMA-FIELD-DICTIONARY.md`, `LLM-EXTRACTION-PROMPT.md`, `TAGGING-EVALUATION.md`, `posting-specs.md` |
| Business | `Business Documents.md`, `Data Intake Checklist.md`, `Launch Requirements.md`, `Pilot Offer.md` |
| Data | `postings-examples/case-N/` — 72 tagged candidate postings (`.md` raw + `.json` metadata) |

## Conventions for notes

- First line is `# <title>` (for a source-file note, the filename, e.g. `# search_client.py`).
- Follow with a bold metadata block (**Type:**, **Location:**, **Stack:**, **Deployed:** as relevant), then `---`-separated sections: **Purpose**, tables (Endpoints / Key functions / Pages / Components), **Key Details**, **Dependencies**, **Related**.
- Cross-link with `[[wikilinks]]` using the exact note titles above.
- Keep notes accurate to the current source. The **live** backend is `backend/` grounded on the managed **Vertex AI Search (Discovery Engine)** datastore. The old Firecrawl → self-managed Vector Search pipeline is **retired** under `legacy/` — do not describe it as live, and do not re-add per-script notes for it.

## Keeping the vault current

When a source file changes materially, update its note (and any tables in [[Proceedings — Project Overview]] / [[Welcome]] that reference it). When a new backend module, screen area, or docs section is added, create a matching note and link it from [[Welcome]].
