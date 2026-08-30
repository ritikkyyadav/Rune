# Art directions — the working catalogue

Twenty directions, each written as something you can BUILD, not something you can
admire. Every entry names the ground, the palette behaviour, the type pairing,
the layout logic, the one signature move that makes it read as itself, and what
it is actually for.

Two rules that override everything below:

1. **The project's own system wins.** If a design system, brand, or token file
   exists, match it exactly and stop reading here.
2. **Never average two directions.** Half-Swiss half-cyberpunk is not a third
   style, it is the generated look this catalogue exists to escape.

---

## 1. Minimalism

- **Ground** near-white (#FAFAF9–#FFF) or near-black. One, not both.
- **Palette** ground + 3 grays + ONE accent used at most three times per screen.
- **Type** one grotesque, three sizes. Weight and size carry the whole hierarchy.
- **Layout** enormous whitespace; measure ≤65ch; space instead of borders.
- **Signature** what you removed. If a rule, box, or shadow can go, it goes.
- **Motion** none, or a single 150ms fade.
- **For** reading, portfolios, high-trust tools, anything whose content is the point.
- **Fails when** the content is genuinely dense — minimalism on a data grid reads
  as unfinished, not calm.

## 2. Maximalism

- **Ground** saturated, often patterned or textured.
- **Palette** 5–8 hues held together by one repeated shape or texture, not by restraint.
- **Type** three faces on purpose — a display, a script or hand, and a mono.
- **Layout** dense collage grid, deliberate overlap, z-layers that break the grid.
- **Signature** density as generosity: every inch earns its place.
- **Motion** parallax, marquee tickers, hover states that change scale.
- **For** music, fashion, festivals, culture, anything selling energy.
- **Fails when** the user came to complete a task. Maximalism costs comprehension.

## 3. Futuristic

- **Ground** deep charcoal or ink (#0A0C10), never pure black.
- **Palette** one electric accent (cyan, lime, or violet) on cold grays.
- **Type** thin geometric sans, wide tracking on labels (0.12em+), mono for data.
- **Layout** visible grid overlays, hairline rules, corner ticks, HUD framing.
- **Signature** ONE blurred glow layer behind the accent — not shadows on everything.
- **Motion** slow ambient drift; numbers that count up on load.
- **For** AI, space, hardware, simulation, telemetry.
- **Fails when** it becomes shadow soup. One glow, one accent, or it's a toy.

## 4. Vector art

- **Ground** flat, light, single colour.
- **Palette** 4–6 flat colours, no gradients, no shadows.
- **Type** rounded geometric sans (Poppins/Nunito class), friendly weights.
- **Layout** illustration is the hero and sets the grid; text wraps around it.
- **Signature** a consistent shape language — same corner treatment in every asset.
- **Motion** SVG path draw-on, simple bounce easing.
- **For** onboarding, SaaS marketing, education, explainers.
- **Fails when** the illustrations are stock. The shape language must be one hand.

## 5. Collage art

- **Ground** paper or scanned texture.
- **Palette** whatever the source images carry, unified by one overlay tint.
- **Type** hand-set, mixed sizes, rotated a degree or two.
- **Layout** torn edges, cut-outs, tape and staple motifs, intentional misalignment.
- **Signature** real texture — a scanned edge, not a CSS approximation of one.
- **Motion** elements that settle into place, slightly off-axis.
- **For** zines, editorial features, campaigns, cultural writing.
- **Fails when** the "randomness" is uniform. Collage needs genuine irregularity.

## 6. Retro

- **Ground** period-true. 70s: warm cream. 80s: deep navy or black.
- **Palette** commit to a decade — 70s mustard/rust/avocado/cream, 80s hot
  pink/cyan/purple, 90s teal/magenta/grey.
- **Type** period display (rounded slab, groovy, or chrome) + a plain body.
- **Layout** chunky borders, rounded rectangles, badge and sticker shapes.
- **Signature** a grain or halftone overlay at 3–6% opacity across everything.
- **Motion** none, or a hard step — no modern easing.
- **For** food, music, nostalgia brands, anniversary pages.
- **Fails when** the decade is a blend. Pick one and be accurate to it.

## 7. Cyberpunk

- **Ground** near-black, often with a faint scanline or noise.
- **Palette** magenta + cyan as a pair, on black, plus one warning amber.
- **Type** mono nearly everywhere; a condensed display for headings.
- **Layout** dense terminal panels, bracketed labels, hard 90° corners.
- **Signature** RGB-split or glitch on headings ONLY, never on body text.
- **Motion** flicker, typewriter reveals, scanline drift.
- **For** gaming, security, crypto, anything with an underground posture.
- **Fails when** everything glitches. The effect must be rationed to read as intent.

## 8. Pop art

- **Ground** a primary colour, or white with primary blocks.
- **Palette** red/yellow/blue/black, high chroma, no tints.
- **Type** heavy comic or poster display, tight tracking, ALL CAPS headlines.
- **Layout** thick black outlines, panel grids, Ben-Day dots, halftone.
- **Signature** the black outline on everything, at one consistent weight.
- **Motion** hard cuts, pop-in scale.
- **For** consumer, youth, retail, merch.
- **Fails when** the palette softens. Pop art has no pastels.

## 9. Glassmorphism

- **Ground** a colourful blurred field (photo or mesh) that the glass sits on.
- **Palette** translucent whites over 2–3 background hues.
- **Type** clean sans, medium weight — glass eats thin type.
- **Layout** floating panels, `backdrop-filter: blur(20px)`, 1px light top border.
- **Signature** the light edge: a hairline that catches on the panel's top and left.
- **Motion** panels that lift on hover.
- **For** fintech, wallets, media players, dashboards that want lightness.
- **Fails when** contrast dies. Test every text colour ON the blurred layer.

## 10. Clay style

- **Ground** a soft pastel, never white.
- **Palette** desaturated pastels, one saturated accent.
- **Type** rounded friendly sans, generous weights.
- **Layout** big radii used consistently (24–40px), soft 3D shapes, no hard edges.
- **Signature** dual soft shadows — light from top-left, dark bottom-right, both blurred.
- **Motion** squash-and-stretch on press.
- **For** kids, wellness, habit trackers, playful consumer apps.
- **Fails when** the shadows come from different light sources. One sun.

## 11. Pixel art

- **Ground** a flat, limited-palette colour.
- **Palette** 8–16 colours, hard, no anti-aliasing.
- **Type** bitmap or mono; `image-rendering: pixelated` on every asset.
- **Layout** everything snaps to an 8px grid; borders are drawn, not styled.
- **Signature** step animation — no easing curves anywhere.
- **For** games, dev tools with personality, retro communities.
- **Fails when** modern smoothing leaks in. One anti-aliased edge breaks the spell.

## 12. Editorial

- **Ground** cream (#FBF8F1) or true white.
- **Palette** ink, paper, one accent for links and marginalia.
- **Type** a serif display with real character + a humanist body; mono microlabels.
- **Layout** measure ~65ch, generous leading (1.6–1.7), drop caps, pull quotes,
  rules instead of boxes, marginal notes.
- **Signature** typographic hierarchy alone carries the page — no cards.
- **For** long-form reports, journalism, essays, documentation with a voice.
- **Fails when** it is used for a tool. Editorial is for reading, not operating.

## 13. Y2K

- **Ground** silver/chrome gradient or deep blue.
- **Palette** chrome, ice blue, lilac, hot pink.
- **Type** bubble/inflated display, tight and glossy.
- **Layout** skeuomorphic buttons, bevels, lens flares, star sparkles.
- **Signature** the chrome gradient with a hard specular band across it.
- **For** fashion, music, nostalgia, event pages.
- **Fails when** it is only slightly Y2K. This one demands full commitment.

## 14. Swiss / International

- **Ground** white, always.
- **Palette** black, one grey, red as the single accent. Nothing else.
- **Type** one neutral grotesque (Helvetica/Neue Haas/Inter class), 3 sizes,
  2 weights. Flush left, ragged right, never justified.
- **Layout** a visible, strict modular grid; everything aligns to it; asymmetric
  balance; enormous margins.
- **Signature** hierarchy by size and position ALONE. No decoration exists.
- **Motion** none.
- **For** institutional, scientific, archives, documentation, catalogues,
  anything whose authority comes from rigour.
- **Fails when** a single decorative element appears. Swiss is a discipline.

## 15. Surreal

- **Ground** a dreamlike gradient or an impossible sky.
- **Palette** unexpected adjacencies — sand and cobalt, flesh and mint.
- **Type** a classical serif doing something odd (enormous, cropped, rotated).
- **Layout** impossible scale shifts, floating objects, objects escaping frames.
- **Signature** one deliberate impossibility per screen. Only one.
- **For** art, agencies, creative portfolios, campaigns.
- **Fails when** everything is strange. Surrealism needs a normal to violate.

## 16. Bohemian

- **Ground** sand, oat, or warm off-white.
- **Palette** terracotta, sage, clay, ochre — earth, all desaturated.
- **Type** a serif with soft curves, or a humanist sans; generous, unhurried.
- **Layout** organic blob shapes, arch motifs, hand-drawn line accents, layered texture.
- **Signature** the arch — repeated as image mask, button, and section divider.
- **For** wellness, craft, lifestyle, food, retreats.
- **Fails when** it goes bright. Bohemian lives entirely in muted earth.

## 17. Victorian

- **Ground** deep jewel tone or aged paper.
- **Palette** oxblood, forest, brass, ink.
- **Type** high-contrast didone or blackletter display + a classical body serif.
- **Layout** strict symmetry, ornamental rules and corners, engraved illustration.
- **Signature** the ornamental frame — one flourish system used throughout.
- **For** heritage brands, spirits, publishing, theatre.
- **Fails when** the ornament is generic clip-art. It must be one consistent set.

## 18. Graffiti

- **Ground** concrete, brick, or raw paper texture.
- **Palette** high-chroma sprays over a grey/neutral base.
- **Type** tag or stencil lettering for display, plain condensed sans for body.
- **Layout** deliberate misalignment, layered tags, spray overspill past edges.
- **Signature** the overspray — colour that ignores the container.
- **For** streetwear, music, youth culture, skate.
- **Fails when** it is neat. The whole point is controlled disorder.

## 19. Aurora

- **Ground** dark ink or near-white.
- **Palette** large soft gradient meshes — violet/teal/rose — as the ONLY decoration.
- **Type** clean modern sans, high contrast against the mesh.
- **Layout** blurred colour fields behind flat content; content stays crisp and simple.
- **Signature** the mesh is background only. Nothing else glows.
- **For** AI products, SaaS landing pages, developer tools.
- **CAUTION** this is one step from the purple-blue gradient hero that reads as
  generated. Earn it: use unusual hue pairs, keep the mesh off the content, and
  never centre a gradient behind a headline.

## 20. Handwritten

- **Ground** paper, with real texture and a faint tooth.
- **Palette** ink, pencil graphite, one highlighter colour.
- **Type** a genuine handwriting or marker face for display (the "prickly pear"
  specimen is this class) + a plain body face for anything long.
- **Layout** imperfect alignment, margin notes, marker underlines and circles as
  emphasis, arrows between ideas.
- **Signature** emphasis drawn rather than styled — a circled word, an underline
  that overshoots.
- **For** personal writing, poems, teaching, notes, letters, anything intimate.
- **Fails when** the hand face is used for body text. Handwriting is for display.

---

## Choosing candidates by subject

Name the subject first, then take the row. Offer the user **two or three** of
these, never all of them, and never fewer than two.

| Subject | Candidates |
|---|---|
| Scientific / lab / research / archive | Swiss · Minimalism · Editorial |
| Data tool, dashboard, monitoring | Minimalism · Futuristic · Swiss |
| AI / ML product | Futuristic · Aurora · Minimalism |
| Developer tool, terminal, infra | Futuristic · Cyberpunk · Swiss |
| Fintech, banking, trading | Minimalism · Glassmorphism · Swiss |
| Long-form report, essay, journalism | Editorial · Swiss · Minimalism |
| Personal writing, poem, letter | Handwritten · Editorial · Minimalism |
| Portfolio, agency, studio | Brutalist-leaning Minimalism · Surreal · Editorial |
| Games, interactive toys | Pixel · Cyberpunk · Pop art |
| Kids, education, wellness | Clay · Vector art · Bohemian |
| Music, festivals, nightlife | Maximalism · Graffiti · Retro |
| Fashion, beauty, streetwear | Y2K · Collage · Graffiti |
| Food, hospitality, craft | Retro · Bohemian · Editorial |
| Heritage, spirits, publishing | Victorian · Editorial · Swiss |
| Consumer app, social, retail | Pop art · Clay · Vector art |
| Culture, art, exhibition | Collage · Surreal · Editorial |

A subject not on this list is not an excuse to default. Name its nearest
neighbour and say which row you borrowed.
