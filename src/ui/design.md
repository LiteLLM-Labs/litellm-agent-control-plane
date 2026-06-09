# UI Design Reference

Tactical guide for building new features. Copy patterns exactly — don't improvise spacing, colors, or components.

> **Agents:** Read `AGENTS.md` alongside this file. It contains decision trees, the pre-commit checklist, and the rules that govern when to use each pattern here. This file is the *what*; `AGENTS.md` is the *when and how*.

---

## Stack

- **Next.js 16** App Router, TypeScript
- **Tailwind CSS v4** — utility classes only, no custom CSS except in `globals.css`
- **shadcn/ui** (base-nova) — import from `@/components/ui/*`
- **lucide-react** — only icon library, no emoji in UI
- **Geist Sans + Geist Mono** — loaded via `next/font`

---

## Tokens

Never hardcode hex values. Use these CSS variables via Tailwind classes.

### Colors

| Token | Tailwind class | Use |
|-------|----------------|-----|
| `--background` | `bg-background` | Page background |
| `--foreground` | `text-foreground` | Primary text |
| `--card` | `bg-card` | Card, elevated surfaces |
| `--muted` | `bg-muted` | Secondary backgrounds, inputs |
| `--muted-foreground` | `text-muted-foreground` | Secondary/helper text |
| `--border` | `border-border` | All borders |
| `--primary` | `bg-primary` / `text-primary` | Primary actions |
| `--destructive` | `bg-destructive` / `text-destructive` | Delete, error actions |
| `--sidebar` | `bg-sidebar` | Left sidebar background |

### Status colors (semantic — don't substitute)

| State | Class | Use |
|-------|-------|-----|
| Success / idle | `text-emerald-600 dark:text-emerald-400` | Completed, ready |
| Running / warning | `text-amber-600 dark:text-amber-400` | In-flight, pending |
| Error | `text-red-600 dark:text-red-400` | Failed, error |
| Info | `text-sky-600 dark:text-sky-400` | Informational |

Status dot backgrounds: `bg-emerald-500`, `bg-amber-500`, `bg-red-500`

### Harness identity (don't use these for anything else)

```tsx
// claude-code
"bg-orange-500/15 text-orange-600 dark:text-orange-400"
// github-copilot
"bg-sky-500/15 text-sky-600 dark:text-sky-400"
// opencode / default
"bg-muted text-muted-foreground"
```

---

## Typography

```tsx
// Page title
<h1 className="text-xl font-semibold tracking-tight">Title</h1>

// Section heading
<h2 className="text-base font-semibold tracking-tight">Section</h2>

// Label / sub-heading
<h3 className="text-[13.5px] font-semibold tracking-tight">Label</h3>

// Body text
<p className="text-sm text-foreground">Body</p>

// Secondary / helper text
<p className="text-xs text-muted-foreground">Helper</p>

// Table header
<th className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Col</th>

// Monospace (IDs, file paths, code, JSON)
<span className="font-mono text-xs">agent_abc123</span>

// Inline code
<code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">value</code>
```

**Rules:**
- Use `tracking-tight` on all headings
- Never set `text-foreground/50` — use `text-muted-foreground` instead
- Monospace for: IDs, file paths, tool arguments, JSON values, anything that is data not prose

---

## Spacing

4px base grid. Stick to Tailwind's scale.

| Context | Value |
|---------|-------|
| Inline icon gap | `gap-1.5` (6px) |
| Form field gap | `gap-4` (16px) |
| Card internal padding | `p-4` (16px) |
| Page section gap | `gap-6` (24px) |
| Sidebar item height | `h-8` with `py-1.5 px-2` |
| Dialog body padding | `px-6 pb-6` |

---

## Border Radius

```tsx
rounded    // 10px — default for most things
rounded-md // 8px  — buttons, inputs, select
rounded-lg // 10px — cards
rounded-xl // 14px — composer, large inputs
rounded-sm // 6px  — badges, small buttons
```

---

## Components

### Button

```tsx
import { Button } from "@/components/ui/button"

// Primary action
<Button>Create agent</Button>

// Secondary / cancel
<Button variant="outline">Cancel</Button>

// Destructive (delete, remove)
<Button variant="destructive">Delete</Button>

// Ghost (icon-only or low-emphasis)
<Button variant="ghost" size="icon">
  <Trash2 className="size-4" />
</Button>

// Small
<Button size="sm">Save</Button>

// Loading state — disable and add spinner
<Button disabled={loading}>
  {loading && <Loader2 className="size-4 animate-spin" />}
  Save
</Button>
```

Sizes: `default` (h-8), `sm` (h-7), `lg` (h-9), `xs` (h-6), `icon` (size-8), `icon-sm` (size-7)

### Input / Textarea

```tsx
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

// Standard field
<div className="flex flex-col gap-1.5">
  <Label htmlFor="name">Agent name</Label>
  <Input id="name" placeholder="linkedin-outreach" />
  {error && <p className="text-xs text-destructive">{error}</p>}
</div>

// Textarea
<Textarea
  placeholder="You are an outreach agent..."
  className="resize-none"
  rows={6}
/>
```

Errors go **below** the field, `text-xs text-destructive`. Never use toast for form validation errors.

### Card

```tsx
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card"

<Card>
  <CardHeader>
    <CardTitle>Agent name</CardTitle>
    <CardDescription>Short description here</CardDescription>
  </CardHeader>
  <CardContent>
    {/* content */}
  </CardContent>
</Card>
```

For list items (agents, sessions, runs), prefer a simpler border div over Card if you don't need header/footer slots:

```tsx
<div className="border border-border rounded-lg p-4 bg-card">
  {/* content */}
</div>
```

### Badge

```tsx
import { Badge } from "@/components/ui/badge"

<Badge variant="secondary">paused</Badge>
<Badge variant="outline">active</Badge>
<Badge variant="destructive">failed</Badge>

// Custom status badge
<span className="inline-flex items-center gap-1 text-xs bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-2 py-0.5 rounded-full">
  <span className="size-1.5 rounded-full bg-emerald-500" />
  completed
</span>
```

### Dialog

```tsx
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"

<Dialog open={open} onOpenChange={setOpen}>
  <DialogContent className="sm:max-w-lg">
    <DialogHeader>
      <DialogTitle>Create agent</DialogTitle>
      <DialogDescription>
        Configure your agent's behavior and schedule.
      </DialogDescription>
    </DialogHeader>

    {/* scrollable body when content is long */}
    <div className="max-h-[60vh] overflow-y-auto flex flex-col gap-4 px-1">
      {/* form fields */}
    </div>

    <DialogFooter>
      <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
      <Button onClick={handleSubmit} disabled={loading}>
        {loading && <Loader2 className="size-4 animate-spin" />}
        Create
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

Max widths: `sm:max-w-sm` (384px), `sm:max-w-lg` (512px), `sm:max-w-2xl` (672px)

### Table

```tsx
<div className="border border-border rounded-lg overflow-hidden">
  <table className="w-full text-sm">
    <thead className="bg-muted/50">
      <tr>
        <th className="text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground px-4 py-2.5">
          Run ID
        </th>
        <th className="text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground px-4 py-2.5">
          Status
        </th>
      </tr>
    </thead>
    <tbody className="divide-y divide-border">
      {runs.map(run => (
        <tr key={run.id} className="hover:bg-muted/30 transition-colors">
          <td className="px-4 py-3 font-mono text-xs">{run.id}</td>
          <td className="px-4 py-3">
            <StatusBadge status={run.status} />
          </td>
        </tr>
      ))}
    </tbody>
  </table>
</div>
```

### Status dot + label

```tsx
// Inline status indicator
<div className="flex items-center gap-1.5">
  <span className="size-1.5 rounded-full bg-emerald-500" />
  <span className="text-xs text-muted-foreground">idle</span>
</div>

// Pulsing dot for running state only
<div className="flex items-center gap-1.5">
  <span className="size-1.5 rounded-full bg-amber-500 animate-pulse" />
  <span className="text-xs text-muted-foreground">running</span>
</div>
```

### Collapsible section

```tsx
const [open, setOpen] = useState(false)

<div className="border border-border rounded-lg overflow-hidden">
  <button
    onClick={() => setOpen(o => !o)}
    className="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-muted/50 transition-colors"
  >
    <span className="flex items-center gap-2 font-medium">
      <ToolIcon className="size-3.5" />
      tool_name
    </span>
    <ChevronDown className={`size-3.5 text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`} />
  </button>
  {open && (
    <div className="px-3 pb-3 pt-1 border-t border-border">
      {/* content */}
    </div>
  )}
</div>
```

### Empty state

```tsx
<div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
  <FileQuestion className="size-10 text-muted-foreground/40" />
  <div className="flex flex-col gap-1">
    <p className="text-sm font-medium">No files yet</p>
    <p className="text-xs text-muted-foreground">Upload a file or push one via the API.</p>
  </div>
  <Button size="sm" onClick={onAction}>Upload file</Button>
</div>
```

### Loading skeleton

```tsx
// Use when fetching data, not spinners
<div className="flex flex-col gap-3">
  {[...Array(3)].map((_, i) => (
    <div key={i} className="border border-border rounded-lg p-4 flex flex-col gap-2">
      <div className="h-4 w-1/3 bg-muted rounded animate-pulse" />
      <div className="h-3 w-2/3 bg-muted rounded animate-pulse" />
    </div>
  ))}
</div>
```

---

## Page Layout Patterns

### Full-height split (sidebar + content)

```tsx
<div className="flex h-screen">
  <Sidebar />
  <main className="flex-1 overflow-y-auto">
    {/* page content */}
  </main>
</div>
```

### Content page (agents, runs, files)

```tsx
<div className="flex flex-col gap-6 p-6 max-w-4xl mx-auto">
  {/* header row */}
  <div className="flex items-center justify-between">
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Agents</h1>
      <p className="text-sm text-muted-foreground mt-0.5">Manage scheduled automations.</p>
    </p>
    </div>
    <Button>New agent</Button>
  </div>

  {/* content */}
  <div className="flex flex-col gap-3">
    {items.map(item => <ItemCard key={item.id} {...item} />)}
  </div>
</div>
```

### Detail page with tabs (agent detail)

```tsx
<div className="flex flex-col gap-0 h-full">
  {/* sticky header */}
  <div className="border-b border-border px-6 py-4 flex items-center justify-between">
    <div>
      <h1 className="text-lg font-semibold tracking-tight">{agent.name}</h1>
      <span className="font-mono text-xs text-muted-foreground">{agent.id}</span>
    </div>
    <StatusBadge status={agent.status} />
  </div>

  {/* tabs */}
  <div className="border-b border-border px-6 flex gap-0">
    {["Overview", "Files", "Runs"].map(tab => (
      <button
        key={tab}
        onClick={() => setActiveTab(tab)}
        className={`px-4 py-2.5 text-sm border-b-2 transition-colors ${
          activeTab === tab
            ? "border-foreground text-foreground font-medium"
            : "border-transparent text-muted-foreground hover:text-foreground"
        }`}
      >
        {tab}
      </button>
    ))}
  </div>

  {/* tab content */}
  <div className="flex-1 overflow-y-auto p-6">
    {/* render active tab */}
  </div>
</div>
```

---

## Icons

Import from `lucide-react`. Always size with `size-4` (16px) for inline, `size-5` (20px) for standalone actions, `size-3.5` (14px) inside badges or small buttons.

```tsx
import { Trash2, Plus, ChevronDown, Loader2, File, FileText, Play, Pause } from "lucide-react"

// Inline with text
<span className="flex items-center gap-1.5">
  <File className="size-4" />
  outreach.py
</span>

// Button icon
<Button variant="ghost" size="icon">
  <Trash2 className="size-4" />
</Button>

// Spinner
<Loader2 className="size-4 animate-spin" />
```

---

## Notifications (Toast)

Use `sonner` (already configured). Toast for **transient confirmations only** — not errors that require action.

```tsx
import { toast } from "sonner"

toast.success("File saved")
toast.error("Failed to save — check your connection")
// NOT for: form validation errors, missing fields, auth errors
```

---

## Dos and Don'ts

| Do | Don't |
|----|-------|
| Use `text-muted-foreground` for secondary text | Use `text-foreground/50` opacity |
| Monospace for IDs, paths, JSON | Proportional font for data values |
| Inline error below field | Toast for form validation |
| Skeleton loaders while fetching | Spinner or blank white while fetching |
| `animate-pulse` on running state only | Pulse on idle or completed states |
| `lucide-react` icons | Emoji in navigation or labels |
| Destructive confirm dialog for deletes | Instant delete with no confirmation |
| Tabs for agent detail sections | Accordion or nested cards for navigation |
| `gap-1.5` between icon and label | Different gap per component |
