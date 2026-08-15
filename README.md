# Box Check 📦

The 250 Box Challenge with a feedback loop. Freehand a 3D box one stroke
per edge; each stroke is reduced to its dominant line, the lines are
sorted into three direction families by the vanishing point they share,
and each family is scored on how honestly it converges: a tight vanishing
point scores toward 100, parallel edges score 85 (VP near infinity —
fine), diverging edges — the classic mistake — cap at 30. The round score
is the mean of the three families.

Then the three are held to the one thing a box cannot fake. Three mutually
perpendicular directions seen through a pinhole camera put their vanishing
points at the corners of a triangle whose **orthocenter is the camera's
principal point**, and there the focal length falls out as a single
number, f² = −(a−H)·(b−H), identical for all three pairs. If no real
camera fits — the triangle is obtuse, or the lens it implies is a fisheye
— then those three sets cannot belong to one box however neatly any one of
them converges, and the round caps at 30. The reveal extends every line,
inks each VP, and draws the true box that camera would have seen, so you
can see the delta. Tap a critique row to spotlight just that set.

Grouping is by vanishing point rather than by image angle on purpose: one
3D direction fans across 40°+ of image angle under ordinary perspective,
so no angle clustering can separate the axes. The search also has to pay
for reading a box *corner* as a vanishing point — the three edges meeting
at a corner are exactly concurrent there, and a 9-edge box can otherwise
be carved into three flawless corner-pencils that mean nothing.

Trains: perspective, line. Run it: `python3 -m http.server 8080` — no build,
no deps. Part of [Art Daily](https://artdaily.sadeali.com/) ·
[sadeali.com](https://sadeali.com/).
