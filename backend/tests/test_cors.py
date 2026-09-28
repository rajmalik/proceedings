#!/usr/bin/env python3
"""No-GCP test pinning the API's CORS allow-list (backend/api.py).

Reads the CORSMiddleware config registered on `api.app` and asks Starlette's
own CORSMiddleware.is_allowed_origin() — so this tests the real policy, with no
server, no httpx/TestClient and no app startup (lifespan never runs).

Why: the frontend moved from Vercel to Cloud Run (docs/DEPLOYMENT.md) and the
old `https://*.vercel.app` wildcard admitted ANY site on vercel.app. It was
removed; this guards against it (or any other wildcard) creeping back.

Run:  python tests/test_cors.py      (wired into the CI gate)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from starlette.middleware.cors import CORSMiddleware  # noqa: E402

import api  # noqa: E402

_passed = 0
_failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global _passed, _failed
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""))
    if ok:
        _passed += 1
    else:
        _failed += 1


def main() -> None:
    print("== test_cors ==")
    mws = [m for m in api.app.user_middleware if m.cls is CORSMiddleware]
    check("C1 exactly one CORSMiddleware registered", len(mws) == 1, str(len(mws)))
    kw = mws[0].kwargs
    cors = CORSMiddleware(app=lambda *a: None, **kw)

    for origin in ("https://meridianjourney.ai", "https://www.meridianjourney.ai", "http://localhost:3000"):
        check(f"C2 allowed: {origin}", cors.is_allowed_origin(origin))
    for origin in ("https://proceedings.vercel.app", "https://attacker.vercel.app",
                   "https://proceedings-git-main-krishes.vercel.app",
                   "https://meridianjourney.ai.evil.com", "http://meridianjourney.ai", "null", "https://evil.com"):
        check(f"C3 rejected: {origin}", not cors.is_allowed_origin(origin))
    check("C4 no origin regex / wildcard at all", not kw.get("allow_origin_regex") and "*" not in kw.get("allow_origins", []),
          str(kw.get("allow_origin_regex")))
    check("C5 credentials not enabled cross-origin", not kw.get("allow_credentials", False))

    print(f"\nSUMMARY: {_passed}/{_passed + _failed} checks passed")
    sys.exit(1 if _failed else 0)


if __name__ == "__main__":
    main()
