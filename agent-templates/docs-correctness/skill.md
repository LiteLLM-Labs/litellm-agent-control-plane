---
name: checking-docs-correctness
description: Audits all Markdown files in a repository for internal inconsistencies, contradictions, stale CLI commands/flags, and broken cross-references. Returns a structured findings report. Use when asked to check, audit, or verify docs for correctness or consistency.
---

## Docs correctness audit

Copy this checklist and track progress:

```
- [ ] 1. Discover all .md files
- [ ] 2. Extract commands, flags, and API references
- [ ] 3. Cross-reference for contradictions
- [ ] 4. Check internal cross-references and links
- [ ] 5. Identify stale or unreachable content
- [ ] 6. Output findings
```

### Step 1 — Discover all .md files

```bash
find . -name "*.md" -not -path "*/node_modules/*" -not -path "*/.git/*" | sort
```

Group files by area (e.g. `docs/`, `cli/`, root-level README). Note which files claim to document the same feature — those are the highest-risk pairs for contradiction.

### Step 2 — Extract commands, flags, and API references

For each .md file, extract:
- CLI commands (lines containing backtick-wrapped commands or code blocks with shell commands)
- Flag/option names (`--flag`, `-f`)
- API endpoint paths (`/api/v1/...`)
- Version numbers and model names
- Environment variable names

```bash
grep -rn '`[a-z]' --include="*.md" . | grep -v node_modules
grep -rn -- '--[a-z]' --include="*.md" . | grep -v node_modules
grep -rn '/api/v[0-9]' --include="*.md" . | grep -v node_modules
```

Build a map: `symbol → [file:line, ...]` for every extracted term.

### Step 3 — Cross-reference for contradictions

For each symbol that appears in 2+ files, compare the usage:
- Same command, different flags documented?
- Same flag, different behavior described?
- Same API path, different request/response shape?
- Same env var, different name or default?

Flag any mismatch as a finding. Quote both conflicting lines verbatim.

### Step 4 — Check internal cross-references and links

```bash
grep -rn '\[.*\](.*\.md' --include="*.md" . | grep -v node_modules
```

For each internal link `[text](path.md)` or `[text](path.md#anchor)`:
- Verify the target file exists
- If an `#anchor` is specified, verify the heading exists in that file

### Step 5 — Identify stale content

Look for:
- Commands or flags present in docs but absent from the actual codebase source (grep the source)
- Model names or versions that have been superseded
- Setup steps referencing files or paths that no longer exist
- "Coming soon" or TODO markers that have since shipped

### Step 6 — Output

```json
{
  "summary": "<N> critical, <N> high, <N> medium, <N> low",
  "findings": [
    {
      "severity": "critical|high|medium|low",
      "type": "contradiction|stale|broken-link|missing-content|style",
      "files": ["path/to/file-a.md:14", "path/to/file-b.md:32"],
      "description": "Specific inconsistency description.",
      "quote_a": "Exact line from file-a",
      "quote_b": "Exact line from file-b (if contradiction)"
    }
  ],
  "recommendation": "Docs need updates before next release / Minor cleanup only / Docs are consistent"
}
```

**Rules:** Never edit docs unless explicitly asked. Report only. If no issues found, state explicitly with confidence level.
