/* ============================================================
   game.js — Box Check: the 250 Box Challenge with a feedback
   loop. Freehand a box one stroke per edge; each stroke is
   reduced to its dominant line (total-least-squares fit), the
   lines are clustered into 3 direction families, and each family
   is judged on how honestly it converges to a vanishing point.
   All scoring math lives in the PURE section — inputs in,
   0–100 out — so it stays unit-testable without a canvas.
   ============================================================ */
(function () {
  'use strict';

  var SLUG = 'box-check';
  var MIN_EDGES = 6;      /* "check it" unlocks here; a full box is 9–12 */
  var MAX_EDGES = 36;
  var MIN_STROKE = 30;    /* px — shorter strokes are ignored */
  var MERGE_DEG = 10;     /* families closer than this are one direction */

  /* ============================================================
     PURE scoring math — no canvas, no DOM below this banner
     until the "chrome" section. Everything takes plain numbers
     and returns plain objects.
     ============================================================ */

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function median(nums) {
    if (!nums.length) return 0;
    var s = nums.slice().sort(function (a, b) { return a - b; });
    var m = s.length >> 1;
    return (s.length % 2) ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /* distance between two directions, mod 180 (a line has no arrowhead) */
  function angleDistDeg(a, b) {
    var d = Math.abs(a - b) % 180;
    return Math.min(d, 180 - d);
  }

  /* Dominant line of a freehand stroke via PCA (total least squares —
     ordinary y-on-x regression would break on vertical strokes).
     Returns null for degenerate input. */
  function fitSegment(points) {
    var n = points.length, i, t;
    if (n < 2) return null;
    var mx = 0, my = 0;
    for (i = 0; i < n; i++) { mx += points[i].x; my += points[i].y; }
    mx /= n; my /= n;
    var sxx = 0, syy = 0, sxy = 0, ax, ay;
    for (i = 0; i < n; i++) {
      ax = points[i].x - mx; ay = points[i].y - my;
      sxx += ax * ax; syy += ay * ay; sxy += ax * ay;
    }
    var theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    var dx = Math.cos(theta), dy = Math.sin(theta);
    var tmin = Infinity, tmax = -Infinity;
    for (i = 0; i < n; i++) {
      t = (points[i].x - mx) * dx + (points[i].y - my) * dy;
      if (t < tmin) tmin = t;
      if (t > tmax) tmax = t;
    }
    return {
      mx: mx, my: my, dx: dx, dy: dy,
      angle: ((theta * 180 / Math.PI) % 180 + 180) % 180,
      len: tmax - tmin,
      x1: mx + tmin * dx, y1: my + tmin * dy,
      x2: mx + tmax * dx, y2: my + tmax * dy,
    };
  }

  function groupMeanAngle(angles, idxs) {
    /* circular mean mod 180 via doubled angles */
    var cx = 0, cy = 0, i, r;
    for (i = 0; i < idxs.length; i++) {
      r = angles[idxs[i]] * Math.PI / 90;
      cx += Math.cos(r); cy += Math.sin(r);
    }
    return ((Math.atan2(cy, cx) * 90 / Math.PI) % 180 + 180) % 180;
  }

  /* Split segment indices into 3 direction families minimizing total
     circular spread. Optimal clusters on a circle are contiguous arcs,
     so brute-forcing the C(n,3) cut positions over the sorted order is
     exact; prefix sums make each candidate O(1). */
  function clusterDirections(angles) {
    var n = angles.length, i;
    var order = [];
    for (i = 0; i < n; i++) order.push(i);
    order.sort(function (a, b) { return angles[a] - angles[b]; });
    if (n < 3) {
      return order.map(function (k) { return [k]; });
    }
    var px = [0], py = [0], r;
    for (i = 0; i < n; i++) {
      r = angles[order[i]] * Math.PI / 90;
      px.push(px[i] + Math.cos(r));
      py.push(py[i] + Math.sin(r));
    }
    var tx = px[n], ty = py[n];
    function arcCost(a, b) { /* order[a..b-1] */
      return (b - a) - Math.hypot(px[b] - px[a], py[b] - py[a]);
    }
    function wrapCost(c, a) { /* order[c..n-1] + order[0..a-1] */
      return (n - c + a) - Math.hypot(tx - (px[c] - px[a]), ty - (py[c] - py[a]));
    }
    var best = null, bestCost = Infinity, a, b, c, cost;
    for (a = 0; a < n - 2; a++) {
      for (b = a + 1; b < n - 1; b++) {
        for (c = b + 1; c < n; c++) {
          cost = arcCost(a, b) + arcCost(b, c) + wrapCost(c, a);
          if (cost < bestCost) { bestCost = cost; best = [a, b, c]; }
        }
      }
    }
    return [
      order.slice(best[0], best[1]),
      order.slice(best[1], best[2]),
      order.slice(best[2]).concat(order.slice(0, best[0])),
    ];
  }

  /* Angle clustering cannot separate a shallow box's left and right
     sets — near the horizon both straddle 0° mod 180 and interleave, so
     no contiguous arc splits them. The tell is ORIENTED direction:
     outward from the centroid (mod 360), a left-receding and a
     right-receding edge point opposite ways even when their line angles
     collide. */
  function orientedAngles(pool, segs, cx, cy) {
    var out = [], i, s, ox, oy, ex, ey;
    for (i = 0; i < pool.length; i++) {
      s = segs[pool[i]];
      ox = s.mx - cx; oy = s.my - cy;
      ex = s.dx; ey = s.dy;
      if (ex * ox + ey * oy < 0) { ex = -ex; ey = -ey; }
      out.push(((Math.atan2(ey, ex) * 180 / Math.PI) % 360 + 360) % 360);
    }
    return out;
  }

  function groupOrientedMean(g, segs, cx, cy, fallback) {
    var oa = orientedAngles(g, segs, cx, cy), sx = 0, sy = 0, i, r;
    for (i = 0; i < oa.length; i++) {
      r = oa[i] * Math.PI / 180;
      sx += Math.cos(r); sy += Math.sin(r);
    }
    /* a tiny resultant means the orientations cancel (a family that
       straddles the centroid, like verticals) — no honest side to name */
    if (Math.hypot(sx, sy) < 0.3 * oa.length) return fallback;
    return ((Math.atan2(sy, sx) * 180 / Math.PI) % 360 + 360) % 360;
  }

  function familyOf(g, segs, cx, cy, size) {
    var members = [], i;
    for (i = 0; i < g.length; i++) members.push(segs[g[i]]);
    return analyzeFamily(members, cx, cy, size);
  }

  /* angular miss (degrees) of a segment's line aiming at a point */
  function missDeg(s, p) {
    var d = Math.hypot(p.x - s.mx, p.y - s.my);
    if (d < 1e-6) return 0;
    var aim = ((Math.atan2(p.y - s.my, p.x - s.mx) * 180 / Math.PI) % 180 + 180) % 180;
    return angleDistDeg(aim, s.angle);
  }

  /* Is this pool of same-angled lines genuinely TWO edge sets (a shallow
     box's left + right) rather than one sloppy bundle? Seed a candidate
     VP from every pair of lines, gather the members that aim at it
     (angular miss < 3.5°), and accept only when BOTH resulting lobes
     converge coherently to VPs on opposite sides of the box — one
     bundle of near-parallel scribble can't do that (its lobes read
     "parallel" or spray). Midpoint position deliberately plays no part:
     a transparent box's hidden edges sit across the centroid from their
     own set. Returns the two lobes, or null. */
  function genuineTwoSets(pool, segs, cx, cy, size) {
    var n = pool.length, i, j, k, vp, la, lb, oa;
    var best = null, bestQ = -1;
    if (n < 4) return null;
    function segsOf(g) {
      var out = [], m;
      for (m = 0; m < g.length; m++) out.push(segs[g[m]]);
      return out;
    }
    /* Occam gate: if the pool already reads well as ONE family, a
       two-set reading must clearly beat it — otherwise a noisy single
       set gets carved into two unfalsifiable 2-line lobes. */
    var one = familyOf(pool, segs, cx, cy, size);
    var beat = one.score + 10;
    function consider(la0, lb0) {
      var la = la0, lb = lb0, na, nb, va, vb, fa, fb, it, dot, q;
      if (la.length < 2 || lb.length < 2) return;
      /* 2-means refinement: a shallow box's centre edges lie almost on
         the horizon and aim at BOTH VPs — re-deal each edge to the VP
         it misses least until stable */
      for (it = 0; it < 4; it++) {
        va = bestFitVP(segsOf(la));
        vb = bestFitVP(segsOf(lb));
        if (!va || !vb) break;
        na = []; nb = [];
        for (k = 0; k < n; k++) {
          (missDeg(segs[pool[k]], va) <= missDeg(segs[pool[k]], vb) ? na : nb).push(pool[k]);
        }
        if (na.length < 2 || nb.length < 2) break;
        if (na.length === la.length && String(na) === String(la)) break;
        la = na; lb = nb;
      }
      if (la.length < 2 || lb.length < 2) return;
      fa = familyOf(la, segs, cx, cy, size);
      fb = familyOf(lb, segs, cx, cy, size);
      if (fa.verdict !== 'converging' || fb.verdict !== 'converging') return;
      if (fa.score < 50 || fb.score < 50) return;
      if (Math.min(fa.score, fb.score) < beat) return;
      dot = (fa.vp.x - cx) * (fb.vp.x - cx) + (fa.vp.y - cy) * (fb.vp.y - cy);
      if (dot >= 0) return; /* VPs crowd one side — no box does that */
      q = fa.score + fb.score;
      if (q > bestQ) { bestQ = q; best = [la, lb]; }
    }
    /* seed 1: oriented lobes — pointing-left vs pointing-right members
       (a visible-edge box's sets sit on their own side of the box) */
    oa = orientedAngles(pool, segs, cx, cy);
    la = []; lb = [];
    for (k = 0; k < n; k++) {
      (oa[k] > 90 && oa[k] < 270 ? la : lb).push(pool[k]);
    }
    consider(la, lb);
    /* seeds 2…: every pair of lines proposes its own VP */
    for (i = 0; i < n; i++) {
      for (j = i + 1; j < n; j++) {
        vp = bestFitVP([segs[pool[i]], segs[pool[j]]]);
        if (!vp) continue;
        la = []; lb = [];
        for (k = 0; k < n; k++) {
          (missDeg(segs[pool[k]], vp) < 3.5 ? la : lb).push(pool[k]);
        }
        if (la.length < 2 || lb.length < 2) {
          /* lopsided threshold split (noisy seed) — start from just the
             seed pair vs the rest and let the refinement sort them */
          la = [pool[i], pool[j]];
          lb = [];
          for (k = 0; k < n; k++) {
            if (pool[k] !== pool[i] && pool[k] !== pool[j]) lb.push(pool[k]);
          }
        }
        consider(la, lb);
      }
    }
    return best;
  }

  /* Groups within MERGE_DEG of each other are either one direction drawn
     twice (6 near-identical strokes must not fake 3 families — fold them)
     or a shallow box's two real sets (keep those, after re-dealing any
     interleaved members to their true side). */
  function resolveDirections(groups, segs, angles, tol, cx, cy, size) {
    var i, j, pool, lobes, merged = true;
    /* re-deal pass: genuine close pairs get members re-dealt by side */
    for (i = 0; i < groups.length; i++) {
      for (j = i + 1; j < groups.length; j++) {
        if (angleDistDeg(groupMeanAngle(angles, groups[i]), groupMeanAngle(angles, groups[j])) >= tol) continue;
        pool = groups[i].concat(groups[j]);
        lobes = genuineTwoSets(pool, segs, cx, cy, size);
        if (lobes) { groups[i] = lobes[0]; groups[j] = lobes[1]; }
      }
    }
    /* merge pass: close pairs that are not genuinely two sets fold together */
    while (merged && groups.length > 1) {
      merged = false;
      for (i = 0; i < groups.length && !merged; i++) {
        for (j = i + 1; j < groups.length && !merged; j++) {
          if (angleDistDeg(groupMeanAngle(angles, groups[i]), groupMeanAngle(angles, groups[j])) >= tol) continue;
          pool = groups[i].concat(groups[j]);
          if (genuineTwoSets(pool, segs, cx, cy, size)) continue;
          groups[i] = pool;
          groups.splice(j, 1);
          merged = true;
        }
      }
    }
    /* deal pass: a sloppy shallow box can land BOTH its horizontal sets
       in one angular cluster — if we came out short of three families,
       deal any wide bundle into genuine opposite lobes */
    for (i = 0; groups.length < 3 && i < groups.length; i++) {
      if (groups[i].length < 4) continue;
      lobes = genuineTwoSets(groups[i], segs, cx, cy, size);
      if (lobes) {
        groups.splice(i, 1, lobes[0], lobes[1]);
        i = -1; /* rescan from the top */
      }
    }
    return groups;
  }

  /* Best-fit VP of a pencil of lines: the point minimizing summed
     squared PERPENDICULAR distance to every infinite line (2×2 normal
     equations). Pairwise intersections are ill-conditioned for
     near-parallel lines — they slide hundreds of px along the pencil's
     axis for a fraction of a degree — while the perpendicular residual
     stays honest. Null = parallel pencil (VP at infinity). */
  function bestFitVP(segs) {
    var a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0, i, nx, ny, d;
    for (i = 0; i < segs.length; i++) {
      nx = -segs[i].dy; ny = segs[i].dx;
      d = nx * segs[i].mx + ny * segs[i].my;
      a11 += nx * nx; a12 += nx * ny; a22 += ny * ny;
      b1 += nx * d; b2 += ny * d;
    }
    var det = a11 * a22 - a12 * a12;
    if (Math.abs(det) < 1e-9) return null;
    return { x: (a22 * b1 - a12 * b2) / det, y: (a11 * b2 - a12 * b1) / det };
  }

  /* The classic mistake: a family whose lines meet on the WRONG side —
     the set sits on one side of the box and recedes away from it, yet
     its common point lands back across the box (far edge drawn longer
     than near edge). Only the family's overall position says which side
     it recedes toward: single edges sit perpendicular-offset from the
     centroid (a box's verticals straddle it left and right), so judge
     by the family's MEAN midpoint. A family centred on the box (mean
     offset under 15% of the drawing) has no honest side — no verdict. */
  function wrongSideOfBox(segs, vp, cx, cy, size) {
    var i, ox = 0, oy = 0;
    for (i = 0; i < segs.length; i++) { ox += segs[i].mx - cx; oy += segs[i].my - cy; }
    ox /= segs.length; oy /= segs.length;
    var ol = Math.hypot(ox, oy);
    if (ol < 0.15 * size) return false;
    var vx = vp.x - cx, vy = vp.y - cy;
    var vl = Math.hypot(vx, vy);
    if (vl < 1e-6) return false;
    return (ox * vx + oy * vy) / (ol * vl) < -0.3;
  }

  /* One family → verdict + 0–100 score.
       missing   (<2 lines)  → 25
       parallel  → 85 (VP near infinity — fine). Requires BOTH a
                   best-fit VP beyond 8× the box size and genuinely
                   near-parallel members (within 4° of each other) — a
                   noisy fan whose VP lands far away must not be
                   promoted to "parallel — fine".
       converging: VP = least-squares best fit; the error is the median
                   ANGULAR miss (extend each stroke — by how many
                   degrees does it miss the shared VP?), which stays
                   honest and monotone where raw intersection scatter is
                   ill-conditioned: score = 100·(1 − miss°/11). A
                   2-line family is capped at 80 — two lines meet
                   *somewhere* by definition, so they can never prove a
                   tight VP (the hint says a full box is 9–12 edges).
       diverging: converging score · 0.35, capped at 30 */
  function analyzeFamily(segs, cx, cy, size) {
    if (segs.length < 2) return { verdict: 'missing', score: 25, vp: null, spread: 0 };
    var i;
    var meanA = (function () {
      var sx = 0, sy = 0, r;
      for (i = 0; i < segs.length; i++) {
        r = segs[i].angle * Math.PI / 90;
        sx += Math.cos(r); sy += Math.sin(r);
      }
      return ((Math.atan2(sy, sx) * 90 / Math.PI) % 180 + 180) % 180;
    })();
    var maxDev = 0;
    for (i = 0; i < segs.length; i++) {
      maxDev = Math.max(maxDev, angleDistDeg(segs[i].angle, meanA));
    }
    var vp = bestFitVP(segs);
    if (!vp) return { verdict: 'parallel', score: 85, vp: null, spread: 0 };
    if (maxDev < 4 && Math.hypot(vp.x - cx, vp.y - cy) > 8 * size) {
      return { verdict: 'parallel', score: 85, vp: null, spread: 0 };
    }
    var miss = [], aim, d;
    for (i = 0; i < segs.length; i++) {
      d = Math.hypot(vp.x - segs[i].mx, vp.y - segs[i].my);
      if (d < 1e-6) continue;
      aim = ((Math.atan2(vp.y - segs[i].my, vp.x - segs[i].mx) * 180 / Math.PI) % 180 + 180) % 180;
      miss.push(angleDistDeg(aim, segs[i].angle));
    }
    var spread = median(miss); /* degrees of miss, 0 = razor-tight */
    var score = 100 * clamp(1 - spread / 11, 0, 1);
    if (segs.length === 2) score = Math.min(score, 80);
    if (wrongSideOfBox(segs, vp, cx, cy, size)) {
      return { verdict: 'diverging', score: clamp(score * 0.35, 0, 30), vp: vp, spread: spread };
    }
    return { verdict: 'converging', score: score, vp: vp, spread: spread };
  }

  /* Second divergence detector: two families whose VPs sit in nearly the
     same direction from the box is the broken-box signature — a real
     box's vanishing points never crowd one side (a centred family dodges
     the mean-midpoint test, but its false VP still lands next to a
     neighbour's). Blame the family whose convergence is looser. */
  function crossCheckDivergence(fams, cx, cy) {
    var i, j, a, b, ax, ay, bx, by, la, lb, worse;
    for (i = 0; i < fams.length; i++) {
      for (j = i + 1; j < fams.length; j++) {
        a = fams[i]; b = fams[j];
        if (!a.vp || !b.vp) continue;
        ax = a.vp.x - cx; ay = a.vp.y - cy; la = Math.hypot(ax, ay);
        bx = b.vp.x - cx; by = b.vp.y - cy; lb = Math.hypot(bx, by);
        if (la < 1 || lb < 1) continue;
        if ((ax * bx + ay * by) / (la * lb) <= 0.82) continue; /* ≳35° apart — fine */
        worse = (a.spread >= b.spread) ? a : b;
        if (worse.verdict !== 'diverging') {
          worse.verdict = 'diverging';
          worse.score = clamp(worse.score * 0.35, 0, 30);
        }
      }
    }
  }

  /* Name the families relative to each other: the one nearest vertical
     (within 30°) is "verticals"; the rest read by which side they recede
     toward (their oriented direction, so a shallow box still gets an
     honest "left set" and "right set"). Shared sides get steeper/flatter
     suffixes so no two rows read identically. */
  function assignLabels(means, phis) {
    var i, j, vIdx = -1, vBest = 31, d, labels = [];
    for (i = 0; i < means.length; i++) {
      d = angleDistDeg(means[i], 90);
      if (d < vBest) { vBest = d; vIdx = i; }
    }
    for (i = 0; i < means.length; i++) {
      if (i === vIdx) labels.push({ key: 'v', label: '↕ verticals' });
      else if (phis[i] > 90 && phis[i] < 270) labels.push({ key: 'l', label: '← left set' });
      else labels.push({ key: 'r', label: '→ right set' });
    }
    var keys = ['l', 'r'], dup, steep, k;
    for (k = 0; k < keys.length; k++) {
      dup = [];
      for (i = 0; i < labels.length; i++) if (labels[i].key === keys[k]) dup.push(i);
      if (dup.length < 2) continue;
      steep = dup[0];
      for (j = 1; j < dup.length; j++) {
        if (angleDistDeg(means[dup[j]], 90) < angleDistDeg(means[steep], 90)) steep = dup[j];
      }
      for (j = 0; j < dup.length; j++) {
        labels[dup[j]].label += (dup[j] === steep) ? ' (steeper)' : ' (flatter)';
      }
    }
    return labels;
  }

  function missingLabel(existing) {
    var i;
    for (i = 0; i < existing.length; i++) if (existing[i].key === 'v') {
      return { key: '?', label: '• third set' };
    }
    return { key: 'v', label: '↕ verticals' };
  }

  /* Whole drawing → { score, families[3], cx, cy, size }.
     Round score is the plain mean of the 3 family scores. */
  function analyzeBox(segs) {
    var i, angles = [], xs = [], ys = [];
    for (i = 0; i < segs.length; i++) {
      angles.push(segs[i].angle);
      xs.push(segs[i].x1, segs[i].x2);
      ys.push(segs[i].y1, segs[i].y2);
    }
    var minx = Math.min.apply(null, xs), maxx = Math.max.apply(null, xs);
    var miny = Math.min.apply(null, ys), maxy = Math.max.apply(null, ys);
    var size = Math.max(40, maxx - minx, maxy - miny);
    var cx = 0, cy = 0;
    for (i = 0; i < segs.length; i++) { cx += segs[i].mx; cy += segs[i].my; }
    cx /= segs.length; cy /= segs.length;

    var groups = resolveDirections(clusterDirections(angles), segs, angles, MERGE_DEG, cx, cy, size);
    var fams = [], means = [], phis = [], g, members, j, res, lab, labels;
    for (i = 0; i < groups.length && i < 3; i++) {
      g = groups[i];
      members = [];
      for (j = 0; j < g.length; j++) members.push(segs[g[j]]);
      res = analyzeFamily(members, cx, cy, size);
      means.push(groupMeanAngle(angles, g));
      phis.push(groupOrientedMean(g, segs, cx, cy, means[means.length - 1]));
      fams.push({
        idxs: g, count: g.length,
        verdict: res.verdict, score: res.score, vp: res.vp, spread: res.spread,
      });
    }
    crossCheckDivergence(fams, cx, cy);
    labels = assignLabels(means, phis);
    for (i = 0; i < fams.length; i++) {
      fams[i].key = labels[i].key;
      fams[i].label = labels[i].label;
    }
    while (fams.length < 3) {
      lab = missingLabel(fams);
      fams.push({
        idxs: [], count: 0, key: lab.key, label: lab.label,
        verdict: 'missing', score: 25, vp: null, spread: 0,
      });
    }
    var rank = { l: 0, v: 1, r: 2, '?': 3 };
    fams.sort(function (p, q) { return (rank[p.key] || 0) - (rank[q.key] || 0); });
    var total = (fams[0].score + fams[1].score + fams[2].score) / 3;
    return { score: Math.round(total), families: fams, cx: cx, cy: cy, size: size };
  }

  /* one honest critique line per family */
  function verdictFor(f) {
    if (f.verdict === 'missing') {
      if (f.count === 1) return { cls: 'bad', text: 'only one stroke this way — a box needs 2+ per direction' };
      return { cls: 'bad', text: 'missing — a box has edges going three ways' };
    }
    if (f.verdict === 'parallel') return { cls: 'meh', text: 'parallel — fine (VP near infinity)' };
    if (f.verdict === 'diverging') return { cls: 'bad', text: 'DIVERGES ✗ — your far edge is longer than your near edge' };
    /* spread = median angular miss of the shared VP, in degrees */
    if (f.spread < 1) return { cls: 'good', text: 'converges ✓ tight' };
    if (f.spread < 2.5) return { cls: 'good', text: 'converges ✓ pretty clean' };
    if (f.spread < 6) return { cls: 'meh', text: 'converges — loose, your lines miss a shared VP' };
    return { cls: 'meh', text: 'barely converges — extensions spray everywhere' };
  }

  /* ============================================================
     chrome — canvas, input, HUD (impure world starts here)
     ============================================================ */

  var canvas = document.getElementById('gameCanvas');
  var ctx = canvas.getContext('2d');
  var hint = document.getElementById('hint');
  var toast = document.getElementById('toast');
  var hudRound = document.getElementById('hudRound');
  var hudScore = document.getElementById('hudScore');
  var hudBest = document.getElementById('hudBest');
  var edgeCount = document.getElementById('edgeCount');
  var btnCheck = document.getElementById('btnCheck');
  var btnClear = document.getElementById('btnClear');
  var critique = document.getElementById('critique');

  ArtDaily.init({ slug: SLUG });

  /* ---- theme-aware inks (re-read on every repaint) ---- */
  function mixHex(a, b, t) {
    /* color-mix(in srgb, a t, b 1-t) for #rgb/#rrggbb strings */
    function ch(h) {
      h = h.replace('#', '');
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    var A = ch(a), B = ch(b), i, out = [];
    for (i = 0; i < 3; i++) {
      if (isNaN(A[i]) || isNaN(B[i])) return b;
      out.push(Math.round(A[i] * t + B[i] * (1 - t)));
    }
    return 'rgb(' + out[0] + ',' + out[1] + ',' + out[2] + ')';
  }

  function inks() {
    var cs = getComputedStyle(document.documentElement);
    var ink = cs.getPropertyValue('--ink').trim();
    var accent = cs.getPropertyValue('--game-accent').trim() || cs.getPropertyValue('--coral').trim();
    return {
      ink: ink,
      muted: cs.getPropertyValue('--muted').trim(),
      accent: accent,
      /* accent text needs inking toward graphite on paper for AA
         contrast (same recipe as the CSS: accent 55% into ink);
         on the dark sheet pure accent already passes */
      accentText: ArtDaily.theme() === 'dark' ? accent : mixHex(accent, ink, 0.55),
    };
  }

  /* ---- crisp canvas at any devicePixelRatio; height tracks width ---- */
  var W = 0, H = 0;
  function fitCanvas() {
    var rect = canvas.getBoundingClientRect();
    W = Math.max(1, Math.round(rect.width));
    H = Math.round(W * 0.7);
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ---- round state ---- */
  var round = 0;
  var phase = 'draw';        /* 'draw' | 'result' */
  var strokes = [];          /* accepted: { pts, seg } */
  var live = null;           /* in-progress polyline */
  var activePointer = null;  /* pointerId guard */
  var result = null;         /* analyzeBox output, drives the reveal */

  function updateBar() {
    edgeCount.textContent = 'edges: ' + strokes.length;
    btnCheck.disabled = (phase !== 'draw') || (strokes.length < MIN_EDGES);
  }

  function newRound() {
    round += 1;
    strokes = [];
    live = null;
    result = null;
    phase = 'draw';
    critique.hidden = true;
    critique.textContent = '';
    hudRound.textContent = String(round);
    hudScore.textContent = '–';
    hint.textContent = 'draw a 3D box, one straight stroke per edge — ' + MIN_EDGES + ' minimum, a full box is 9–12.';
    updateBar();
    draw();
  }

  function clearBox() {
    if (phase === 'result') { newRound(); return; }
    strokes = [];
    live = null;
    hint.textContent = 'cleared — fresh box, same round.';
    updateBar();
    draw();
  }

  /* ---- painting (canvas bg stays clear so the CSS dot-grid shows) ---- */
  function draw() {
    var c = inks(), i, j, pts;
    ctx.clearRect(0, 0, W, H);
    if (result) drawReveal(c);
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 2.25;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (i = 0; i < strokes.length; i++) {
      pts = strokes[i].pts;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (j = 1; j < pts.length; j++) ctx.lineTo(pts[j].x, pts[j].y);
      ctx.stroke();
    }
    if (live && live.length > 1) {
      ctx.beginPath();
      ctx.moveTo(live[0].x, live[0].y);
      for (j = 1; j < live.length; j++) ctx.lineTo(live[j].x, live[j].y);
      ctx.stroke();
    }
  }

  function drawReveal(c) {
    var i, f, s, L = W + H;
    /* every stroke's fitted line, extended faintly across the sheet */
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.strokeStyle = c.muted;
    ctx.lineWidth = 1;
    for (i = 0; i < strokes.length; i++) {
      s = strokes[i].seg;
      ctx.beginPath();
      ctx.moveTo(s.mx - L * s.dx, s.my - L * s.dy);
      ctx.lineTo(s.mx + L * s.dx, s.my + L * s.dy);
      ctx.stroke();
    }
    ctx.restore();
    for (i = 0; i < result.families.length; i++) {
      f = result.families[i];
      if (f.vp) drawVP(c, f.vp, f.verdict === 'diverging');
    }
  }

  function drawVP(c, vp, isDiverging) {
    var m = 12, tag = isDiverging ? '✗ vp' : 'vp';
    ctx.save();
    ctx.fillStyle = c.accent;
    ctx.strokeStyle = c.accent;
    ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    if (vp.x >= m && vp.x <= W - m && vp.y >= m && vp.y <= H - m) {
      ctx.beginPath();
      ctx.arc(vp.x, vp.y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(vp.x, vp.y, 9, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = c.accentText;
      ctx.fillText(tag, vp.x, vp.y - 14);
      ctx.restore();
      return;
    }
    /* off-sheet VP: arrow at the canvas edge pointing toward it */
    var ux = vp.x - result.cx, uy = vp.y - result.cy;
    var ul = Math.hypot(ux, uy);
    if (ul < 1e-6) { ctx.restore(); return; }
    ux /= ul; uy /= ul;
    var t = Infinity;
    if (ux > 1e-9) t = Math.min(t, (W - m - result.cx) / ux);
    if (ux < -1e-9) t = Math.min(t, (m - result.cx) / ux);
    if (uy > 1e-9) t = Math.min(t, (H - m - result.cy) / uy);
    if (uy < -1e-9) t = Math.min(t, (m - result.cy) / uy);
    if (!isFinite(t) || t <= 0) { ctx.restore(); return; }
    var ex = result.cx + ux * t, ey = result.cy + uy * t;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ex - ux * 22, ey - uy * 22);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    /* arrowhead */
    var px = -uy, py = ux;
    ctx.beginPath();
    ctx.moveTo(ex - ux * 7 + px * 5, ey - uy * 7 + py * 5);
    ctx.lineTo(ex, ey);
    ctx.lineTo(ex - ux * 7 - px * 5, ey - uy * 7 - py * 5);
    ctx.stroke();
    ctx.fillStyle = c.accentText;
    ctx.fillText(tag, ex - ux * 34, ey - uy * 34 + 4);
    ctx.restore();
  }

  /* ---- freehand stroke capture (pointerId-guarded) ---- */
  function pointerPos(ev) {
    var rect = canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  canvas.addEventListener('pointerdown', function (ev) {
    if (phase !== 'draw' || activePointer !== null) return;
    ev.preventDefault();
    activePointer = ev.pointerId;
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
    live = [pointerPos(ev)];
    draw();
  });

  canvas.addEventListener('pointermove', function (ev) {
    if (ev.pointerId !== activePointer || !live) return;
    ev.preventDefault();
    live.push(pointerPos(ev));
    draw();
  });

  canvas.addEventListener('pointerup', function (ev) {
    if (ev.pointerId !== activePointer) return;
    ev.preventDefault();
    finishStroke();
  });

  canvas.addEventListener('pointercancel', function (ev) {
    if (ev.pointerId !== activePointer) return;
    live = null;
    activePointer = null;
    draw();
  });

  function finishStroke() {
    var seg = live ? fitSegment(live) : null;
    if (seg && seg.len >= MIN_STROKE && strokes.length < MAX_EDGES) {
      strokes.push({ pts: live, seg: seg });
      if (strokes.length === MIN_EDGES) {
        hint.textContent = '“check it ✓” is live — more edges give the critique more to chew on.';
      } else if (strokes.length >= MAX_EDGES) {
        hint.textContent = 'that is plenty of edges — check it.';
      }
    } else if (seg && seg.len < MIN_STROKE) {
      hint.textContent = 'stroke ignored — an edge wants ' + MIN_STROKE + 'px+ of committed line.';
    } else if (seg) {
      hint.textContent = 'that is plenty of edges — check it.';
    }
    live = null;
    activePointer = null;
    updateBar();
    draw();
  }

  /* ---- check → critique → reveal → report (exactly once) ---- */
  function checkBox() {
    if (phase !== 'draw' || strokes.length < MIN_EDGES) return;
    phase = 'result';
    var segs = [], i;
    for (i = 0; i < strokes.length; i++) segs.push(strokes[i].seg);
    result = analyzeBox(segs);
    renderCritique(result);
    draw();
    var res = ArtDaily.report(result.score);
    hudScore.textContent = String(res.score);
    hudBest.textContent = res.best === null ? '–' : String(res.best);
    hint.textContent = 'the reveal is in coral — every line extended, each set’s VP. “new round” for the next box.';
    updateBar();
    showToast((res.isNewBest ? 'new best! ' : 'score ') + res.score + ' / 100', res.isNewBest);
  }

  function renderCritique(r) {
    critique.textContent = '';
    var i, f, v, row, axis, verdict, score;
    for (i = 0; i < r.families.length; i++) {
      f = r.families[i];
      v = verdictFor(f);
      row = document.createElement('p');
      row.className = 'crit-row';
      axis = document.createElement('span');
      axis.className = 'crit-axis';
      axis.textContent = f.label + ': ';
      verdict = document.createElement('span');
      verdict.className = 'crit-' + v.cls;
      verdict.textContent = v.text;
      score = document.createElement('span');
      score.className = 'crit-score';
      score.textContent = ' · ' + Math.round(f.score);
      row.appendChild(axis);
      row.appendChild(verdict);
      row.appendChild(score);
      critique.appendChild(row);
    }
    critique.hidden = false;
  }

  var toastTimer = null;
  function showToast(msg, celebrate) {
    toast.innerHTML = '';
    var s = document.createElement('span');
    s.className = celebrate ? 'toast-accent' : '';
    s.textContent = msg;
    toast.appendChild(s);
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.hidden = true; }, 2200);
  }

  /* ---- chrome wiring ---- */
  document.getElementById('btnRound').addEventListener('click', newRound);
  btnCheck.addEventListener('click', checkBox);
  btnClear.addEventListener('click', clearBox);

  var btnHow = document.getElementById('btnHow');
  var howTo = document.getElementById('howTo');
  btnHow.addEventListener('click', function () {
    howTo.hidden = !howTo.hidden;
    btnHow.setAttribute('aria-expanded', String(!howTo.hidden));
  });

  ArtDaily.onTheme(draw);
  window.addEventListener('resize', function () { fitCanvas(); draw(); });

  /* ---- boot ---- */
  fitCanvas();
  var best = ArtDaily.best();
  hudBest.textContent = best === null ? '–' : String(best);
  newRound();
})();
