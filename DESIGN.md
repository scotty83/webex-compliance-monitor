# Design

Visual system for the **Webex Compliance Monitoring System** console. The palette, type, and components below are the
**committed identity** from the original design handoff —
preserve them. The **Accessibility & state additions** at the end are required by `PRODUCT.md`
(WCAG AA, non-color status, state-complete components) and were not fully present in the prototype.

## Theme

Dark, single-theme, professional. A monitoring instrument that recedes — near-black surfaces, a
tight neutral ramp, and saturated status color used **only** as signal (bot health, listening,
alerts), never decoration. No light theme. Register: **product** (Restrained + semantic state color).

## Color Palette

Implement as CSS custom properties on the app root. Hex is the source of truth (handoff identity);
author in OKLCH where manipulation helps, matching these values.

**Surfaces & lines**
| Token | Value | Use |
|---|---|---|
| `--bg` | `#0e0f12` | Page background |
| `--s1` | `#16171b` | Card / panel surface |
| `--s2` | `#1d1f24` | Elevated surface (buttons, meter block) |
| `--s3` | `#282a31` | Input / pill / toggle-track |
| `--line` | `rgba(255,255,255,.09)` | Subtle dividers, card borders |
| `--line2` | `rgba(255,255,255,.16)` | Stronger borders, dropdowns |

**Text** (verify AA on `--s1`/`--bg`: `--tx1`/`--tx2` pass for body; `--tx3` is for large/meta only)
| Token | Value | Use |
|---|---|---|
| `--tx1` | `#f3f4f6` | Primary text |
| `--tx2` | `#a7abb3` | Secondary text |
| `--tx3` | `#71757d` | Muted / tertiary (large or meta only — do NOT use for body) |

**Semantic status** (bot health, listening, roles)
| Token | Value | Meaning |
|---|---|---|
| `--green` / `--green-solid` / `--green-bg` | `#34c76a` / `#1fa557` / `rgba(52,199,106,.15)` | Connected · listening · positive / green action fill / green tint |
| `--amber` / `--amber-bg` | `#f2b032` / `rgba(242,176,50,.15)` | Dialing / warning tint |
| `--red` / `--red-bg` | `#ff5b52` / `rgba(255,91,82,.15)` | Disconnected · failed · alert / red tint |
| `--blue` / `--blue-bg` | `#4c9ff7` / `rgba(76,159,247,.14)` | Analyst role |
| `--violet` / `--violet-bg` | `#b394f0` / `rgba(179,148,240,.15)` | Front-office role |

**Role → color:** analyst = blue, front-office (`fo`) = violet, compliance bot = red, other/guest = `--tx2`.
**HOST** badge = amber.

## Typography

Two families, paired on a real contrast axis (humanist sans + mono), **not** two similar sans.

- **Mulish** — all UI: headings, labels, buttons, body, names. Weights 400/500/600/700/800 (+ italic 400).
- **IBM Plex Mono** — data only: timestamps, SIP URIs, the clock, timeline tick labels, audit times. Weights 400/500/600.

**Fixed rem scale** (product register — not fluid/clamp). Key steps (from the handoff):
| Role | Size / weight / font |
|---|---|
| Page H1 | 23px / 800 / Mulish |
| Section H2 | 15px / 800 / Mulish |
| Meeting title (card) | 16.5px / 700 · (chaperone bar) 18px / 800 / Mulish |
| Attendee name | 14px / 700 / Mulish |
| Body / status subtext | 12–13.5px / 400–600 / Mulish |
| Role badge | 10.5px / 700 · HOST 10px / 800 / Mulish |
| Timestamps / SIP / ticks | 11–12.5px / 400–600 / **IBM Plex Mono** |

`-webkit-font-smoothing: antialiased`. `text-wrap: balance` on headings.

## Components

State-complete (see Accessibility additions): every interactive element has default / hover / focus-visible / active / disabled, plus loading / empty / error where it owns data.

- **Header** (sticky, 62px, `rgba(16,17,20,.86)` + `backdrop-filter: blur(14px)`, `border-bottom: --line`): logo mark (34px, green gradient, headphones SVG) + "Compliance Monitor / Webex monitoring console"; status pill ("N meetings tracked"); **issues alert** (red tint, "N bots need attention") — conditional; settings gear (36px); officer pill (avatar + name). *(Recording pill removed — live-listening only.)*
- **Meeting card** (`--s1`, 14px radius, `--line` → `--line2` on hover): title / org / SIP (mono); bot-status pill (dot + "Bot [state]"); "Started HH:MM · elapsed" (mono); participant avatar stack (30px, −8px overlap, role colors, "+N" overflow); **join button** — connected = green solid "Chaperone join"; dialing/failed/disconnected = disabled `--s3`. *(No REC badge.)*
- **Chaperone top bar**: back button; meeting meta; **audio VU meter** (9 bars, 56×30px, green when listening / `--tx3` paused); Pause/Resume button.
- **Panels**: Attendees (role badges, HOST, join/leave times, active-first sort, left rows at .66 opacity); Presence timeline (per-attendee bars over a time axis + "now" line); Other active meetings (hop-to-listen rows, status dot + chevron, disconnected greyed); Listening activity (from `GET /audit` — started/stopped listening log).
- **Buttons**: green-solid primary (`#06210f` ink), `--s2` secondary, disabled `--s3`/`--tx3`. Radius 9–10px.
- **Pills / badges**: 16–24px radius, `--s3`/tinted bg. **Status dots**: 7–9px + `box-shadow: 0 0 0 3px [tint]`.
- **Tooltip**: `position: fixed`, mouse-follow, `#0b0c0e` + `--line2`, participant names. (Portal/fixed — never clipped by an overflow container.)
- **Toggle** (settings): segmented, `--s3` track, active = `--green-bg`/`--green`.

## Layout

- **Overview:** max-width 1320px; grid `repeat(auto-fill, minmax(360px, 1fr))`, gap 16px.
- **Chaperone:** max-width 1400px; two-column `grid-template-columns: minmax(0,1fr) 340px`; right column sticky (`top: 78px`). Target viewport 1440×940.
- **Responsive (structural, not fluid type):** the overview grid reflows via `auto-fill`; below ~760px the chaperone two-column collapses to one, the right panels stack under the left. Header wraps its status/alert cluster gracefully.
- **z-index scale (semantic):** base → sticky header (20) → settings overlay (40)/panel (42) → tooltip (90). No arbitrary 999s.

## Motion

Product cadence: 150–250ms, ease-out; motion conveys **state**, not decoration. No page-load choreography.

- Recording blink — *removed* (no recording). Pulse (1.8s) — the live "now" dot on an active timeline bar. Dial — a gentle dialing-state pulse on amber bot dots.
- **Audio VU meter:** the one continuous motion — bars driven by real audio level from the `/live` WS (Web Audio `AnalyserNode`); idle/paused = flat/static.
- List stagger is acceptable on the meeting grid's first paint; keep it subtle and content-visible by default (don't gate visibility on a reveal class).
- **Reduced motion (`prefers-reduced-motion: reduce`) — required:** VU meter → static bars; pulse/blink dots → solid; any reveal → instant/crossfade.

## Accessibility & state additions (required by PRODUCT.md — beyond the prototype)

- **WCAG 2.1 AA:** body ≥4.5:1, large/UI ≥3:1, visible focus ring on every interactive element, full keyboard operability, meaningful labels/roles (live regions for the "bot needs attention" alert).
- **Status is never color-only:** each bot-health state pairs its color with a **shape/icon + text label** — e.g. connected = filled green dot + "Connected"; dialing = amber ring/animated + "Dialing"; disconnected/failed = red + a **distinct glyph** (e.g. broken-link / alert) + "Disconnected"/"Failed". Same for listening (icon + "Listening"/"Paused"). A monochrome screenshot must still convey health.
- **State-complete components:** skeleton loading for the meeting grid + attendees (not spinners); an **empty state** that teaches ("No meetings are being chaperoned right now"); an **error state** for a failed `GET /meetings` (system banner, retry) — none existed in the mockup.
- **Fail-LOUD in the UI:** disconnected/failed bots must remain prominent — surfaced in the header alert, the card, and the "other meetings" list; never filtered out.
