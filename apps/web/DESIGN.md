# Renewly — Design Direction

**Visual thesis: _The Refracted Ledger_**

This document is the design authority for `apps/web`. The landing page is the visual
north star for every new screen. Product screens should inherit its taste and principles,
not copy its marketing layout literally.

The current implementation is split between:

- `src/app/site.css` — the landing-page tokens and editorial system.
- `src/app/globals.css` — shared and product-screen styles, some of which predate this direction.
- `src/components/site/Artwork.tsx` — the source of truth for photographic assets, crops and loading.

When legacy styles disagree with this document, this document wins. Do not extend an old
pattern merely because it already exists.

---

## 1. The idea

Renewly handles renewals rather than merely reporting them. It finds hidden recurring
spend, asks for one precise decision, executes the change, and returns proof.

The visual system expresses that through one idea:

> **Light reveals what was already costing you.**

Refracted daylight exposes otherwise invisible spend. Warm paper and editorial type make
the product feel considered and human. Exact figures, controls and receipts make it feel
safe with money.

This is not a conventional SaaS dashboard and not a futuristic AI assistant. It is an
editorial financial instrument.

**Emotional target:** calm · warm · exact · human · quietly capable.

**The test:** a screen should feel as though a financial statement, a well-made magazine
and a precise modern tool were designed by the same person.

### Three governing principles

1. **Reveal, do not decorate.** Light, colour and motion must expose meaning or state.
2. **One decision deserves focus.** Do not make every element compete for attention.
3. **Proof outranks promise.** A receipt, matched charge or executed state is visually
   stronger than an opportunity or recommendation.

---

## 2. What is being preserved from the landing page

Every screen should inherit these qualities:

- Warm ivory and ink rather than cold white, blue-black or generic grey.
- Newsreader-led editorial typography paired with a quiet modern sans.
- Large, declarative language followed by concise operational detail.
- Asymmetrical compositions with deliberate negative space.
- Hairline rules and material surfaces instead of heavy dashboard chrome.
- Sage reserved for money actually returned or a safely completed state.
- Clay reserved for blocked, destructive or attention-required states.
- Photographic spectrum only where natural light creates it.
- Interfaces that look touchable but never toy-like.
- Slow, settling motion with no bounce around money.

Product screens may be denser than the landing page, but they must not become louder.

---

## 3. Colour

### 3.1 Core palette

| Token | Value | Role |
| --- | --- | --- |
| `--ivory` | `#F4F0E8` | Default canvas |
| `--ivory-2` | `#EBE5D9` | Recessed paper, subtle section contrast |
| `--paper` | `#FBF9F4` | Raised sheet, receipt, input surface |
| `--night` | `#171512` | Cinematic dark field and high-focus moments |
| `--night-2` | `#100F0C` | Deepest photographic scrim |
| `--ink` | `#1B1815` | Primary text and primary action |
| `--ink-2` | `#544E45` | Body copy |
| `--ink-3` | `#8B8478` | Labels and secondary metadata |
| `--ink-4` | `#BAB3A6` | Quiet numbers and disabled detail |
| `--sage` | `#66795C` | Money realized, verified success |
| `--clay` | `#A26A4E` | Stopped, destructive, needs attention |
| `--gilt` | `#B8945F` | Rare warmth; never a routine CTA colour |

### 3.2 Usage rules

- The default product canvas is light. Dark fields are reserved for cinematic artwork,
  execution focus, or a deliberate closing/commit moment.
- Pure white and pure black should be avoided; both feel harsher than the brand.
- Sage means **realized or safely completed**, not “potential saving.”
- Opportunity states remain ink or neutral until execution is confirmed.
- Spectrum colours live in the photography. Do not sample the rainbow into buttons,
  charts, badges or decorative gradients.
- Use one primary ink-filled action per composition. Secondary actions are outlined or
  text-only.

### 3.3 Rules and depth

Use warm hairlines derived from ink:

```css
--rule: rgb(27 24 21 / 0.12);
--rule-2: rgb(27 24 21 / 0.20);
```

Depth is quiet: a light inner edge and a long, low-opacity shadow. Only objects that are
materially raised—policy sheets, receipts, conversation panes, modals—receive a shadow.

---

## 4. Typography

### 4.1 Families

| Role | Family | Use |
| --- | --- | --- |
| Display | **Newsreader** | Hero statements, section claims, editorial figures |
| UI/body | **Supreme** | Paragraphs, controls, navigation, labels |
| Dense data | Tabular UI/mono where needed | Tables, IDs, timestamps, aligned ledgers |

Newsreader supplies warmth and institutional confidence. Supreme keeps the product modern
and clear. Their contrast is part of the brand; do not replace both with one generic sans.

### 4.2 Rules

- Display type is light, never bold. Size and space create authority.
- Italic is reserved for the emotional or decisive half of a statement.
- Headlines should be short enough to balance naturally and should use editorial line
  breaks, not fill an entire row.
- Body copy uses `--ink-2`, comfortable line-height and a measure near 38–52 characters.
- Eyebrows are sentence case, quiet and descriptive. Avoid loud all-caps UI labelling on
  marketing or overview screens.
- Dynamic numbers use `font-variant-numeric: tabular-nums` even when set in Newsreader.
- Dense product tables may use a mono/data face, but large customer-facing money figures
  may use Newsreader as the landing page does.

### 4.3 Approximate scale

| Role | Responsive size |
| --- | --- |
| Hero | `clamp(42px, 5.4vw, 84px)` |
| Section statement | `clamp(32px, 4.6vw, 62px)` |
| Editorial money | `clamp(44px, 5.6vw, 78px)` |
| Card title | 22–29px Newsreader or 16–20px Supreme |
| Body lead | `clamp(17px, 1.35vw, 20px)` |
| UI body | 14–16.5px |
| Metadata | 12–13.5px |

---

## 5. Artwork

Artwork is not a decorative banner system. It carries the brand thesis.

### 5.1 Subject and mood

- Natural refracted daylight in a warm, quiet interior.
- A person is composed and still while light moves through the room.
- Human expressions are subtle, credible and emotionally appropriate to the copy.
- The frame feels editorial and cinematic, never like corporate stock photography.
- No visible product UI, floating holograms, neon technology, text or logos in the art.
- Preserve generous negative space for type or an interface object.

### 5.2 Composition

- Decide where copy and interface objects will sit before generating the frame.
- Keep faces, hands and architectural edges away from responsive crop danger zones.
- A portrait used for proof should leave room for the receipt and should communicate the
  result emotionally; it is not merely an attractive person.
- Full-bleed art needs 5–8% overdraw so gentle parallax never exposes an edge.
- Mobile may use a separate source or crop when the composition materially changes.

### 5.3 Implementation

- Register art in `src/components/site/Artwork.tsx`; do not wire asset paths throughout CSS.
- Store original Midjourney output in `public/assets`, but serve an optimized photographic
  derivative where possible.
- Focal point, scale, transform origin, responsive crop and loading policy belong in the
  artwork registry.
- Use `alt=""` for purely atmospheric plates. Meaningful documentary images require real
  alt text and should not use the decorative `Artwork` wrapper unchanged.
- One strong artwork per narrative chapter is usually enough.

### 5.4 When new art is justified

Generate a new plate only when an existing image cannot express the intended emotion,
support the required negative space, or survive the responsive crop. Do not add art to fix
weak hierarchy or an ordinary layout.

---

## 6. Composition and spacing

### 6.1 Editorial grid

- Standard content shell: approximately 1180px.
- Wide photographic shell: approximately 1400px.
- Section rhythm: 80–168px, adjusted for viewport height.
- Prose should rarely exceed 52 characters per line.
- Prefer unequal columns such as `1.05fr / 0.68fr` over mechanically equal halves.
- Align copy by baseline or optical centre, not merely by bounding-box top.

### 6.2 Narrative rhythm

A strong Renewly page alternates between:

1. A clear editorial claim.
2. Exact operational evidence.
3. A moment of visual breathing room.
4. One action or decision.

Do not build a page as a sequence of unrelated rounded cards. Consolidate related ideas
into one chapter and let a hairline, material change or artwork shift mark the progression.

### 6.3 Negative space

Empty space is active. It separates promise from proof and gives financial information
calm. Do not fill it with decorative icons, floating badges, testimonials or gradients.

### 6.4 Radii

- Photographic plates: 24–30px on desktop; edge-to-edge is acceptable on narrow mobile.
- Major policy/conversation sheets: 20–26px.
- Receipts and nested surfaces: 12–18px.
- Pills are reserved for buttons, compact statuses and binary controls.

---

## 7. Product interface materials

Marketing and product should feel related without making product screens theatrical.

### 7.1 Sheets, not dashboards

Think in terms of policy sheets, ledgers, receipts and correspondence:

- Use one containing surface for a related task.
- Divide it with hairlines rather than many independent cards.
- Give the result or consequence its own quiet material region.
- Avoid a grid of equally weighted KPI cards.

### 7.2 Controls

- A control must sit beside the policy it changes or the consequence it produces.
- Prefer explicit, labelled choices to ambiguous continuous controls when the domain has
  meaningful presets.
- Switches are for immediate binary state only.
- Destructive/freeze controls use clay and plain language; never rely on colour alone.
- Show what changes after a control moves. A calculator without consequences is decoration.

### 7.3 Money and proof

- “Identified” and “realized” are different states and must never share the same emphasis.
- A saving enters realized totals only after confirmation and charge matching.
- Whenever possible, place the receipt, confirmation or ledger evidence near the claim.
- Charts are quiet and sparse: sage line, warm rules, no rainbow series, no chart chrome.

### 7.4 Buttons

- Primary: ink fill on light surfaces; paper fill on dark artwork.
- Secondary: transparent with a restrained hairline.
- Keep one obvious primary action in a composition.
- Hover is a subtle value change or small directional movement—not scale, bounce or glow.

---

## 8. Motion

Motion should feel like light settling in a room.

Use the shared easing:

```css
--slow: cubic-bezier(0.22, 1, 0.36, 1);
```

- Reveals are slow opacity/short translate transitions.
- Artwork may drift only a few percent while its chapter is in view.
- Money counts once and then becomes still.
- State changes should visibly resolve but never bounce.
- The most motion belongs to execution, verification and a receipt arriving—not hover.
- Do not animate every card independently merely because it is possible.

Under `prefers-reduced-motion: reduce`, final values and states appear immediately, ambient
motion stops, and no interaction becomes dependent on animation completing.

---

## 9. Voice and copy

Renewly sounds exact, calm and outcome-led.

### Use

- “Every dollar back, with a receipt behind it.”
- “Stopped — over your ceiling.”
- “Three of four settle alone.”
- Exact vendors, dates, amounts and consequences.

### Avoid

- “Unlock powerful AI insights.”
- “Effortlessly optimize your SaaS stack.”
- “You could potentially save.”
- Exclamation marks, anthropomorphic chatter and generic AI language.

Prefer a short claim plus evidence. If a paragraph explains more than one idea, split it or
remove it.

---

## 10. Responsive behaviour

The supported design range is 320px mobile through 1920px wide monitor.

- Mobile is a recomposition, not a scaled desktop.
- Editorial columns stack; the claim remains above its evidence.
- Five-column or ledger sequences become structured vertical rows.
- Important actions must not wrap internally at 320px.
- Interface sheets stack before their labels or outcomes become cramped.
- Photographic cards may become edge-to-edge on mobile when a small radius creates an
  accidental “card inside a card” look.
- Artwork focal points must be checked at 320, 390, 768, 1024, 1440 and 1920px.
- Horizontal document overflow is never acceptable.
- Dense tables should become labelled rows or horizontal scrollers with an explicit cue;
  never shrink financial text below legibility.

---

## 11. Accessibility floor

- Body text meets WCAG AA against its actual surface or photograph.
- Status is expressed in words as well as colour.
- Every interactive element is keyboard reachable with a visible `:focus-visible` ring.
- Dark photographic surfaces use a paper-coloured focus ring.
- Decorative artwork is hidden from assistive technology.
- Live financial results use appropriate `aria-live` without announcing every animation
  frame.
- Touch targets are at least 44px where practical.
- Reduced motion shows final values immediately.
- Text must remain readable at 200% zoom without horizontal page overflow.

---

## 12. Do / don't

| Do | Don't |
| --- | --- |
| Use warm paper, ink and restrained sage | Default to cold white, blue-black or acid neon |
| Let one exact number carry the argument | Fill the screen with equal KPI cards |
| Show the consequence beside the control | Present an isolated calculator or knob |
| Use refracted light as meaningful atmosphere | Turn spectrum colours into a UI gradient system |
| Combine related ideas into one chapter | Stack many interchangeable SaaS sections |
| Use receipts and matched charges as proof | Style opportunities as realized savings |
| Use asymmetric editorial layouts | Centre every heading over a symmetrical card grid |
| Let motion settle | Bounce, pulse or endlessly animate money states |
| Keep copy precise and short | Use generic AI and optimization language |

---

## 13. Deprecated direction

The earlier **Ledger-Noir** direction is no longer the authority for new work. Specifically,
do not extend these legacy ideas:

- Dark-first screens as the default.
- Acid-lime as the primary brand colour.
- The Meridian mark as a universal decorative/loading motif.
- Monospace for every customer-facing dollar amount.
- Grid fields, phosphor glow, terminal styling or “AI instrument panel” atmosphere.

Existing screens may still contain these patterns. Treat them as migration work, not
precedent.

---

## 14. Agent handoff checklist

Before considering a new screen finished, verify:

- [ ] It has one clear claim, task or decision.
- [ ] The hierarchy still works in greyscale.
- [ ] Sage is used only for realized/verified value.
- [ ] Opportunity and realized money are visually distinct.
- [ ] Controls visibly update their consequence.
- [ ] It uses a sheet/ledger structure rather than a generic card grid.
- [ ] Any artwork has a semantic role and a registered responsive crop.
- [ ] Copy contains exact outcomes rather than AI abstractions.
- [ ] The screen works at 320, 390, 768, 1024, 1440 and 1920px.
- [ ] There is no horizontal page overflow.
- [ ] Keyboard focus, contrast and reduced motion are verified.
- [ ] A new visual pattern has been added here before being repeated elsewhere.
