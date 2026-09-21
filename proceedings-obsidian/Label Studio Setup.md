# Label Studio Setup

**Stage:** 2 — Labeling (manual)
**Location:** `/label_studio_setup.md`

---

## Purpose

Documents how to deploy Label Studio on a GCP VM and configure it to label crawled Markdown files from the `law-firm-knowledge-base` bucket.

---

## Infrastructure

| Component | Detail |
|-----------|--------|
| VM | `e2-medium` (2 vCPU, 4 GB RAM), Ubuntu 22.04 |
| Zone | `us-central1-a` |
| Port | 8080 (firewall rule: `allow-label-studio`) |
| Install | Python venv + `pip install label-studio` |

---

## Storage Configuration

| Type | Bucket | Prefix | Purpose |
|------|--------|--------|---------|
| Source | `law-firm-knowledge-base` | *(root)* | Reads crawled `.md` files |
| Target | `law-firm-knowledge-base` | `labeled/` | Exports annotations as JSON |

Both use a service account key (`label-studio-sa`) with `storage.objectAdmin` role.

---

## Labeling Template

```xml
<View>
  <Header value="Classify this legal content chunk:" />
  <Text name="text" value="$text" />
  <Choices name="category" toName="text" choice="multiple">
    <Choice value="visa-info" />
    <Choice value="eligibility" />
    <Choice value="process" />
    <Choice value="fees" />
    <Choice value="timeline" />
    <Choice value="other" />
  </Choices>
</View>
```

Multi-label classification — a single chunk can have more than one label.

---

> **Retired.** This workflow belongs to the archived Firecrawl → self-managed
> Vector Search prototype (now under `legacy/`). It is kept for historical
> reference only; the live system grounds on the managed Vertex AI Search
> datastore — see [[Proceedings — Project Overview]].

## Workflow

1. `legacy/crawler.py` populates the GCS bucket with `.md` files
2. Sync Source Storage in Label Studio to import tasks
3. Label tasks manually (or use `legacy/auto_label.py`)
4. Sync Target Storage to export annotations to `gs://bucket/labeled/`
5. `legacy/` indexing scripts read from `/labeled/` to build the vector index

---

## Running as Background Service

Can be set up as a `systemd` service for persistence after SSH disconnect.
