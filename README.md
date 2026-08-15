# Box Check 📦

The 250 Box Challenge with a feedback loop. Freehand a 3D box one stroke
per edge; each stroke is reduced to its dominant line, the lines are
clustered into three direction families, and each family is scored on how
honestly it converges: a tight vanishing point scores toward 100, parallel
edges score 85 (VP near infinity — fine), diverging edges — the classic
mistake — cap at 30. The round score is the mean of the three families,
and the reveal extends every line and inks each VP so you see the delta.

Trains: perspective, line. Run it: `python3 -m http.server 8080` — no build,
no deps. Part of [Art Daily](https://artdaily.sadeali.com/) ·
[sadeali.com](https://sadeali.com/).
