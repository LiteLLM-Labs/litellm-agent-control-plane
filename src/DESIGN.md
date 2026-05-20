# LiteLLM Agent Platform — Design System

> Reference for any agent or engineer making UI changes. Match this spec
> before shipping. Deviate only with explicit sign-off.

---

## 1. Visual Language

**Aesthetic:** Developer-tool minimalism. Inspired by Linear, Vercel dashboard,
and the VS Code sidebar. Low decoration, high information density. Confidence
over friendliness.

**Mood keywords:** Precise · Quiet · Capable · Monochromatic

---

## 2. Color

### Palette — CSS variables (via Tailwind + shadcn/ui)

All surfaces and text MUST use CSS variable tokens, never hardcoded Tailwind
grays. The session view currently violates this (tracked bug).

| Token | Light | Dark | Usage |
|---|---|---|---|
| `bg-background` | white | near-black | page/panel background |
| `bg-card` | white | dark card | card surfaces |
| `bg-muted` | gray-100 | gray-800 | subtle fills, toolbar backgrounds |
| `bg-sidebar` | — | — | sidebar-specific background |
| `text-foreground` | gray-900 | gray-50 | primary text |
| `text-muted-foreground` | gray-500 | gray-400 | secondary/meta text |
| `border` | gray-200 | gray-700 | default borders |
| `bg-accent` | gray-100 | gray-800 | hover fills |
| `ring` | — | — | focus rings |

### Semantic status colors (hardcoded, intentional)

```
ready / success  → bg-emerald-500
creating / warn  → bg-amber-500
failed / error   → bg-red-500  (bg-red-50 / border-red-200 for banners)
dead / disabled  → bg-muted-foreground
```

### Accent (interactive highlights)

```
violet-50 bg / violet-200 border / violet-700 text   — active panel buttons (Vault, Inspect)
```

---

## 3. Typography

**Sans font:** Geist Sans (`--font-geist-sans`)
**Mono font:** Geist Mono (`--font-geist-mono`)

### Scale in use

| Size | Usage |
|---|---|
| `text-[10px]` uppercase tracking-wider | section headers, badge labels |
| `text-[11px]` | sub-meta, timestamps, mono ids |
| `text-[12px]` | secondary UI labels |
| `text-[13px]` | default UI text, sidebar items, table cells |
| `text-[14px]` | message text, form body |
| `text-[15px]` | composer input |
| `text-[18px]` font-semibold tracking-tight | page `<h1>` (Agents list) |
| `text-[22px]` font-semibold tracking-tight | form page `<h1>` (New Agent) |
| `text-[26px]` font-semibold tracking-tight leading-none | large page `<h1>` (Sessions) |

**Rules:**
- Headings: `font-semibold tracking-tight`, no `font-bold`
- Numeric columns: always `tabular-nums`
- Mono content (IDs, model names, code, env keys): `font-mono`
- IDs displayed: first 8 chars only — `id.slice(0, 8)`
- Ellipsis: `…` (U+2026), never `...`

---

## 4. Spacing & Layout

### Shell

```
Sidebar: 240px fixed-width, sticky, full-height, border-r
Main content: flex-1, overflow-y-auto
```

### Content widths

| Context | Max-width |
|---|---|
| Session thread + composer | `max-w-[720px] mx-auto` |
| Sessions list | `max-w-4xl mx-auto` |
| New Agent / Settings forms | `max-w-2xl mx-auto` |

### Page padding

- Full-page forms: `px-6 py-8` or `px-6 py-10`
- Compact headers: `px-6 py-4` (border-b)
- Toolbar rows: `px-6 py-2`
- Table cells: `px-4 py-3` (data), `px-4 py-2` (header)
- Cards: `CardContent` uses shadcn defaults + `pt-4` for tab bodies

### Border radius

| Shape | Class |
|---|---|
| Buttons, inputs, chips | `rounded-md` |
| Cards, panels, code blocks | `rounded-lg` or `rounded-xl` |
| Avatars, dots | `rounded-full` |
| Logo mark / small squares | `rounded-[4px]` |
| Sidebar row items | `rounded-md` |

---

## 5. Components

### Sidebar items

Height `h-7` to `h-8`. `px-2`. `text-[13px]`. Hover: `hover:bg-sidebar-accent hover:text-foreground`. Active: `bg-sidebar-accent text-foreground` (+ `font-medium` for agents). Focus: `focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`.

### Section headers

`text-[10px] font-medium uppercase tracking-wider text-muted-foreground`. Height `h-6`. Clickable variant navigates to list page.

### Status dots

`size-1.5 rounded-full` inline; `size-2.5 rounded-full ring-2 ring-background` for avatar badge. Always `aria-hidden`; readable status exposed via `title` or adjacent text.

### Buttons (non-shadcn inline style)

```
Default action:    border border-gray-200 rounded px-2 py-1 text-[12px] text-gray-600 hover:bg-gray-100 transition-colors
Active/toggled:    bg-violet-50 border-violet-200 text-violet-700 hover:bg-violet-100
Icon-only:         p-1.5 rounded hover:bg-gray-100 (must add aria-label)
```

Always `type="button"` on non-submit buttons.

### Cards

shadcn `<Card>` → `rounded-lg border bg-card`. Internal sections: `border-t` dividers. No drop shadow by default; use `shadow-sm` only for floating elements (spawn progress card, code drawer).

### Code / pre blocks

Background `#1a1a16`, text `#c9c5bc` (warm off-white). Font `font-mono text-[10.5px] leading-relaxed`. Overflow `overflow-x-auto whitespace-pre`.

Terminal/log blocks: `#1c1b18` bg, `#e8e4dc` text. Height constrained (`h-240px` or `max-h-320`).

### Dialogs / modals

Full-screen backdrop: `fixed inset-0 z-50 bg-black/30`. Panel: `bg-white rounded-xl shadow-xl border border-gray-200 max-w-3xl max-h-[90vh] flex flex-col`. Add `role="dialog" aria-modal="true" aria-labelledby`.

### Side drawers

`absolute right-0 top-0 bottom-0 w-[360px]` or `w-[420px]`. `transition-transform duration-250`. Backdrop shadow: `-4px 0 16px rgba(0,0,0,0.06)`. Must include `overscroll-behavior: contain`.

### Inspector / Vault panels

Rendered as flex siblings inside the session layout (not overlays). They shrink the chat column. `border-l border-gray-200`. Width ~420px.

### Composer

`border border-gray-200 rounded-xl shadow-sm bg-white overflow-hidden`. Focus ring on the wrapper via `focus-within:ring-1 focus-within:ring-gray-300`. Send button: `bg-black text-white p-1.5 rounded-full hover:bg-gray-800 disabled:opacity-30`.

### Filter chips

`rounded-md px-2 py-1 text-[12px]`. Active: `bg-accent text-foreground`. Inactive: `text-muted-foreground hover:bg-muted`. Always include `aria-pressed`.

### Tags / badges (inline)

`rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground`

HTTP method badges: `rounded bg-emerald-100 text-emerald-700 font-mono font-bold text-[10px] px-1.5 py-0.5`

---

## 6. Icons

Library: **lucide-react**. Always `aria-hidden` on decorative icons. Always include `aria-label` on icon-only interactive elements.

Common sizes:
- `size-3` — tiny inline (chevrons in collapsed rows)
- `size-3.5` — standard UI icon (sidebar footer, header buttons)
- `size-4` — standard (nav, table chevrons)
- `size-[14px]` — sidebar row icons

---

## 7. Interactive States

Every interactive element MUST have ALL of:

```
transition-colors
focus-visible:outline-none
focus-visible:ring-2
focus-visible:ring-ring
focus-visible:ring-offset-2
```

`hover:bg-accent/50` or `hover:bg-muted/40` for row items. Never use `:focus` alone; always `:focus-visible`.

---

## 8. Animations

- Loading spinners: `<Loader2 className="animate-spin" />`
- Status pulse: `animate-pulse` (live log dot)
- Panel slide: `transition-transform duration-250 ease-in-out`
- Chevron rotate: `transition-transform` `-rotate-90` collapsed → `rotate-0` expanded

**Required:** wrap in `motion-safe:` Tailwind variant or `@media (prefers-reduced-motion)` where possible.

---

## 9. Forms

- All inputs use shadcn `<Input>` / `<Textarea>` / `<Label>` — no raw HTML unless necessary
- `<Label htmlFor>` linked to every input
- Inline errors: `font-mono text-xs text-destructive` below the field
- Submit button: disabled + spinner (`Loader2`) while request in flight
- Validation: client-side first, then server error surfaced inline
- Env-var rows: KEY column `uppercase font-mono`, VALUE column `type="password" font-mono`

---

## 10. Spawn / Loading States

**Spawn progress card:**
- `border border-gray-200 bg-white rounded-xl shadow-sm px-6 py-5`
- Step list with `size-1.5` status dots: amber (active), emerald (done), gray (pending)
- Elapsed timer in `font-mono text-[11px] text-gray-400`

**Skeleton / loading text:**
- `text-[13px] text-gray-400` — "Loading…" inline, no skeleton shimmer

**Error banners:**
- Red: `border-red-200 bg-red-50 rounded-lg px-4 py-3` — `font-medium text-red-800` title + `mono text-[11px] text-red-700` detail
- Info/dead: `border-gray-200 bg-gray-50 rounded-lg px-4 py-3 text-[13px] text-gray-700`

---

## 11. Data Display

### Tables (Agents list)

`border-collapse text-[13px]`. Header: `bg-muted/20 border-b`. Header cells: `text-[10px] font-semibold uppercase tracking-wider text-muted-foreground`. Rows: `border-b hover:bg-muted/40 cursor-pointer transition-colors`.

### Lists (Sessions list)

`rounded-lg border bg-card overflow-hidden`. Items: `flex items-center gap-3 px-4 py-3 hover:bg-muted/50 transition-colors border-t` (on all but first).

### Collapsible detail blocks (Tool / Thinking / Reasoning)

`border border-gray-200 rounded-md bg-gray-50/60 text-[13px]`. Header button: `w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-100`. Chevron rotates on open/close.

---

## 12. ASCII Layout Mockups

### Sidebar (240px)

```
┌──────────────────────────┐
│ 🚄 LiteLLM Agent Platform│  ← 13px semibold, rounded-sm focus ring
├──────────────────────────┤
│  + New Agent             │  ← h-7 muted row, Plus icon 14px
├──────────────────────────┤
│ RECENT               5   │  ← 10px uppercase section header
│  ● Session abc1234f      │  ← status dot 1.5px, 13px text
│    agent-name · 2m ago   │  ← 11px muted subtitle
│  ● Session def5678a      │
├──────────────────────────┤
│ AGENTS               3   │
│ ▼ [avatar] my-agent  12  │  ← chevron toggle, avatar 20px
│   ● Session abc123   2m  │  ← indented ml-[26px], h-9
│   ○ Session def456   1h  │
│ ▶ [avatar] other-bot  4  │
├──────────────────────────┤
│ SKILLS               2   │
│  📄 code-reviewer        │
│  📄 pr-summary           │
├──────────────────────────┤
│ [☀️] [⚙] [GH]           │  ← sticky footer, h-7 icon buttons
└──────────────────────────┘
```

### Session view header

```
┌─────────────────────────────────────────────────────────────┐
│ [avatar] my-agent › Session abc1234f  ● ready · exp 23h 12m │
│                              [Vault][Inspect][Diagnose][↺][…][⊞]│
└─────────────────────────────────────────────────────────────┘
```

### Composer

```
┌─────────────────────────────────────────────────┐
│ Add a follow up…                                │  ← 15px, p-4
├─────────────────────────────────────────────────┤
│ anthropic/claude-sonnet-4-5          [📎]  [↑] │  ← 12px mono, send = black circle
└─────────────────────────────────────────────────┘
```

Focus state: outer border + `ring-1 ring-gray-300` on `focus-within`.

### Message blocks

```
User prompt (bg-[#f9f9f9] border rounded-xl p-4):
┌─────────────────────────────┐
│ Write a function that…      │
└─────────────────────────────┘

Assistant — text part (no container):
Here is the function:
```python
def foo(): ...
```

Assistant — thinking block (collapsible):
┌──────────────────────────────────────────┐
│ ▼  Thinking  ·  click to collapse        │  ← gray-50/60 bg, 13px
├──────────────────────────────────────────┤
│  (italic gray reasoning text)            │
└──────────────────────────────────────────┘

Assistant — tool block:
┌──────────────────────────────────────────┐
│ 🔧 bash_tool  completed          ▼       │
├──────────────────────────────────────────┤
│ input  ─────────────────────────────     │
│ ls -la                                   │
│ output ─────────────────────────────     │
│ total 42 …                               │
└──────────────────────────────────────────┘
```

### Agents list page

```
┌────────────────────────────────────────────────────────┐
│ Agents  47                     [↺ Refresh]  [+ New]    │  ← border-b header
├────────────────────────────────────────────────────────┤
│ [🔍 Search agents…]                                    │  ← toolbar bg-muted/20
├────────────────────────────────────────────────────────┤
│ AGENT ↓        HARNESS     SESSIONS   CREATED       >  │  ← 10px uppercase th
│─────────────────────────────────────────────────────── │
│ [●avatar] my-agent   opencode   12    2d ago        >  │
│           abc1234f                                     │
│ [○avatar] old-bot    claude-sdk   4   1w ago        >  │
└────────────────────────────────────────────────────────┘
```

### New Agent form

```
┌──────────────────────────────────────┐
│  New Agent                           │  ← 22px h1
│                                      │
│  Templates                           │  ← 10px uppercase
│  ┌────┐ ┌──────────┐ ┌──────────┐   │
│  │ ✦  │ │ 🔍 PR    │ │ 🧪 Test  │   │  ← 3-col grid, border cards
│  │Blank│ │ Review  │ │  Writer  │   │
│  └────┘ └──────────┘ └──────────┘   │
│                                      │
│  ┌────────────────────────────────┐  │
│  │  Name (optional)               │  │
│  │  [Input: code-reviewer]        │  │
│  │                                │  │
│  │  Harness                       │  │
│  │  ○ opencode                    │  │  ← radio list, border divide
│  │  ● claude-agent-sdk            │  │
│  │                                │  │
│  │  Model                         │  │
│  │  [🔍 Search 24 models…]        │  │
│  │  ┌─────────────────────────┐   │  │
│  │  │ ● anthropic/claude-…    │   │  │  ← max-h-64 scrollable listbox
│  │  │ ○ openai/gpt-4o         │   │  │
│  │  └─────────────────────────┘   │  │
│  │                                │  │
│  │  System prompt (optional)      │  │
│  │  [Textarea 6 rows]             │  │
│  │                                │  │
│  │  [Create agent]                │  │  ← shadcn Button primary
│  └────────────────────────────────┘  │
└──────────────────────────────────────┘
```

---

## 13. Copy & Voice

- Headings: Title Case
- Button labels: imperative, Title Case ("New Agent", "Create Agent", "Restart")
- Status: lowercase mono ("ready", "creating", "failed", "dead")
- Counts: numerals, not words ("12 sessions")
- Ellipsis: `…` not `...`
- Error messages: include next step, not just problem
- Placeholders end with `…` and show example: `"code-reviewer"`

---

## 14. Entity Detail Page Header

Every agent/session/resource detail page uses this fixed layout. Do not deviate.

```
┌─────────────────────────────────────────────────────────────────────────┐
│ [avatar 48px]  agent-name                    [⚠ Update available] [🗑]  │
│                subtitle / description        [✏ Edit] [Memory] [Skills] │
│                [chip] [chip] [chip]  · meta  [▶ Spawn session]          │
└─────────────────────────────────────────────────────────────────────────┘
```

**Rules:**
- Avatar and text column are `flex items-start gap-4` — avatar top-aligned to name, not floating independently
- Name is `text-[22px] font-semibold tracking-tight truncate` — single line, never wraps to 3 lines
- Chips (model, harness, template version) are `flex flex-wrap items-center gap-2` — **horizontal row**, never stacked vertically
- Timestamp goes inline with chips as `text-[12px] text-muted-foreground`, not on its own line
- Action buttons live in a `flex shrink-0 items-center gap-2` column on the right, vertically centered to the name row — not anchored to the bottom of the chip stack
- Alert actions ("Update available", warning states) go **first** in the action bar with amber styling — they are the most important action when present, not a peer of Edit/Memory
- Breadcrumb shows the **entity name**, never a raw UUID — use `name ?? id.slice(0, 8)`

---

## 15. Diff Display

Used in template-sync modals and any before/after prompt comparison.

**Algorithm:** Use a proper LCS line diff (Myers or similar), not set-difference. Set-difference produces false positives whenever line order changes — the whole file appears red+green even if one line moved. Implement or import a real diff algorithm.

**Readable font:** `text-[13px] font-mono leading-[1.6]` minimum. `text-[12px]` is the floor for mono content — never go below it in a modal. Diff content is read carefully; optimize for legibility, not density.

**Color contrast:** Diff colors must pass WCAG AA (4.5:1 contrast ratio):
- Added lines: `bg-emerald-500/10 text-emerald-700 dark:text-emerald-400` — no strikethrough
- Removed lines: `bg-red-500/10 text-red-700 dark:text-red-400` — strikethrough optional, only on short lines
- Context lines: `text-muted-foreground` — shown (3 lines above/below each hunk), not hidden
- Never use `text-red-500` on `bg-red-100` or `text-green-500` on `bg-green-100` — both fail contrast

**Line prefix:** `+` / `-` / ` ` prefix in a fixed-width `w-5` column, `select-none`. Keeps diff scannable without relying on color alone (accessibility).

**Modal sizing:** Diff modals need room. Use `max-w-2xl` minimum, `max-h-[65vh]` scrollable body with visible scrollbar (`overflow-y-auto`). Never let the diff overflow outside a scroll container.

**Empty diff:** When old and new are identical, show `"No changes"` — never render an empty scroll box.

```
┌──────────────────────────────────────────────┐
│ Template update available                    │
│ coding-agent v1 → v2                        │
├──────────────────────────────────────────────┤
│   You are a coding agent…                    │  ← context (muted)
│ - Always search memory first.                │  ← red-700, bg-red/10
│ + Always search memory before starting work. │  ← emerald-700, bg-emerald/10
│   Save findings to memory after each session.│  ← context (muted)
├──────────────────────────────────────────────┤
│                        [Cancel] [Update to v2]│
└──────────────────────────────────────────────┘
```

---

## 16. Do / Don't

| Do | Don't |
|---|---|
| Use CSS variable tokens | Hardcode `bg-white`, `text-gray-900` |
| `focus-visible:ring-*` on all interactive | `outline-none` alone |
| `<button>` for actions, `<Link>` for nav | `<div onClick>`, `<li onClick>` |
| `aria-label` on icon-only buttons | Icon button with no label |
| `role="dialog" aria-modal` on modals | Modal missing focus trap |
| `tabular-nums` on numeric columns | Proportional figures in tables |
| `Intl.RelativeTimeFormat` | Manual `2m ago` string construction |
| `motion-safe:animate-spin` | Unconditional animation |
| `overscroll-behavior: contain` in drawers | Drawer that scrolls the page |
| Entity name in breadcrumb | Raw UUID in breadcrumb |
| Chips in horizontal `flex-wrap` row | Chips stacked vertically |
| Alert actions first in action bar | Alert action buried among peer buttons |
| LCS diff algorithm for text comparison | Set-difference diff (produces false positives) |
| `text-[13px]` minimum for readable mono content | `text-[12px]` or smaller in diff/code modals |
| Avatar `items-start` aligned to name | Avatar floating below name independently |
