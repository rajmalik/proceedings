"""
test_packaging.py — the Docker image actually contains what the app imports.

WHY THIS EXISTS
---------------
backend/Dockerfile copies an explicit ALLOWLIST of modules rather than the
whole directory. That is a reasonable choice (nothing unexpected ships), but
it has one failure mode and it is nasty: a new module is invisible until
something imports it at runtime.

That is not hypothetical. `attribute_config.py` was added, wired into
posting._spec() as a LAZY import, and left out of the Dockerfile. Every local
test passed. The container would have started cleanly, served health checks,
and then ImportError'd on the first /api/tag-vocab request — the endpoint the
post composer and the find page both depend on. Nothing before this file
would have caught it.

These are static checks: the Dockerfile is parsed as text and compared against
the import graph. No Docker build required, so it runs in the same
no-credentials gate as everything else.

Run:  .venv/bin/python tests/test_packaging.py
"""

import ast
import os
import re
import sys

_BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _BACKEND)

_results: list[tuple[str, bool]] = []


def check(name: str, passed: bool, detail: str = "") -> None:
    _results.append((name, passed))
    print(f"  [{'PASS' if passed else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))


def dockerfile() -> str:
    with open(os.path.join(_BACKEND, "Dockerfile")) as fh:
        return fh.read()


def copied_paths() -> set[str]:
    """Every path named on a COPY line (the destination is dropped)."""
    out: set[str] = set()
    for line in dockerfile().splitlines():
        line = line.strip()
        if not line.upper().startswith("COPY "):
            continue
        parts = line.split()[1:]
        out.update(parts[:-1])  # last token is the destination
    return out


def local_modules() -> set[str]:
    """Top-level .py files in backend/ — the set a COPY line could name."""
    return {f[:-3] for f in os.listdir(_BACKEND)
            if f.endswith(".py") and os.path.isfile(os.path.join(_BACKEND, f))}


def imports_of(path: str) -> set[str]:
    """Every module imported anywhere in `path`, including inside functions —
    the lazy `import attribute_config` that caused this is exactly that."""
    with open(path) as fh:
        tree = ast.parse(fh.read())
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            found.add(node.module.split(".")[0])
    return found


def reachable_local_modules() -> set[str]:
    """Local modules reachable from api.py, transitively."""
    local = local_modules()
    seen: set[str] = set()
    queue = ["api"]
    while queue:
        mod = queue.pop()
        if mod in seen:
            continue
        seen.add(mod)
        path = os.path.join(_BACKEND, f"{mod}.py")
        if not os.path.exists(path):
            continue
        for dep in imports_of(path) & local:
            if dep not in seen:
                queue.append(dep)
    return seen


def main() -> int:
    print("\nP — the image contains what the app imports")
    copied = copied_paths()
    reachable = reachable_local_modules()

    missing = sorted(m for m in reachable if f"{m}.py" not in copied)
    check("P1 every module reachable from api.py is COPYed into the image",
          not missing, f"missing from Dockerfile: {missing}")

    # The reverse: a COPY naming a file that no longer exists breaks the build
    # outright, which is louder but still worth catching before a deploy.
    ghosts = sorted(p for p in copied
                    if p.endswith(".py") and not os.path.exists(os.path.join(_BACKEND, p)))
    check("P2 the Dockerfile names no module that has been deleted",
          not ghosts, f"stale COPY entries: {ghosts}")

    # Data the code reads at runtime. A missing directory here fails the same
    # silent way a missing module does.
    for needed, why in (("tags-cleaned/", "the controlled vocabulary CSVs"),
                        ("config/", "the Timeline attribute base config"),
                        ("seed_users.json", "the demo roster")):
        check(f"P3 {needed} ships — {why}",
              needed in copied, f"COPY lines: {sorted(copied)}")

    # The base config has to be present AND parseable inside the image; a
    # truncated or invalid file degrades Timeline groups to empty dropdowns.
    import json
    base = os.path.join(_BACKEND, "config", "timeline_attributes.default.json")
    check("P4 the base config file exists at the path posting.py loads",
          os.path.exists(base), base)
    if os.path.exists(base):
        try:
            with open(base) as fh:
                spec = json.load(fh)
            ok = isinstance(spec, dict)
        except Exception as e:
            spec, ok = None, False
            check("P5 the base config is valid JSON", False, f"{type(e).__name__}: {e}")
        if ok:
            check("P5 the base config is valid JSON", True)
            import attribute_config
            errs = attribute_config.validate(spec)
            check("P6 the base config passes the same validation as a published one",
                  errs == [], str(errs[:3]))
            import posting
            check("P7 posting.DEFAULT_ATTRIBUTE_SPEC is that file, not a Python literal",
                  posting.DEFAULT_ATTRIBUTE_SPEC.get("processing_types")
                  == spec.get("processing_types"))

    passed = sum(1 for _, ok in _results if ok)
    print("\n" + "=" * 60)
    print(f"SUMMARY: {passed}/{len(_results)} checks passed")
    failed = [n for n, ok in _results if not ok]
    if failed:
        print("FAILED: " + "; ".join(failed))
        return 1
    print("All packaging checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
