# Box Check 📦

The 250 Box Challenge with a feedback loop. Freehand a 3D box one stroke
per edge; each stroke is reduced to its dominant line, the lines are
sorted into three direction families by the vanishing point they share,
and each family is scored on how honestly it converges. Every edge is
extended past its own ends the moment it is accepted, so the technique
the drill teaches — extend a line and see where it actually points — is
visible from stroke one rather than from stroke six. The round score is
the mean of the three families, scaled by how complete the box is.

Then the three are held to the one thing a box cannot fake. Three mutually
perpendicular directions seen through a pinhole camera put their vanishing
points at the corners of a triangle whose **orthocenter is the camera's
principal point**, and there the focal length falls out as a single
number, f² = −(a−H)·(b−H), identical for all three pairs. If no real
camera fits, those three sets cannot belong to one box however neatly any
one of them converges. The reveal extends every line, marks each vanishing
point, and draws the true box that camera would have seen, so you can see
the delta. Tap a critique row to show just that set.

Grouping is by vanishing point rather than by image angle on purpose: one
3D direction fans across 40°+ of image angle under ordinary perspective,
so no angle clustering can separate the axes. The search also has to pay
for reading a box *corner* as a vanishing point — the three edges meeting
at a corner are exactly concurrent there, and a 9-edge box can otherwise
be carved into three flawless corner-pencils that mean nothing.

## Judging the same hand the same way

Everything the scorer measures is an **angle**, but a hand's error is
**pixels**, and the two only agree at one edge length. The identical 6px
wobble is 2.3° on a 150px desktop edge and 4.9° on a 70px phone edge —
which is why the same drawing scored 76 on a laptop and 41 on a phone.
And 8° to zero was a pen-tablet tolerance to begin with: a mouse cannot
hold freehand edges to a shared point inside it.

So the tolerance is now stated as **pixels of slop** and converted to
degrees at the edge lengths actually drawn, widened per input mode by
`ArtDaily.ease()`, and never allowed to tighten below the old constant —
a pen on a desktop box gets bit-for-bit the standard it always had. The
grouping tolerance travels with it, because being dealt to the wrong
family is what produced most of the false "these diverge" verdicts. The
`MIN_STROKE` floor is relative to the canvas (was a flat 30px, which was
43% of a phone edge), and phones get a taller sheet.

Three further guards keep the drill from convicting a player of the
reading's own failures:

- **A starved sort is not a drawing fault.** When the grouper leaves a
  family with two strokes or fewer out of eight, and the lines it *did*
  sort are tidy, no accusation is made and the critique says so.
- **A degenerate camera is not a verdict.** The orthocenter of a
  near-degenerate VP triangle flies off the sheet, and short noisy edges
  are exactly what makes it degenerate. When it lands more than 3× the
  drawing away, or the 90° condition fails by less than the families'
  own angular spread, the reading is not confident enough to accuse
  anybody.
- **Nobody's first-ever box is capped.** The "cannot be one box" cap is
  held back until the player has a score on the board. The critique still
  says it — it just does not end the habit on day one.

Two scoring fairness fixes came out of the same pass. A 2-stroke family
used to bank a free ~80 for proving nothing, which paid a player to stop
at the 6-edge minimum instead of drawing the 9–12 the how-to asks for; it
now scores a flat 70 when there is nothing else to compare against, and
otherwise inherits what the rest of the drawing earned. And a family
whose shared point lies **on** its own strokes is charged: lines that
merely cross each other in the middle share a point too, and by fit alone
it is a flawless "vanishing point" — it is just not one.

Measured over 250 simulated rounds per hand (an 11-edge projected box
plus endpoint jitter and wobble, calibrated so the old scorer reproduces
the audit's published means): pen 91 → 91, careful mouse 84 → 92, honest
mouse 72 → 83, trackpad 64 → 80. Trackpad rounds scoring under 40 fell
from 15% to 4%, the divergence verdict from 26% to 9%, the round cap from
12% to 3%. Random-line garbage still fails at the tier it always did.

The critique itself was rewritten from verdict to diagnosis: no
`caps at N` bookkeeping, no "no camera sees it with the others", and
"DIVERGES ✗" became *"these spread apart as they go back — going away
from you they should be closing in. that's the classic one, and it's the
most fixable."*

Input: pen pointers beat a simultaneous palm, `pointercancel` and
`lostpointercapture` are handled, there is a `window` pointerup fallback
(without it one release off-canvas froze the sheet until "new round"),
coalesced events keep a 120Hz sweep intact, the canvas suppresses the iOS
long-press callout, and the controls opt out of double-tap-to-zoom.

Trains: perspective, line. Run it: `python3 -m http.server 8080` — no build,
no deps. Part of [Art Daily](https://artdaily.sadeali.com/) ·
[sadeali.com](https://sadeali.com/).
