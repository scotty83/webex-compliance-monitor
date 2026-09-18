# Product

## Register

product

## Users

Compliance officers at a financial firm, working from a monitoring desk. Their job is to
oversee **chaperoned meetings** — calls where an industry analyst meets internal front-office
staff over Webex and a compliance presence must be able to listen. On any given shift an officer
watches several meetings **in progress at once**, hops between live calls to listen in ("listen
for the record"), and needs to know instantly if a monitoring bot has dropped. They are not
casual users: they live in this surface for hours, under regulatory obligation, and every action
they take (which call they listened to, when) is itself a compliance record.

## Product Purpose

The **Compliance Console** is the officer's real-time window onto every chaperoned meeting.
It exists so a compliance desk can:

- See all tracked meetings and each monitoring bot's health **at a glance**.
- Click into any live meeting and **listen to its audio in real time** (listen-only), pausing and
  hopping between calls freely.
- Notice a **broken bot immediately** — a disconnected or failed bot is a compliance gap and must
  be impossible to miss (fail-LOUD).
- Keep an **audit trail** of officer listening activity, because who-listened-to-what-when is a
  compliance artifact in its own right.

Success looks like: an officer trusts the console at a glance, never wonders whether coverage is
intact, and never has to hunt for the call they need to be on.

## Brand Personality

**Calm · trustworthy · recedes.** A serious instrument that gets out of the way. Quiet confidence,
not showmanship. The interface should be legible at a glance and let the officer's attention stay
on the meetings, not on the chrome — the tool disappears into the task. Voice is plain, precise,
and unhurried; it states status, it does not editorialize.

## Anti-references

- **Not consumer / playful / gamified** — no mascots, illustrations, celebratory confetti, streaks,
  or badges. This is a regulatory instrument.
- **Not flashy SaaS-marketing** — no gradient heroes, big-number hero-metric templates, or
  decorative flourish. It's an in-task product, not a pitch deck.
- **Not cluttered legacy-enterprise** — avoid the wall-of-gray-tables, tiny fonts, and flat
  hierarchy of old surveillance/compliance software. Density is welcome; illegibility is not.

## Design Principles

1. **Legible at a glance.** A monitoring desk lives or dies on instant comprehension. Status,
   coverage, and health must read in a single sweep, from across the desk.
2. **Fail loud, never bury.** A disconnected or failed bot is a compliance gap — surface it
   prominently and redundantly; degraded coverage is the one thing the UI must never let recede.
3. **The tool disappears.** Serve the officer's task; don't decorate it. Motion, color, and chrome
   earn their place only when they convey state or aid comprehension.
4. **Trust through clarity.** A compliance tool earns trust by being unambiguous — clear status,
   clear provenance (whose bot, which meeting, since when), clear consequences.
5. **Density with hierarchy.** Show the dense reality of many concurrent calls, but keep a strict
   hierarchy so nothing important is lost in the noise.

## Accessibility & Inclusion

- **WCAG 2.1 AA** across the board (body text ≥4.5:1, large/UI ≥3:1, focus-visible on every
  interactive element, full keyboard operability).
- **Status is never color-only.** Bot health (connected / dialing / disconnected / failed) and
  listening state must be conveyed by **icon, label, or shape in addition to color**, so a
  color-blind officer reads coverage as reliably as anyone. Green/amber/red is reinforcement, not
  the sole signal.
- **Reduced motion** honored (`prefers-reduced-motion`): the live audio meter, pulse/blink
  indicators, and any reveal degrade to a static or crossfaded state.
