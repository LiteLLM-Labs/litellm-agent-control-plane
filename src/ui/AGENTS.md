# UI Agent Guidelines

Every agent building UI in this repo MUST read `design.md` first. It is the source of truth for tokens, components, and layout patterns. This file adds the decision-making layer: when to use what, what to never do, and how to verify your work before committing.

---

## 1. Before You Write a Single Line

Run this checklist mentally before opening a file:

- [ ] Does the page already exist? Check `src/app/` first. Extend; don't duplicate.
- [ ] Does a component for this pattern already exist? Check `src/components/` and `src/components/ui/`. Reuse before creating.
- [ ] Which design tokens apply? Open `design.md` §Tokens. Never reach for a hex value.
- [ ] What are the loading, empty, and error states? You must design all three before writing the happy path.

---

## 2. Decision Trees

### "What component do I use for this UI element?"

```
Interactive element?
├── Triggers an action → <Button> (import from @/components/ui/button)
│   ├── Primary action (Create, Save, Connect) → default variant
│   ├── Secondary / cancel → variant="outline"
│   ├── Destructive (Delete, Disconnect, Remove) → variant="destructive"
│   └── Icon only → variant="ghost" size="icon" WITH aria-label — never omit
├── Navigates somewhere → <Button onClick={() => router.push(...)}> or <a>
│   └── External link → <a href target="_blank" rel="noreferrer">
└── Toggles/expands → <button> with focus-visible:ring-2 focus-visible:ring-ring/50 OR Button variant="ghost"

Text input?
├── Single line → <Input> with <Label htmlFor="..."> — always paired
├── Multi-line → <Textarea className="resize-none">
├── Password / secret → type="password" with show/hide toggle button (aria-label required)
└── Errors go BELOW the field as <p className="text-xs text-destructive">

Displaying data?
├── List of items (agents, sessions, keys) → border div pattern (not Card unless you need header/footer slots)
│   └── <div className="border border-border rounded-lg p-4 bg-card">
├── Tabular data → <Table> from @/components/ui/table inside border+rounded wrapper
├── Status → status dot + text OR Badge — never colored text alone, never emoji
├── Code / IDs / paths / keys → <span className="font-mono text-xs">
└── Long text that might overflow → add truncate, line-clamp-*, or break-words

Container?
├── Elevated surface → <Card> OR <div className="border border-border rounded-lg p-4 bg-card">
├── Secondary background → bg-muted
└── Page background → bg-background (never hardcode, never bg-white)
```

### "How do I handle state?"

```
Data loading?
└── Show skeleton loader — NOT a spinner, NOT blank, NOT "Loading..."
    <div className="flex flex-col gap-3">
      {[...Array(3)].map((_, i) => (
        <div key={i} className="border border-border rounded-lg p-4 flex flex-col gap-2">
          <div className="h-4 w-1/3 bg-muted rounded animate-pulse motion-reduce:animate-none" />
          <div className="h-3 w-2/3 bg-muted rounded animate-pulse motion-reduce:animate-none" />
        </div>
      ))}
    </div>

Data empty?
└── Show empty state — NOT blank, NOT just text
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <SomeIcon className="size-10 text-muted-foreground/40" />
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">Nothing here yet</p>
        <p className="text-xs text-muted-foreground">Explain what will appear here.</p>
      </div>
      <Button size="sm" onClick={onAction}>Primary action</Button>
    </div>

API error?
└── Show inline error — NOT toast, NOT console.error silently dropped
    <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
      {error}
    </div>

Form validation error?
└── Inline below the field — NOT toast
    <p className="text-xs text-destructive">{fieldError}</p>
    Focus the first errored field on submit.

Destructive action (delete, disconnect, revoke)?
└── Confirm dialog — NOT window.confirm(), NOT immediate on click
    <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete [thing]</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Delete <span className="font-medium text-foreground">"{name}"</span>? This cannot be undone.
        </p>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={() => setConfirmOpen(false)}>Cancel</Button>
          <Button variant="destructive" size="sm" onClick={handleConfirm}>Delete</Button>
        </div>
      </DialogContent>
    </Dialog>

Async button action?
└── Disable on submit, show inline spinner, re-enable on error
    <Button onClick={handleSave} disabled={saving}>
      {saving && <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />}
      {saving ? "Saving…" : "Save"}
    </Button>
    Rule: spinner disappears after success (navigate away or re-enable). Never leave a stuck spinner.
```

---

## 3. Non-Negotiable Rules

Break these and the PR fails review. No exceptions.

### Colors
- **Zero hex values** in JSX className strings. `#ffffff`, `bg-[#f5f5f7]`, `text-[#1d1d1f]` — all banned.
- **Zero `bg-white` or `bg-black`** as semantic colors. Use `bg-card`, `bg-background`, `text-foreground`.
- **Zero `text-foreground/50`** — use `text-muted-foreground`.
- **Zero hardcoded status colors** outside the semantic set in `design.md §Status colors`.
- Tailwind opacity modifiers on semantic tokens are OK: `bg-muted/30`, `bg-destructive/10`, `border-border/50`.

### Dark Mode
- Every page MUST render correctly in dark mode. If you use a token from `design.md`, dark mode is automatic. If you hardcode, dark mode breaks.
- Test mentally: "If `--background` is `#0a0a0a`, does my layout still make sense?" If not, you have a hardcoded color somewhere.

### Typography
- Every heading element needs its class set. A bare `<h2>` or `<h3>` with no className is a bug.
  - `<h1>` → `text-xl font-semibold tracking-tight`
  - `<h2>` → `text-base font-semibold tracking-tight` (or `text-lg` for page-level section intro)
  - `<h3>` → `text-[13.5px] font-semibold tracking-tight`
- `tracking-tight` is required on all headings. Missing it makes headings look amateur at any font size.
- Secondary/helper text → `text-xs text-muted-foreground`. Never `text-sm text-gray-500` or similar.

### Text Content
- Ellipsis: `…` (U+2026), never `...` (three periods). In JSX: `{"…"}` or just `…` inside text.
- Loading states end with `…`: `"Saving…"` not `"Saving..."`.
- Button labels are **Title Case**, specific: `"Save API Key"` not `"Save"` when context matters.
- Error messages include the fix or next step, not just what went wrong.

### Accessibility
- Every icon-only `<Button>` needs `aria-label`. Every. Single. One.
- `<Input>` elements need a paired `<Label htmlFor="...">` OR `aria-label`. No exceptions.
- Never use `outline-none` without providing a visible `focus-visible:ring-*` replacement.
- Bare `<button>` elements (when you must use them instead of Button component) need `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 rounded`.
- Async updates visible to screen readers need `aria-live="polite"`.

### Animation
- All `animate-spin` and `animate-pulse` need `motion-reduce:animate-none` alongside them.
- Never `transition: all` — use specific properties: `transition-colors`, `transition-opacity`.
- Animations must not block interaction.

### Forms
- Never block paste (`onPaste` + `preventDefault` is banned).
- Password inputs need `autoComplete="current-password"` or `"new-password"`.
- Submit button stays enabled until request fires, then disabled. Re-enable on error (with error shown).

---

## 4. Page Structure Template

Every new page follows this shell exactly. Do not deviate.

```tsx
"use client";

import { Sidebar } from "@/components/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";

export default function MyPage() {
  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-2">
            <SomeIcon className="size-4 text-muted-foreground" />
            <h1 className="text-sm font-semibold">Page Title</h1>
          </div>
          <div className="flex items-center gap-2">
            {/* primary CTA button here if needed */}
            <ThemeToggle />
          </div>
        </header>

        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-6">
            {/* page content */}
          </div>
        </main>
      </div>
    </div>
  );
}
```

Rules:
- Header is always `h-12` (48px). Do not make it `h-14` or taller.
- `max-w-4xl` for content pages. Use `max-w-5xl` only for wide data tables.
- `px-4 py-6` for content padding. Do not add more.
- `gap-6` between major content sections.
- ThemeToggle always in the header, top-right.

---

## 5. Component Patterns Quick Reference

Always prefer the copy-paste pattern from `design.md` over improvising. These are the patterns agents most often get wrong:

### Status badge (correct)
```tsx
<span className="inline-flex items-center gap-1 text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-2 py-0.5 rounded-full">
  <span className="size-1.5 rounded-full bg-emerald-500" />
  completed
</span>
```

### Status badge (wrong — don't do this)
```tsx
{/* WRONG: hardcoded colors, no dark mode */}
<span className="text-green-700 bg-green-100 border border-green-200 px-2 py-1 rounded text-xs">
  completed
</span>
```

### Section heading + description (correct)
```tsx
<div className="flex flex-col gap-1">
  <h2 className="text-base font-semibold tracking-tight">Section Title</h2>
  <p className="text-sm text-muted-foreground">One-line description of what's in this section.</p>
</div>
```

### Section heading (wrong)
```tsx
{/* WRONG: no tracking-tight, no description, wrong size */}
<h2 className="text-lg font-semibold">Section Title</h2>
```

### Destructive row action (correct)
```tsx
<Button
  variant="ghost"
  size="icon"
  className="text-destructive hover:text-destructive"
  onClick={() => setDeleteTarget(item.id)}
  aria-label={`Delete ${item.name}`}
>
  <Trash2 className="size-4" />
</Button>
{/* Plus confirm Dialog rendered once per page, not per row */}
```

### Destructive row action (wrong)
```tsx
{/* WRONG: immediate delete, no confirm, no aria-label */}
<button onClick={() => deleteItem(item.id)}>
  <Trash2 />
</button>
```

---

## 6. What Belongs Where

```
src/app/[route]/page.tsx     — page shell + data fetching + state
src/components/              — reusable UI components used by 2+ pages
src/components/ui/           — shadcn base components — DO NOT edit these
src/lib/api.ts               — all API calls
src/lib/types.ts             — shared TypeScript types
```

Rules:
- Page files own layout (Sidebar, header, main), data fetching, and state.
- Reusable panels (like `ProvidersPanel`, `ApiKeysPanel`) live in `src/components/` and receive no props they could fetch themselves.
- No inline `fetch()` calls in components. All API calls go through `src/lib/api.ts`.
- No new CSS files. Tailwind utilities only. Global exceptions go in `globals.css` with a comment.

---

## 7. Agent Draft Invariants

`AgentDraft` has fields that are **sources of truth** and fields that are **derived on output**. Never confuse them.

| Source of truth | Derived in `createInputFromDraft` — never read back |
|---|---|
| `mcp_server_ids` | `mcp_servers`, `mcp_toolset` tool entries |
| `vault_keys` | vault resolution in the backend |
| `skill_ids` | skill attachment at session time |

**MCP rule**: `createInputFromDraft` strips all `mcp_toolset` entries from `draft.tools` and rebuilds them from `mcp_server_ids`. If an ID is not in the `INTEGRATIONS` catalog it is silently dropped — no toolset, no server URL.

---

## 8. Pre-Commit Checklist

Before marking any UI task done, verify every item:

- [ ] Zero hex color literals in className strings
- [ ] Zero `bg-white` / `bg-black` as semantic colors  
- [ ] Every `<h1>`, `<h2>`, `<h3>` has typography classes including `tracking-tight`
- [ ] Every icon-only button has `aria-label`
- [ ] Every `<Input>` paired with `<Label htmlFor>` or `aria-label`
- [ ] No `outline-none` without a `focus-visible:ring-*` replacement
- [ ] Loading state uses skeleton loader, not spinner or blank
- [ ] Empty state has icon + text + CTA (if actionable)
- [ ] Errors shown inline, not dropped silently or shown only in console
- [ ] Destructive actions guarded by confirm Dialog, not `window.confirm()`
- [ ] All `animate-spin` / `animate-pulse` have `motion-reduce:animate-none`
- [ ] All `"..."` replaced with `"…"` in UI-visible strings
- [ ] Submit buttons disabled during async and show inline spinner
- [ ] Page works in dark mode (no hardcoded light-only colors)
- [ ] Every table column value varies across rows and is non-trivial (drop same-value columns)
- [ ] Row actions visible at rest — not `opacity-0` — or a persistent `⋮` menu is always shown
- [ ] User intent test passed: primary intent visible in <5s without hover or click

---

## 8. Table Design Rules

### Column selection

Before writing a `<th>`, answer all three:

1. **Does this column's value vary meaningfully across rows?** If every row shows the same value (`unknown`, `active`, `sse`) — drop the column or fold it into another cell.
2. **Is this the information the user came here to find?** That column goes first or gets a copy button.
3. **Can this column be empty for some rows?** If yes, render `—` explicitly — never a blank cell.

### Row actions — never `opacity-0`

Users do not hover every row to discover that editing is possible. Actions hidden until hover look broken on rows that haven't been hovered.

```tsx
// Correct — always present, deemphasized at rest
<div className="flex items-center justify-end gap-1 opacity-60 group-hover:opacity-100 transition-opacity">

// Wrong — invisible until hover; users never discover it
<div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
```

`opacity-0` on row actions is only acceptable when a persistent `⋮` overflow button is always visible at full opacity on the same row.

### Status badges on live/async data

Never render a status badge whose value is always a fallback (`unknown`, `—`, `n/a`). A badge with no signal is noise that erodes trust in the UI.

- If the system cannot compute status yet: omit the badge, or show a subtle amber `•` pulse dot with `aria-label="Status checking…"`.
- Only render a status badge when the backend can return at least two distinct meaningful values.

### Gateway/infra tables — show the route users actually use

Any table listing a server, provider, or endpoint must show the gateway route, not just the upstream config URL. The upstream URL ≠ the URL agents use. Both belong; the gateway route is more important.

```tsx
// In a table row for an MCP server:
<td className="px-4 py-3 font-mono text-xs text-muted-foreground">
  /{server.server_name}/mcp
</td>
```

---

## 9. User Intent Test

Run this before shipping any page, table, or list view.

**Step 1 — Write the intent in one sentence:**
> "A [user type] opens this page to [do what]."

Examples:
- *"An admin opens MCP Servers to find the proxy route for a server and verify it's configured."*
- *"A developer opens Keys to find an existing key's ID or create a new one."*
- *"An admin opens Providers to see which are connected and connect a new one."*

**Step 2 — Is the answer visible in under 5 seconds, without hover or click?**

If no → the layout is wrong. The answer to the user's intent must be in the first column, or the first visual element they see. Restructure until yes.

Common failures:
- The most important value (proxy route, key ID, status) is in a later column or hidden until hover.
- The primary CTA ("Connect", "Add Server") is only reachable after scrolling.
- All rows look identical — no visual hierarchy distinguishing connected from disconnected, active from errored.
