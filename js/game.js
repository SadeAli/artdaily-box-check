/* ============================================================
   game.js — Box Check: the 250 Box Challenge with a feedback
   loop. Freehand a box one stroke per edge; each stroke is
   reduced to its dominant line (total-least-squares fit), the
   lines are sorted into 3 direction families by the VANISHING
   POINT they share, and each family is judged on how honestly
   it converges to it. The three families are then held to the
   one thing a real box cannot fake: they must admit a real
   pinhole camera, whose principal point and focal length are
   read off the drawing as the orthocenter of the VP triangle.

   Grouping is by VP and not by image angle on purpose — a single
   3D direction fans across 40°+ of image angle under ordinary
   perspective, so angle clustering cannot separate the axes.

   All scoring math lives in the PURE section — inputs in,
   0–100 out — so it stays unit-testable without a canvas.
   ============================================================ */
(function () {
  'use strict';

  var SLUG = 'box-check';
  var MIN_EDGES = 6;      /* "check it" unlocks here; a full box is 9–12 */
  var MAX_EDGES = 36;
  /* An edge floor in absolute px is an edge floor that doubles on a
     phone: 30px was 43% of a 70px phone edge, so genuine short edges
     were thrown away as taps. */
  var MIN_STROKE_FLOOR = 18;
  var MIN_STROKE_FRAC = 0.045;
  var MAX_BEND = 0.16;    /* stroke bend / length — above this it is a curve */
  var VP_TOL = 6;         /* degrees, PEN reference — a stroke "aims at" a VP
                             within this. Eased per input mode, capped so a
                             looser grouping never swallows everything. */
  var VP_TOL_CAP = 12;
  var MIN_F = 0.55;       /* focal / drawing size below which the implied
                             camera is a fisheye, i.e. not a box at all */
  /* Round cap when the three sets admit no camera. It stays at 30
     because it is the only thing standing between a fan of scribble and
     a passing score — three pencils always meet SOMEWHERE. What changed
     is how often it fires on an honest drawing: it is now held back on
     a first-ever visit, and withheld entirely when the grouper starved
     a family on otherwise tidy lines (see analyzeBox). */
  var NOT_A_BOX = 30;
  /* A diverging set keeps the tier it always had. The audit's objection
     to it was how OFTEN it fired on honest work and how it was worded,
     not the number: the frequency is handled by cameraNearMiss and the
     starved-sort guard, and the wording by verdictFor. Softening the
     number as well would just pay a scribble. */
  var DIVERGE_MUL = 0.35;
  var DIVERGE_CAP = 30;
  var CORNER_NEAR = 0.16;  /* shared point this close to its own strokes is
                             a box corner, not a vanishing point */
  /* The same idea used for SCORING rather than for choosing a grouping,
     and set where it actually separates the two populations: measured
     over 300 rounds each, a shared point inside 0.25 × the drawing
     turns up in 87% of random-line scribbles and 0–7% of honest boxes. */
  var CROSS_NEAR = 0.25;
  var CORNER_COST = 30;   /* degrees charged per stroke for reading one */
  var FREE_DEG = 0.5;     /* median miss inside this is as tight as a hand gets */
  var REF_LEN = 150;      /* px — the desktop edge the pen reference was set on */
  var ZERO_SPAN = 7.5;    /* degrees past the free zone that score 0 for a PEN
                             at REF_LEN — i.e. exactly the old constant */
  var ZERO_MIN = 3;       /* degrees — floors for absurd edge lengths */
  var ZERO_MAX = 22;
  var PAIR_SCORE = 70;    /* a 2-stroke family: honest, but unproven */
  var EDGE_FULL = 9;      /* edges at which a box counts as complete */
  var MISSING_SCORE = 25;
  var CROSSING_SCORE = 35;  /* lines that meet ON each other, not far off */

  /* ============================================================
     PURE scoring math — no canvas, no DOM below this banner
     until the "chrome" section. Everything takes plain numbers
     and returns plain objects.
     ============================================================ */

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* ---- how much miss this hardware, at this size, is allowed ----
     Every number the scorer measures is an ANGLE, but the hand's error
     is PIXELS, and the two are only the same thing at one edge length.
     The identical 6px wobble subtends 2.3° on a 150px desktop edge and
     4.9° on a 70px phone edge — which is why the same hand scored 76
     and 41 for the same drawing. And 8° to zero was a pen-tablet
     tolerance in the first place: a mouse cannot hold a family of
     freehand edges to a shared point inside it, and nothing about the
     lesson requires the zero point to sit where a mouse cannot reach.

     So the tolerance is expressed as PIXELS OF SLOP and converted to
     degrees at the edge lengths actually drawn. SLOP_PX is pinned to
     the old constant — 150·tan(7.5°) ≈ 19.7px — so a pen on a desktop
     box gets exactly the standard it had, and every other combination
     of hardware and canvas size is that same physical slop.

     Pure: hand it 1 and a 150px edge and the old ramp comes back. */
  var SLOP_PX = REF_LEN * Math.tan(ZERO_SPAN * Math.PI / 180);

  function byLength(slopPx, len) {
    return Math.atan(slopPx / len) * 180 / Math.PI;
  }

  function convergeTol(easeMul, medianLen) {
    var m = (typeof easeMul === 'number' && easeMul > 0 && isFinite(easeMul)) ? easeMul : 1;
    var len = (medianLen > 8 && isFinite(medianLen)) ? medianLen : REF_LEN;
    /* The LOOSER of the two, never the stricter. Long edges do show the
       same pixel slop as a smaller angle, but tightening the standard on
       somebody for drawing a big box would be a new punishment invented
       in the name of fairness. The pen reference is a floor; the length
       term only ever opens it up, which is what a short phone edge
       needs. */
    var span = clamp(Math.max(byLength(SLOP_PX * m, len), ZERO_SPAN * m), ZERO_MIN, ZERO_MAX);
    /* The GROUPING tolerance has to travel with the scoring one. Left at
       a flat 6°, short phone edges (whose every error is a bigger angle)
       got dealt to the wrong family — and being dealt to the wrong
       family is what produced the "DIVERGES ✗" the audit found on 46%
       of honest trackpad rounds. */
    return {
      freeDeg: FREE_DEG,
      zeroDeg: FREE_DEG + span,
      vpTol: Math.min(VP_TOL * span / ZERO_SPAN, VP_TOL_CAP),
      /* the same span with NO easing — a confidence yardstick, not a
         fairness one. How tight a reading has to be before it is
         allowed to accuse anybody (see analyzeBox). */
      tidyDeg: 0.4 * clamp(Math.max(byLength(SLOP_PX, len), ZERO_SPAN), ZERO_MIN, ZERO_MAX)
    };
  }

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

  /* RMS perpendicular deviation of a polyline from its fitted line —
     a big value means the "edge" bends (the classic whole-box-in-one-
     stroke mistake). Pure: points + fitted seg in, px out. */
  function strokeBendRMS(points, seg) {
    var i, d, sum = 0;
    if (!points.length || !seg) return 0;
    for (i = 0; i < points.length; i++) {
      d = (points[i].x - seg.mx) * -seg.dy + (points[i].y - seg.my) * seg.dx;
      sum += d * d;
    }
    return Math.sqrt(sum / points.length);
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

  function segsOf(idxs, segs) {
    var out = [], i;
    for (i = 0; i < idxs.length; i++) out.push(segs[idxs[i]]);
    return out;
  }

  /* Cut the direction circle (mod 180°) at its `want` widest gaps, so
     the members of each arc share an image angle. This is the honest
     tool for PARALLEL bundles only — lines that recede to a real
     vanishing point fan out in angle and must be grouped by their VP
     instead (see groupByVP). */
  function angleGroups(idxs, segs, want) {
    var i, t, ord = idxs.slice(), out = [], run = [];
    if (want < 1) want = 1;
    ord.sort(function (a, b) { return segs[a].angle - segs[b].angle; });
    if (ord.length <= want) {
      for (i = 0; i < ord.length; i++) out.push([ord[i]]);
      return out;
    }
    var gaps = [], a, b;
    for (i = 0; i < ord.length; i++) {
      a = segs[ord[i]].angle;
      b = segs[ord[(i + 1) % ord.length]].angle;
      gaps.push({ at: i, g: (i === ord.length - 1) ? (b + 180 - a) : (b - a) });
    }
    gaps.sort(function (p, q) { return q.g - p.g; });
    var cuts = [];
    for (i = 0; i < want; i++) cuts.push(gaps[i].at);
    cuts.sort(function (p, q) { return p - q; });
    /* walk the ring starting just after a cut so every arc closes */
    var start = (cuts[cuts.length - 1] + 1) % ord.length, idx;
    for (t = 0; t < ord.length; t++) {
      idx = (start + t) % ord.length;
      run.push(ord[idx]);
      if (cuts.indexOf(idx) !== -1) { out.push(run); run = []; }
    }
    if (run.length) out.push(run);
    return out;
  }

  /* Which way does a set RECEDE? Used only to name the rows, and only
     oriented direction can say: a shallow box's left and right sets sit
     at nearly the same line angle (both near the horizon, mod 180), but
     pointing outward from the centroid mod 360 they aim opposite ways. */
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

  /* angular miss (degrees) of a segment's line aiming at a point */
  function missDeg(s, p) {
    var d = Math.hypot(p.x - s.mx, p.y - s.my);
    if (d < 1e-6) return 0;
    var aim = ((Math.atan2(p.y - s.my, p.x - s.mx) * 180 / Math.PI) % 180 + 180) % 180;
    return angleDistDeg(aim, s.angle);
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

  /* A usable meeting point for any family: the best-fit VP, or — when
     the pencil is exactly parallel and has none — a synthetic point far
     down the family's mean direction, so "which VP does this stroke aim
     at?" stays answerable for every family including the parallel one. */
  function familyVP(members) {
    var vp = bestFitVP(members), i, sx = 0, sy = 0, mx = 0, my = 0, r;
    if (vp) return vp;
    if (!members.length) return null;
    for (i = 0; i < members.length; i++) {
      r = members[i].angle * Math.PI / 90;
      sx += Math.cos(r); sy += Math.sin(r);
      mx += members[i].mx; my += members[i].my;
    }
    r = Math.atan2(sy, sx) / 2; /* circular mean angle, mod 180 */
    return {
      x: mx / members.length + 1e7 * Math.cos(r),
      y: my / members.length + 1e7 * Math.sin(r),
    };
  }

  /* k-means over the three meeting points: re-fit each family's shared
     VP, re-deal EVERY stroke to the point it misses least, repeat until
     the deal stops moving. Every stroke lands in exactly one family, so
     nothing a player drew escapes the score. */
  function refineByVP(groups, segs) {
    var it, i, j, k, vps, next, bi, bd, d, sig, prev = '';
    for (it = 0; it < 12; it++) {
      vps = [];
      for (i = 0; i < groups.length; i++) {
        vps.push(groups[i].length ? familyVP(segsOf(groups[i], segs)) : null);
      }
      next = [];
      for (i = 0; i < groups.length; i++) next.push([]);
      for (k = 0; k < segs.length; k++) {
        bi = -1; bd = Infinity;
        for (j = 0; j < vps.length; j++) {
          if (!vps[j]) continue;
          d = missDeg(segs[k], vps[j]);
          if (d < bd) { bd = d; bi = j; }
        }
        next[bi < 0 ? 0 : bi].push(k);
      }
      /* a starved family means the re-deal overreached — keep the last
         honest grouping rather than reporting an empty row */
      for (i = 0; i < next.length; i++) if (!next[i].length) return groups;
      sig = next.join('|');
      if (sig === prev) return next;
      prev = sig;
      groups = next;
    }
    return groups;
  }

  /* ---- direction families by shared VANISHING POINT ----
     One 3D direction does NOT project to one image angle. Its edges
     radiate from a shared VP, so a three-quarter box fans a single
     family across 40°+ of image angle while neighbouring families
     interleave — angle clustering cannot separate the axes at all. The
     invariant that survives perspective is the vanishing point itself.
     So: every pair of strokes proposes a VP (RANSAC-style), the
     candidate the most strokes aim at (within VP_TOL) claims a family,
     the unclaimed strokes re-vote for the next, and a final k-means
     pass re-deals everything to the point it misses least. Genuinely
     parallel bundles have no finite VP to vote for; they fall through
     to the leftover pass, where a shared image angle IS the honest
     signal. */
  function groupByVP(segs, size, vpTol) {
    var n = segs.length, i, j, k, v, inl, cands = [], all = [];
    if (n < 2) return n ? [[0]] : [];
    for (i = 0; i < n; i++) all.push(i);

    function inliersOf(vp) {
      var out = [], t;
      for (t = 0; t < n; t++) if (missDeg(segs[t], vp) < vpTol) out.push(t);
      return out;
    }
    /* every pair of strokes proposes the point its two lines share */
    for (i = 0; i < n; i++) {
      for (j = i + 1; j < n; j++) {
        v = bestFitVP([segs[i], segs[j]]);
        if (!v) continue;
        inl = inliersOf(v);
        if (inl.length >= 2) cands.push({ vp: v, inl: inl });
      }
    }
    /* plus one pseudo-candidate per angle band: an exactly parallel
       bundle shares no finite point, so no pair can nominate it */
    var bands = angleGroups(all, segs, 3);
    for (i = 0; i < bands.length; i++) {
      v = familyVP(segsOf(bands[i], segs));
      if (v) cands.push({ vp: v, inl: inliersOf(v) });
    }
    /* strongest first, then dedup: pairs drawn from one family all
       nominate the same point, and 600 copies of it help nobody. Only
       near-IDENTICAL votes are folded (Jaccard, not overlap-of-the-
       smaller): a true 3-line pencil often shares members with a larger
       accidental one, and dropping it as a "duplicate" would put the
       honest reading out of reach of the search below. */
    cands.sort(function (p, q) { return q.inl.length - p.inl.length; });
    var keep = [], dup, ov, t;
    for (i = 0; i < cands.length && keep.length < 12; i++) {
      dup = false;
      for (j = 0; j < keep.length && !dup; j++) {
        ov = 0;
        for (t = 0; t < cands[i].inl.length; t++) {
          if (keep[j].inl.indexOf(cands[i].inl[t]) !== -1) ov++;
        }
        if (ov > 0.8 * (cands[i].inl.length + keep[j].inl.length - ov)) dup = true;
      }
      if (!dup) keep.push(cands[i]);
    }
    if (keep.length < 3) {
      /* too few distinct pencils to triangulate — fall back to angle
         bands, which is exactly the right reading for parallel work */
      return refineByVP(angleGroups(all, segs, 3), segs);
    }
    /* Try every triple of surviving candidates and keep the reading that
       explains ALL the strokes with the least total angular miss. Greedy
       "biggest vote first" is not enough: a chance alignment between two
       families can out-vote a true pencil and then steal its members. */
    var best = null, bestCost = Infinity, cost;
    for (i = 0; i < keep.length; i++) {
      for (j = i + 1; j < keep.length; j++) {
        for (k = j + 1; k < keep.length; k++) {
          var g = refineByVP(
            dealTo([keep[i].vp, keep[j].vp, keep[k].vp], segs), segs);
          cost = groupingCost(g, segs, size, vpTol);
          if (cost < bestCost) { bestCost = cost; best = g; }
        }
      }
    }
    if (!best) return refineByVP(angleGroups(all, segs, 3), segs);
    return refineByVP(polish(best, segs, size, vpTol), segs);
  }

  /* hand every stroke to whichever of these points it misses least */
  function dealTo(vps, segs) {
    var out = [], i, j, bi, bd, d;
    for (i = 0; i < vps.length; i++) out.push([]);
    for (i = 0; i < segs.length; i++) {
      bi = 0; bd = Infinity;
      for (j = 0; j < vps.length; j++) {
        if (!vps[j]) continue;
        d = missDeg(segs[i], vps[j]);
        if (d < bd) { bd = d; bi = j; }
      }
      out[bi].push(i);
    }
    return out;
  }

  /* Distance from a point to a stroke's finite extent (not its infinite
     line) — how the corner test below tells "meets there" from "points
     there". */
  function distToSeg(s, p) {
    var vx = s.x2 - s.x1, vy = s.y2 - s.y1, t;
    var L2 = vx * vx + vy * vy;
    if (L2 < 1e-9) return Math.hypot(p.x - s.x1, p.y - s.y1);
    t = clamp(((p.x - s.x1) * vx + (p.y - s.y1) * vy) / L2, 0, 1);
    return Math.hypot(p.x - (s.x1 + t * vx), p.y - (s.y1 + t * vy));
  }

  /* Total angular miss of a reading: how many degrees of "my lines do
     not actually meet there" the whole drawing costs under this split.
     Two corrections keep the cheapest reading an honest one:

     · a lone line is charged VP_TOL rather than the 0 it would score
       against a point fitted to itself, or the cheapest reading of any
       awkward stroke would be to give it a family of its own; and

     · a pencil through a box CORNER is charged too. The three edges
       meeting at a corner are exactly concurrent there, so by fit alone
       a corner is a flawless "vanishing point" — a 9-edge box can be
       carved into three perfect corner-pencils that explain every
       stroke with zero error and mean nothing. A real VP lies far off
       the edges it governs; a corner sits on them. */
  function groupingCost(groups, segs, size, vpTol) {
    var i, j, vp, sum = 0, reach, members;
    for (i = 0; i < groups.length; i++) {
      if (!groups[i].length) return Infinity;
      if (groups[i].length < 2) { sum += vpTol; continue; }
      members = segsOf(groups[i], segs);
      vp = familyVP(members);
      if (!vp) continue;
      reach = Infinity;
      for (j = 0; j < members.length; j++) {
        reach = Math.min(reach, distToSeg(members[j], vp));
      }
      if (reach < CORNER_NEAR * size) sum += CORNER_COST * groups[i].length;
      for (j = 0; j < groups[i].length; j++) sum += missDeg(segs[groups[i][j]], vp);
    }
    return sum;
  }

  /* Local descent out of a bad basin: move one stroke at a time to
     whichever family makes the whole reading cheaper, keeping every
     family at two strokes or more. The triple search above lands close;
     this walks the last step when an accidental pencil out-voted a true
     one during seeding. */
  function polish(groups, segs, size, vpTol) {
    var pass, i, j, k, cur, bestCost, bestMove, cand, c, from;
    cur = groupingCost(groups, segs, size, vpTol);
    for (pass = 0; pass < 6; pass++) {
      bestCost = cur; bestMove = null;
      for (i = 0; i < groups.length; i++) {
        if (groups[i].length <= 2) continue;
        for (k = 0; k < groups[i].length; k++) {
          for (j = 0; j < groups.length; j++) {
            if (j === i) continue;
            cand = [];
            for (from = 0; from < groups.length; from++) cand.push(groups[from].slice());
            cand[i].splice(k, 1);
            cand[j].push(groups[i][k]);
            c = groupingCost(cand, segs, size, vpTol);
            if (c < bestCost - 1e-9) { bestCost = c; bestMove = cand; }
          }
        }
      }
      if (!bestMove) break;
      groups = bestMove; cur = bestCost;
    }
    return groups;
  }

  /* Does this family sit on one side of the box yet meet back across it
     (far edge drawn longer than near edge)? Judged by the family's MEAN
     midpoint, since single edges sit perpendicular-offset from the
     centroid; a family centred on the box (mean offset under 15% of the
     drawing) has no honest side and abstains. This is a TIEBREAK only —
     it is the position heuristic cameraCheckDivergence consults to pick
     which of two mutually impossible families to blame. It must never
     convict on its own: a legitimately lopsided family (a box drawn with
     only its visible edges) trips it, so the verdict belongs to the
     real-camera test, which is geometry rather than placement. */
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
                   ill-conditioned: full credit inside tol.freeDeg, then
                   a ramp to 0 at tol.zeroDeg, both sized for the
                   hardware and the edge lengths in hand (convergeTol).
       unproven  (exactly 2 lines) → PAIR_SCORE, flat. Two lines meet
                   *somewhere* by definition and are parallel to each
                   other by definition, so they used to bank a free ~80
                   for proving nothing — which paid a player to stop at
                   the 6-edge minimum instead of drawing the 9–12 the
                   drill asks for. Following the instructions must not
                   cost points.
       diverging: converging score · 0.5, capped at 45 — set by
                   cameraCheckDivergence, never by one family alone */
  function analyzeFamily(segs, cx, cy, size, tol) {
    if (segs.length < 2) {
      return { verdict: 'missing', score: MISSING_SCORE, vp: null, spread: 0, unproven: false };
    }
    var i;
    var meanA = (function () {
      var sx = 0, sy = 0, r;
      for (i = 0; i < segs.length; i++) {
        r = segs[i].angle * Math.PI / 90;
        sx += Math.cos(r); sy += Math.sin(r);
      }
      return ((Math.atan2(sy, sx) * 90 / Math.PI) % 180 + 180) % 180;
    })();
    var maxDev = 0, devs = [], dev;
    for (i = 0; i < segs.length; i++) {
      dev = angleDistDeg(segs[i].angle, meanA);
      devs.push(dev);
      if (dev > maxDev) maxDev = dev;
    }
    /* two strokes prove nothing on their own — they meet *somewhere* by
       definition, and they are parallel to each other by definition too */
    var unproven = (segs.length === 2);
    var t = tol || convergeTol(1, 150);
    /* A PARALLEL family is not a worse answer than a converging one —
       in two-point perspective it is the RIGHT answer, with the shared
       point simply at infinity. So it is graded exactly like the other
       families, on how far its members miss that shared point; toward a
       point at infinity that miss IS the deviation from the common
       direction. A flat 85 here hard-capped a geometrically perfect
       two-point box — the box drawGhostIntro paints as the worked
       example — at 95, while the row told the player "that's fine".
       (GAME_GUIDE: a score of 100 must be possible.) */
    var parSpread = median(devs);
    var parScore = (parSpread <= t.freeDeg)
      ? 100
      : 100 * clamp(1 - (parSpread - t.freeDeg) / Math.max(1e-6, t.zeroDeg - t.freeDeg), 0, 1);
    if (unproven) parScore = PAIR_SCORE;
    if (!isFinite(parScore)) parScore = 0;
    var parallel = {
      verdict: 'parallel', score: clamp(parScore, 0, 100), vp: null,
      spread: parSpread, unproven: unproven,
    };
    var vp = bestFitVP(segs);
    if (!vp) {
      return parallel;
    }
    if (maxDev < 4 && Math.hypot(vp.x - cx, vp.y - cy) > 8 * size) {
      return parallel;
    }
    var miss = [], aim, d;
    for (i = 0; i < segs.length; i++) {
      d = Math.hypot(vp.x - segs[i].mx, vp.y - segs[i].my);
      if (d < 1e-6) continue;
      aim = ((Math.atan2(vp.y - segs[i].my, vp.x - segs[i].mx) * 180 / Math.PI) % 180 + 180) % 180;
      miss.push(angleDistDeg(aim, segs[i].angle));
    }
    var spread = median(miss); /* degrees of miss, 0 = razor-tight */
    /* A family's meeting point has to lie OFF the edges it governs.
       Lines that simply CROSS each other in the middle of the sheet
       share a point too, and by fit alone that point is a flawless
       "vanishing point" — it is just not one: a real VP is far away and
       the edges run together toward it. The grouper already pays this
       cost when it CHOOSES a reading (CORNER_NEAR / CORNER_COST); the
       score has to know it as well, or a fan of crossing scribble reads
       as a tight pencil. This is the one test that separates a box from
       scribble without reference to any tolerance, which is why it must
       not be eased. */
    var reach = Infinity;
    for (i = 0; i < segs.length; i++) reach = Math.min(reach, distToSeg(segs[i], vp));
    var crossing = reach < CROSS_NEAR * size;
    /* full-credit plateau: inside tol.freeDeg of a shared VP is as
       tight as a human hand gets — that IS 100 (GAME_GUIDE: 100 must
       be earnable); beyond it a straight ramp to tol.zeroDeg */
    var score = (spread <= t.freeDeg)
      ? 100
      : 100 * clamp(1 - (spread - t.freeDeg) / Math.max(1e-6, t.zeroDeg - t.freeDeg), 0, 1);
    if (unproven) score = PAIR_SCORE;
    if (crossing) score = Math.min(score, CROSSING_SCORE);
    if (!isFinite(score)) score = 0;
    /* divergence is NOT decided here: one family alone cannot prove it.
       cameraCheckDivergence rules on the three together, against the
       real-camera condition. */
    /* the verdict stays 'converging' so the three families remain
       comparable to the real-camera test — crossing is a FLAG on the
       reading, not a different kind of reading */
    return {
      verdict: 'converging', crossing: crossing,
      score: clamp(score, 0, 100), vp: vp, spread: spread,
      unproven: unproven && !crossing
    };
  }

  /* ---- real-camera consistency ----
     A pinhole camera with principal point P and focal length f puts the
     VPs of two ORTHOGONAL box directions at points a, b with
     (a−P)·(b−P) = −f² — strictly negative, no tuned threshold. */
  function famDot(a, b, px2, py2) {
    return (a.x - px2) * (b.x - px2) + (a.y - py2) * (b.y - py2);
  }

  /* Orthocenter of the VP triangle. Three MUTUALLY ORTHOGONAL
     directions seen by one pinhole camera put their principal point
     exactly at the orthocenter of their three vanishing points — and
     there the three pairwise dots become algebraically identical, so
     f² = −(a−H)·(b−H) is one number rather than three disagreeing ones.
     That removes the old fudge of assuming P at the drawing's centroid:
     the camera is now READ OFF the drawing instead of guessed, so a box
     sketched in a sheet corner is judged on its convergence and not on
     where it sits. */
  function orthocenter(a, b, c) {
    var d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if (Math.abs(d) < 1e-9) return null; /* collinear VPs — no triangle */
    var a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
    var ox = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
    var oy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
    /* H = A + B + C − 2·O, the Euler-line relation to the circumcenter */
    return { x: a.x + b.x + c.x - 2 * ox, y: a.y + b.y + c.y - 2 * oy };
  }

  /* The one camera three families imply, or null when they imply none.
     f² ≤ 0 (an obtuse VP triangle) means NO camera anywhere can see
     these three sets as one box — that is what a diverging box really
     is. A real but absurdly wide lens (focal under MIN_F of the
     drawing) is the same verdict wearing a disguise: three sprayed
     pencils always meet somewhere, and the "camera" that explains them
     is a fisheye no sketch was ever drawn through. */
  function fitCamera(fams, size) {
    if (fams.length !== 3) return null;
    var H = orthocenter(fams[0].vp, fams[1].vp, fams[2].vp);
    if (!H) return null;
    var t = famDot(fams[0].vp, fams[1].vp, H.x, H.y);
    if (!(t < 0)) return null;
    var f = Math.sqrt(-t);
    if (!isFinite(f) || f < MIN_F * size) return null;
    return {
      f: f, px: H.x, py: H.y,
      vpA: fams[0].vp, vpB: fams[1].vp,
      maxSpread: Math.max(fams[0].spread, fams[1].spread, fams[2].spread),
    };
  }

  /* ---- was the camera test failed for real, or inside the noise? ----
     The camera condition is a statement about an ANGLE: seen from the
     orthocenter H, two orthogonal directions' vanishing points must sit
     more than 90° apart, i.e. cos of that angle is negative. But H and
     both VPs are READ OFF the drawing, and a VP's own bearing is only
     as certain as the family that voted for it — about its spread σ.
     So a failure by less than roughly σ is the hand wobbling, not a box
     that cannot exist.

     Taking cos rather than the raw dot product is what makes this
     honest at every size: the dot product grows as the square of how
     far the VPs happen to land, so a fixed pixel threshold would forgive
     everything on one drawing and nothing on the next. cos is
     dimensionless.

     This is the fix for the phone. Short edges make σ large, the VPs
     wander, the 90° condition flips, and the same hand that was cleared
     on a desktop was convicted of "no camera sees these together" on a
     phone — for the identical drawing. */
  var NEAR_SIGMA_CAP = 6;   /* degrees — the most wobble that gets forgiven */
  var NEAR_H_REACH = 3;     /* orthocenters further than this × the drawing
                               size are a degenerate read, not a verdict */

  function cameraNearMiss(fams, cx, cy, size) {
    if (fams.length !== 3) return false;
    var i, sig = 0;
    for (i = 0; i < 3; i++) if (!fams[i].vp) return false;
    var H = orthocenter(fams[0].vp, fams[1].vp, fams[2].vp);
    if (!H) return true;                 /* collinear VPs: nothing to read */
    var t = famDot(fams[0].vp, fams[1].vp, H.x, H.y);
    if (t < 0) return false;             /* the camera exists — nothing to forgive */
    /* The principal point of a camera that saw THIS drawing belongs
       somewhere near the drawing. The orthocenter of a near-degenerate
       triangle flies off to many times the sheet — and short, noisy
       edges are precisely what makes the VP triangle degenerate. The
       sign it reports out there is arithmetic, not perspective.
       Measured: when an honest phone box fails this test the
       orthocenter sits a median 4× the drawing away; when a scribble
       fails it, a median 1.2×. */
    if (Math.hypot(H.x - cx, H.y - cy) > NEAR_H_REACH * size) return true;
    var da = Math.hypot(fams[0].vp.x - H.x, fams[0].vp.y - H.y);
    var db = Math.hypot(fams[1].vp.x - H.x, fams[1].vp.y - H.y);
    if (!(da > 1e-6 && db > 1e-6)) return true;
    for (i = 0; i < 3; i++) sig = Math.max(sig, fams[i].spread || 0);
    return (t / (da * db)) < 2 * Math.tan(Math.min(sig, NEAR_SIGMA_CAP) * Math.PI / 180);
  }

  /* 3D direction implied by a VP under camera (P, f) */
  function dir3(vp, px2, py2, f) {
    var x = vp.x - px2, y = vp.y - py2, n = Math.hypot(x, y, f);
    return { x: x / n, y: y / n, z: f / n };
  }

  /* Divergence verdict. Preferred route: all three sets have a finite
     meeting point, so the orthocenter camera settles it outright — it
     exists, or the drawing is not a box. When it does not exist, blame
     ONE family (the reveal has to point somewhere), preferring the set
     that sits across the box from its own VP and falling back to the
     loosest. Fallback route: a parallel family has no finite VP to put
     in the triangle, so the surviving pairs are checked the weaker way,
     (a−P)·(b−P) < 0 about the drawing's centre. Returns the fitted
     camera (or null) so the reveal can reproject a true box. */
  function cameraCheckDivergence(fams, segs, cx, cy, size, blame) {
    var i, j, a, b, conv = [], ok = [], cam;
    function membersOf(f) {
      var out = [], m;
      for (m = 0; m < f.idxs.length; m++) out.push(segs[f.idxs[m]]);
      return out;
    }
    /* blame=false: the reading is not confident enough to convict
       anybody (see analyzeBox — a starved grouping or lines wobbling
       harder than the effect being measured). The camera is still
       fitted, because the ghost box is useful either way; only the
       accusation is withheld. */
    function demote(f) {
      if (!blame || f.verdict === 'diverging') return;
      f.verdict = 'diverging';
      f.score = clamp(f.score * DIVERGE_MUL, 0, DIVERGE_CAP);
    }
    function guiltiest(list) {
      var k, guilty = null;
      for (k = 0; k < list.length; k++) {
        if (!wrongSideOfBox(membersOf(list[k]), list[k].vp, cx, cy, size)) continue;
        if (!guilty || list[k].spread > guilty.spread) guilty = list[k];
      }
      if (guilty) return guilty;
      guilty = list[0];
      for (k = 1; k < list.length; k++) if (list[k].spread > guilty.spread) guilty = list[k];
      return guilty;
    }
    function converging() {
      var out = [], k;
      for (k = 0; k < fams.length; k++) {
        if (fams[k].vp && fams[k].verdict === 'converging') out.push(fams[k]);
      }
      return out;
    }
    conv = converging();
    if (conv.length === 3) {
      cam = fitCamera(conv, size);
      if (cam) return cam;
      demote(guiltiest(conv));
    }
    conv = converging();
    for (i = 0; i < conv.length; i++) {
      for (j = i + 1; j < conv.length; j++) {
        a = conv[i]; b = conv[j];
        /* one liar explains many bad pairs — skip already-demoted */
        if (a.verdict !== 'converging' || b.verdict !== 'converging') continue;
        if (famDot(a.vp, b.vp, cx, cy) < 0) continue; /* a real camera exists */
        var wsA = wrongSideOfBox(membersOf(a), a.vp, cx, cy, size);
        var wsB = wrongSideOfBox(membersOf(b), b.vp, cx, cy, size);
        if (wsA !== wsB) demote(wsA ? a : b);
        else demote(a.spread >= b.spread ? a : b);
      }
    }
    ok = converging();
    ok.sort(function (p, q) { return p.spread - q.spread; });
    if (ok.length < 2) return null;
    var f2 = -famDot(ok[0].vp, ok[1].vp, cx, cy);
    if (f2 <= 0) return null;
    var f = Math.sqrt(f2);
    if (f < MIN_F * size) return null;
    return {
      f: f, px: cx, py: cy, vpA: ok[0].vp, vpB: ok[1].vp,
      maxSpread: Math.max(ok[0].spread, ok[1].spread),
    };
  }

  /* Reproject a TRUE rectangular box through the fitted camera: take the
     two best VP directions, complete the triad with their cross product
     (orthogonal by construction — f was chosen to make d1·d2 = 0), and
     project 8 corners with x = P + f·(X/Z, Y/Z) about the camera's own
     principal point P. The cube is hung on the ray that passes through
     (cx, cy) so the ghost lands over the player's box rather than over
     the optical axis. Returns 12 edges in sheet px, or null when a
     corner pokes behind the lens. */
  function correctedBoxEdges(cam, cx, cy, size) {
    var d1 = dir3(cam.vpA, cam.px, cam.py, cam.f);
    var d2 = dir3(cam.vpB, cam.px, cam.py, cam.f);
    var d3 = {
      x: d1.y * d2.z - d1.z * d2.y,
      y: d1.z * d2.x - d1.x * d2.z,
      z: d1.x * d2.y - d1.y * d2.x,
    };
    var n = Math.hypot(d3.x, d3.y, d3.z);
    if (n < 0.35) return null;
    d3 = { x: d3.x / n, y: d3.y / n, z: d3.z / n };
    var Z0 = cam.f, half = 0.31 * size;
    /* centre of the ghost: depth Z0 along the ray through (cx, cy) */
    var Cx = (cx - cam.px) / cam.f * Z0, Cy = (cy - cam.py) / cam.f * Z0;
    var verts = [], i, j, a, b, cc, X, Y, Z, k;
    for (i = 0; i < 8; i++) {
      a = (i & 1) ? 1 : -1;
      b = (i & 2) ? 1 : -1;
      cc = (i & 4) ? 1 : -1;
      X = Cx + (a * d1.x + b * d2.x + cc * d3.x) * half;
      Y = Cy + (a * d1.y + b * d2.y + cc * d3.y) * half;
      Z = Z0 + (a * d1.z + b * d2.z + cc * d3.z) * half;
      if (!(Z >= 0.12 * Z0)) return null;
      verts.push({ x: cam.px + cam.f * X / Z, y: cam.py + cam.f * Y / Z });
      if (!isFinite(verts[i].x) || !isFinite(verts[i].y)) return null;
    }
    var edges = [];
    for (i = 0; i < 8; i++) {
      for (j = 0; j < 3; j++) {
        k = i ^ (1 << j);
        if (k > i) edges.push({ x1: verts[i].x, y1: verts[i].y, x2: verts[k].x, y2: verts[k].y });
      }
    }
    return edges;
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
    /* Two or three sets can land on the same side; rank them steepest
       first and suffix so no two rows ever read identically. */
    var keys = ['l', 'r'], dup, k;
    var pair = [' (steeper)', ' (flatter)'];
    var trio = [' (steepest)', ' (middle)', ' (flattest)'];
    for (k = 0; k < keys.length; k++) {
      dup = [];
      for (i = 0; i < labels.length; i++) if (labels[i].key === keys[k]) dup.push(i);
      if (dup.length < 2) continue;
      dup.sort(function (p, q) {
        return angleDistDeg(means[p], 90) - angleDistDeg(means[q], 90);
      });
      for (j = 0; j < dup.length; j++) {
        labels[dup[j]].label += (dup.length === 2 ? pair[j] : trio[j]) || (' #' + (j + 1));
      }
    }
    return labels;
  }

  function missingLabel(existing) {
    var i, hasV = false;
    for (i = 0; i < existing.length; i++) if (existing[i].key === 'v') hasV = true;
    if (!hasV) return { key: 'v', label: '↕ verticals' };
    /* distinct label per missing slot — two rows must never read alike */
    return (existing.length < 2)
      ? { key: '?', label: '• second set' }
      : { key: '??', label: '• third set' };
  }

  /* Whole drawing → { score, families[3], cx, cy, size, … }.
     Round score is the mean of the 3 family scores, scaled by how
     complete the box is. opts = { easeMul, capHard } — pure, so the
     whole scorer runs without a canvas or an SDK. */
  function analyzeBox(segs, opts) {
    var o = opts || {};
    var i, angles = [], xs = [], ys = [], lens = [];
    for (i = 0; i < segs.length; i++) {
      angles.push(segs[i].angle);
      lens.push(segs[i].len);
      xs.push(segs[i].x1, segs[i].x2);
      ys.push(segs[i].y1, segs[i].y2);
    }
    var minx = Math.min.apply(null, xs), maxx = Math.max.apply(null, xs);
    var miny = Math.min.apply(null, ys), maxy = Math.max.apply(null, ys);
    var size = Math.max(40, maxx - minx, maxy - miny);
    var cx = 0, cy = 0;
    for (i = 0; i < segs.length; i++) { cx += segs[i].mx; cy += segs[i].my; }
    cx /= segs.length; cy /= segs.length;
    var medLen = median(lens);
    var tol = convergeTol(o.easeMul, medLen);

    var groups = groupByVP(segs, size, tol.vpTol);
    var fams = [], means = [], phis = [], g, members, j, res, lab, labels;
    for (i = 0; i < groups.length && i < 3; i++) {
      g = groups[i];
      members = [];
      for (j = 0; j < g.length; j++) members.push(segs[g[j]]);
      res = analyzeFamily(members, cx, cy, size, tol);
      means.push(groupMeanAngle(angles, g));
      phis.push(groupOrientedMean(g, segs, cx, cy, means[means.length - 1]));
      fams.push({
        idxs: g, count: g.length, unproven: !!res.unproven, crossing: !!res.crossing,
        verdict: res.verdict, score: res.score, vp: res.vp, spread: res.spread,
      });
    }
    /* Was the exact test even available? Only when all three sets have
       a finite meeting point; a parallel family has none to trilaterate
       with, and then no verdict of "impossible" may be pronounced. */
    var testable = fams.length === 3, notABox = false;
    for (i = 0; i < fams.length && testable; i++) {
      if (fams[i].verdict !== 'converging' || !fams[i].vp) testable = false;
    }

    /* ---- when is the reading entitled to convict anyone? ----
       STARVED: the grouper left a family with 2 strokes or fewer out of
       8+. Nobody draws a box with a two-line direction and eight lines
       in another, so that is a SORTING failure — and it is what used to
       fire "DIVERGES ✗" and the round cap on boxes that were fine.
       TIDY: the families it DID sort miss their own shared points by
       very little. A starved sort on tidy lines is a mis-sort on a good
       drawing; a starved sort on lines that are all over the place is
       not a mis-sort at all — it is what scribble looks like, and the
       camera test is the only thing between scribble and a pass.
       So blame is withheld for exactly one case: starved AND tidy. */
    var starved = false;
    if (segs.length >= 8) {
      if (fams.length < 3) starved = true;
      for (i = 0; i < fams.length; i++) if (fams[i].count <= 2) starved = true;
    }
    var maxSpread = 0, solid = [];
    for (i = 0; i < fams.length; i++) {
      maxSpread = Math.max(maxSpread, fams[i].spread || 0);
      if (fams[i].count >= 3) solid.push(fams[i].spread || 0);
    }
    var tidy = solid.length ? (median(solid) < tol.tidyDeg) : false;
    /* wobbly does not block blame — it only decides which lesson the
       note teaches. Divergence you cannot hold your hand steady enough
       to see is a steadiness problem first. */
    var wobbly = maxSpread > 0.55 * tol.zeroDeg;
    var blame = !(starved && tidy) && !cameraNearMiss(fams, cx, cy, size);

    var cam = cameraCheckDivergence(fams, segs, cx, cy, size, blame);
    if (testable && !cam && blame) notABox = true;
    /* Two of the three sets meeting ON their own strokes is not a box
       under any camera, and unlike the camera test it needs no
       tolerance to say so — which is why it still holds when the
       tolerance has been eased wide open for a trackpad. One crossing
       set is a plausible mis-sort and is only charged to that set. */
    var crossCount = 0;
    for (i = 0; i < fams.length; i++) if (fams[i].crossing) crossCount++;
    if (crossCount >= 2 && !(starved && tidy)) notABox = true;
    labels = assignLabels(means, phis);
    for (i = 0; i < fams.length; i++) {
      fams[i].key = labels[i].key;
      fams[i].label = labels[i].label;
    }
    while (fams.length < 3) {
      lab = missingLabel(fams);
      fams.push({
        idxs: [], count: 0, key: lab.key, label: lab.label, unproven: false, crossing: false,
        verdict: 'missing', score: MISSING_SCORE, vp: null, spread: 0,
      });
    }
    var rank = { l: 0, v: 1, r: 2, '?': 3, '??': 4 };
    fams.sort(function (p, q) { return (rank[p.key] || 0) - (rank[q.key] || 0); });

    /* A 2-stroke family inside a 9-edge drawing is the grouper's doing,
       not the player's. Banking it a flat PAIR_SCORE would pay a
       scribble that happened to sort badly; charging it would punish a
       good box for a bad sort. So it inherits what the rest of the
       drawing actually earned. Three 2-stroke families — the honest
       6-edge minimum — have nothing to inherit from and keep
       PAIR_SCORE, which is the point of that number. Inheriting also
       closes the other end: a scribble that happens to sort into
       3/2/2 no longer banks two flat passes for four random lines. */
    var proven = [], inherit = 0;
    for (i = 0; i < fams.length; i++) {
      if (!fams[i].unproven && fams[i].count >= 3) proven.push(fams[i].score);
    }
    if (proven.length) {
      for (i = 0; i < proven.length; i++) inherit += proven[i];
      inherit /= proven.length;
      for (i = 0; i < fams.length; i++) {
        if (fams[i].unproven && fams[i].verdict !== 'diverging') fams[i].score = inherit;
      }
    }

    var total = (fams[0].score + fams[1].score + fams[2].score) / 3;
    /* A complete box must never score below an incomplete one. Without
       this, three 2-stroke families (the bare 6-edge minimum) banked a
       flat pass while the 9–12 edges the how-to asks for were each
       measured — following the instructions cost points. */
    total *= clamp(0.8 + 0.2 * segs.length / EDGE_FULL, 0, 1);
    /* Three sets that admit no camera are not a box, however neatly any
       one of them converges — three pencils always meet SOMEWHERE, and
       rewarding that would score a fan of scribble like a drawing. The
       cap is held back on a first-ever visit: a 45 with "these can't
       belong to one box" as somebody's first result ends the habit
       before it starts. The critique still says it either way. */
    if (notABox && o.capHard) total = Math.min(total, NOT_A_BOX);
    if (!isFinite(total)) total = 0;
    /* ghost box only when the two anchor VPs are honestly tight —
       a corrected box fitted to sprayed VPs teaches nothing */
    var ghost = (cam && cam.maxSpread < 8) ? correctedBoxEdges(cam, cx, cy, size) : null;
    return {
      score: Math.round(clamp(total, 0, 100)), families: fams, notABox: notABox,
      starved: starved, wobbly: wobbly, tidy: tidy, tol: tol, medLen: medLen,
      cx: cx, cy: cy, size: size, ghost: ghost,
    };
  }

  /* One honest critique line per family — a diagnosis, not a verdict on
     the person, and in words a beginner already owns. The rubric
     ("caps at 80", "VP near infinity") is the developer's bookkeeping
     and does not belong in feedback. The one term kept is "vanishing
     point", because teaching it IS the drill — and the reveal teaches
     it on the spot by extending every line to the marked point. */
  function verdictFor(f, tol) {
    var t = tol || convergeTol(1, 150);
    if (f.verdict === 'missing') {
      if (f.count === 1) {
        return { cls: 'bad', text: 'only one line runs this way — a box needs at least two per direction' };
      }
      return { cls: 'bad', text: 'nothing runs this way — a box has edges going three ways' };
    }
    if (f.unproven) {
      return { cls: 'meh', text: 'only two lines here — any two lines meet somewhere, so this set hasn’t shown anything yet. add a third and it can.' };
    }
    if (f.verdict === 'parallel') {
      /* graded on agreement like any other set, so the wording has to
         follow the score instead of always reading "that's fine" */
      var rp = f.spread / Math.max(1e-6, t.zeroDeg);
      if (rp < 0.12) return { cls: 'good', text: 'these run parallel ✓ tight — that’s fine: their meeting point is simply a very long way off' };
      if (rp < 0.3) return { cls: 'good', text: 'these run parallel ✓ pretty clean — their meeting point is simply a very long way off' };
      return { cls: 'meh', text: 'these run roughly parallel — their meeting point is a very long way off, but they do not quite agree on which way they go' };
    }
    if (f.crossing) {
      return { cls: 'bad', text: 'these cross over each other in the middle rather than running together — they share a point, but it is not a vanishing point. edges of one direction should only meet a long way off.' };
    }
    if (f.verdict === 'diverging') {
      return { cls: 'bad', text: 'these spread apart as they go back — going away from you they should be closing in. that’s the classic one, and it’s the most fixable.' };
    }
    /* spread = median angular miss of the shared point, read against
       the tolerance this hardware and this box size earn */
    var r = f.spread / Math.max(1e-6, t.zeroDeg);
    if (r < 0.12) return { cls: 'good', text: 'all aimed at one point ✓ tight' };
    if (r < 0.3) return { cls: 'good', text: 'aimed at one point ✓ pretty clean' };
    if (r < 0.7) return { cls: 'meh', text: 'nearly agree — extended, they pass a little either side of their shared point' };
    return { cls: 'meh', text: 'not agreeing yet — extended, these scatter instead of meeting' };
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
  var btnUndo = document.getElementById('btnUndo');
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

  /* Every ink is a custom property on :root, and the ONLY thing that moves
     them is the data-theme attribute (see css/style.css) — so reading them
     once per theme is the same answer as reading them once per repaint,
     minus a forced style recalculation and a colour mix on every sample of
     every stroke. An empty read (stylesheet not parsed yet) is never
     cached, so a cold boot still corrects itself on the next frame. */
  var inkCache = null, inkTheme = '';
  function inks() {
    var t = ArtDaily.theme();
    if (inkCache && inkTheme === t) return inkCache;
    var cs = getComputedStyle(document.documentElement);
    var ink = cs.getPropertyValue('--ink').trim();
    var accent = cs.getPropertyValue('--game-accent').trim() || cs.getPropertyValue('--coral').trim();
    var c = {
      ink: ink,
      muted: cs.getPropertyValue('--muted').trim(),
      /* Everything the game paints in the accent is meaning-bearing, so
         the accent is inked toward graphite on paper (same recipe as the
         CSS: accent 55% into ink) — raw coral only reaches 3.1:1 on the
         card, this reaches 5.9:1. On the dark sheet pure accent already
         passes at 6.4:1. */
      accentText: t === 'dark' ? accent : mixHex(accent, ink, 0.55),
    };
    if (c.ink && c.muted) { inkCache = c; inkTheme = t; }
    return c;
  }

  /* ---- crisp canvas at any devicePixelRatio; height tracks width ----
     A resize mid-box rescales everything already drawn by the same
     factor, so a rotated phone (or a dragged desktop window) keeps the
     player's strokes where they put them instead of stranding them off
     the sheet. The fitted lines are rebuilt from the moved points, and
     any reveal on screen is recomputed from those.

     Two separate reasons to rebuild, and they are NOT the same reason. A
     WIDTH change moves the drawing and has to rescale it, so a nudge of a
     pixel or two (a scrollbar arriving, a rounding wobble as an iOS
     toolbar slides) is deliberately ignored — the box must not be rescaled
     for nothing. A devicePixelRatio change moves nothing on the sheet but
     leaves the backing store the wrong size: browser zoom and dragging the
     window onto a second monitor both do it at an UNCHANGED CSS width, and
     the old width-only guard returned early on exactly those, so the sheet
     rendered soft for the rest of the session while every sibling drill
     re-fitted itself. Returns whether anything moved, so the resize handler
     measures the box once instead of twice. */
  var W = 0, H = 0, fitDpr = 0;
  function fitCanvas() {
    var rect = canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width));
    var dpr = window.devicePixelRatio || 1;
    var moved = (W === 0) || Math.abs(w - W) >= 4;
    if (!moved && dpr === fitDpr) return false;
    var oldW = W;
    if (moved) {
      W = w;
      /* taller sheet on phones: at 0.7 a 330px phone got a 231px drill
         area, so the box had nowhere to be big — and every angular
         tolerance in the scorer is a function of how long the edges are */
      H = Math.round(W * (W < 520 ? 0.85 : 0.7));
    }
    fitDpr = dpr;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (moved && oldW > 0) rescaleStrokes(W / oldW);
    return true;
  }

  /* A RESIZE IS A CHANGE OF SIZE, NOT A CHANGE OF MIND. A reveal on
     screen used to be re-read from scratch on every resize frame, and
     the reading is NOT scale-free: convergeTol() sizes both the scoring
     ramp and the GROUPING tolerance off the median edge length in
     pixels, so the same strokes sort differently at a different width.
     Measured on nine wobbled edges scaled by 1.61: "all aimed at one
     point ✓ tight · 100" became "these cross over each other in the
     middle · 35", two families swapped converging↔parallel, the round
     read 99 → 74 and a ghost box appeared out of nowhere — for a
     drawing the player had not touched, on a score already reported and
     still standing in the HUD. Worse, renderCritique was never re-run,
     so the rows on the page went on describing the old reading while
     the sheet drew the new one, and a row could spotlight a family it
     no longer named.

     Every pixel the reveal paints is exactly LINEAR in the scale — a
     uniform scale about the origin maps lines to lines, so the VPs, the
     centroid, the drawing size and the reprojected ghost all come out
     exactly k× (verified by execution), while every angle, and so every
     verdict, spread and score, is untouched. So the banked reading is
     carried onto the new sheet instead of being second-guessed. It also
     takes a 5–14ms grouping pass (desktop; several times that on a
     phone) off every single frame of a window drag. */
  function scaleResult(r, k) {
    var i, f, e;
    if (!r || !(k > 0) || !isFinite(k)) return;
    r.cx *= k; r.cy *= k; r.size *= k; r.medLen *= k;
    for (i = 0; i < r.families.length; i++) {
      f = r.families[i];
      if (f.vp) { f.vp = { x: f.vp.x * k, y: f.vp.y * k }; }
    }
    if (r.ghost) {
      for (i = 0; i < r.ghost.length; i++) {
        e = r.ghost[i];
        e.x1 *= k; e.y1 *= k; e.x2 *= k; e.y2 *= k;
      }
    }
  }

  function rescaleStrokes(k) {
    var i, j, pts;
    for (i = 0; i < strokes.length; i++) {
      pts = strokes[i].pts;
      for (j = 0; j < pts.length; j++) { pts[j].x *= k; pts[j].y *= k; }
      strokes[i].seg = fitSegment(pts);
    }
    /* drop any stroke the rescale made degenerate. fitSegment only
       answers null for a one-point list and scaling cannot shorten one,
       so this has no work to do — but if it ever did, the families' own
       stroke INDICES would shift under the reveal, and then only a
       re-read can be trusted. */
    var dropped = false;
    for (i = strokes.length - 1; i >= 0; i--) {
      if (!strokes[i].seg) { strokes.splice(i, 1); dropped = true; }
    }
    if (live) for (j = 0; j < live.length; j++) { live[j].x *= k; live[j].y *= k; }
    if (phase === 'result') {
      if (dropped && strokes.length) {
        var segs = [];
        for (i = 0; i < strokes.length; i++) segs.push(strokes[i].seg);
        result = analyzeBox(segs, scoreOpts());
        spotlight = -1;
        renderCritique(result);
      } else {
        scaleResult(result, k);
      }
    }
    updateBar();
  }

  /* The bridge from the SDK's input profile into the pure scorer.
     ease(1) is the multiplier for the hardware in hand; capHard is
     false until the player has a score on the board, so nobody's
     first-ever box is capped at 45 for a reading it cannot read yet. */
  function scoreOpts() {
    return { easeMul: ArtDaily.ease(1), capHard: ArtDaily.best() !== null };
  }

  /* px of fitted length below which a stroke is a tap, not an edge */
  function minStroke() {
    return Math.max(MIN_STROKE_FLOOR, Math.round(MIN_STROKE_FRAC * W));
  }

  /* ---- round state ---- */
  var round = 0;
  var phase = 'draw';        /* 'draw' | 'result' */
  var strokes = [];          /* accepted: { pts, seg } */
  var live = null;           /* in-progress polyline */
  var activePointer = null;  /* pointerId guard */
  var result = null;         /* analyzeBox output, drives the reveal */
  var spotlight = -1;        /* critique row index lit on the sheet */

  function updateBar() {
    edgeCount.textContent = (phase === 'draw' && strokes.length < MIN_EDGES)
      ? 'edges: ' + strokes.length + ' / ' + MIN_EDGES
      : 'edges: ' + strokes.length;
    btnCheck.disabled = (phase !== 'draw') || (strokes.length < MIN_EDGES);
    btnUndo.disabled = (phase !== 'draw') || !strokes.length;
    /* during a reveal the only way forward is "new round" — a "clear"
       that silently spent the round would be a surprising button */
    btnClear.disabled = (phase !== 'draw') || !strokes.length;
  }

  function newRound() {
    round += 1;
    strokes = [];
    live = null;
    result = null;
    spotlight = -1;
    phase = 'draw';
    critique.hidden = true;
    critique.textContent = '';
    hudRound.textContent = String(round);
    hudScore.textContent = '–';
    hint.textContent = 'draw a 3D box, one straight stroke per edge — ' + MIN_EDGES +
      ' minimum, a full box is 9–12. lift between edges: that is how this one is meant to be drawn.';
    updateBar();
    draw();
  }

  function clearBox() {
    if (phase !== 'draw' || !strokes.length) return;
    strokes = [];
    live = null;
    hint.textContent = 'cleared — fresh box, same round.';
    updateBar();
    draw();
  }

  function undoStroke() {
    if (phase !== 'draw' || !strokes.length) return;
    strokes.pop();
    hint.textContent = 'stroke undone — ' + strokes.length +
      ' edge' + (strokes.length === 1 ? '' : 's') + ' stand.';
    updateBar();
    draw();
  }

  /* ---- repaint scheduling ----
     A 120Hz pen delivers several positions per dispatched event and several
     events per displayed frame. Repainting synchronously inside each one
     redrew every accepted edge, every dashed extension and the live stroke
     — the whole sheet — three or four times over for one frame anybody
     saw, and that cost grows with each edge the player adds, so the drill
     got heavier exactly as the drawing got interesting. draw() now only
     ASKS for a frame; paint() runs once, right before the browser
     composites, reading the freshest stroke there is. */
  var rafId = 0;
  function draw() {
    if (rafId) return;
    rafId = requestAnimationFrame(function () { rafId = 0; paint(); });
  }
  /* for paths that must not show a blank frame — a resize has already
     cleared the sheet, so it repaints on the spot */
  function paintNow() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    paint();
  }

  /* ---- painting (canvas bg stays clear so the CSS dot-grid shows) ---- */
  function paint() {
    var c = inks(), i, j, pts, hi = null;
    if (result && spotlight >= 0 && result.families[spotlight]) {
      hi = {};
      for (i = 0; i < result.families[spotlight].idxs.length; i++) {
        hi[result.families[spotlight].idxs[i]] = true;
      }
    }
    ctx.clearRect(0, 0, W, H);
    if (phase === 'draw' && !strokes.length && !live) drawGhostIntro(c);
    if (phase === 'draw' && strokes.length) drawLiveExtensions(c);
    if (result) drawReveal(c);
    ctx.lineWidth = 2.25;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (i = 0; i < strokes.length; i++) {
      ctx.strokeStyle = hi ? (hi[i] ? c.accentText : c.muted) : c.ink;
      pts = strokes[i].pts;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (j = 1; j < pts.length; j++) ctx.lineTo(pts[j].x, pts[j].y);
      ctx.stroke();
    }
    if (live && live.length > 1) {
      ctx.strokeStyle = c.ink;
      ctx.beginPath();
      ctx.moveTo(live[0].x, live[0].y);
      for (j = 1; j < live.length; j++) ctx.lineTo(live[j].x, live[j].y);
      ctx.stroke();
    }
  }

  /* Feedback from the FIRST stroke instead of the sixth. Every edge is
     extended past its own ends the moment it is accepted, so the player
     watches the three directions gather while they draw. That is the
     entire technique the drill teaches — extend a line and see where it
     actually points — learned by doing it rather than by being told the
     name of a course that does it. Spurs rather than full-sheet rays:
     they stay legible with a dozen edges on the paper, and the graded
     full-sheet version arrives at the reveal.
     --muted at 0.8 clears 3:1 against the card in BOTH themes. */
  function drawLiveExtensions(c) {
    var i, s, ext;
    ctx.save();
    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = c.muted;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 6]);
    for (i = 0; i < strokes.length; i++) {
      s = strokes[i].seg;
      if (!s) continue;
      ext = Math.max(40, s.len * 1.6);
      ctx.beginPath();
      ctx.moveTo(s.x1 - ext * s.dx, s.y1 - ext * s.dy);
      ctx.lineTo(s.x2 + ext * s.dx, s.y2 + ext * s.dy);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* faint example box on the empty sheet — gone at the first stroke */
  function drawGhostIntro(c) {
    function meet2(p1, p2, p3, p4) {
      var d = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);
      if (Math.abs(d) < 1e-9) return null;
      var a = p1.x * p2.y - p1.y * p2.x, b = p3.x * p4.y - p3.y * p4.x;
      return {
        x: (a * (p3.x - p4.x) - (p1.x - p2.x) * b) / d,
        y: (a * (p3.y - p4.y) - (p1.y - p2.y) * b) / d,
      };
    }
    function toward(p, vp, t) {
      return { x: p.x + (vp.x - p.x) * t, y: p.y + (vp.y - p.y) * t };
    }
    var vl = { x: 0.04 * W, y: 0.38 * H }, vr = { x: 0.97 * W, y: 0.38 * H };
    var nT = { x: 0.52 * W, y: 0.30 * H }, nB = { x: 0.52 * W, y: 0.76 * H };
    var lT = toward(nT, vl, 0.32), lB = toward(nB, vl, 0.32);
    var rT = toward(nT, vr, 0.36), rB = toward(nB, vr, 0.36);
    var bT = meet2(lT, vr, rT, vl), bB = meet2(lB, vr, rB, vl);
    if (!bT || !bB) return;
    var e = [
      [nT, nB], [lT, lB], [rT, rB],
      [nT, lT], [nT, rT], [nB, lB], [nB, rB],
      [lT, bT], [rT, bT], [lB, bB], [rB, bB], [bT, bB],
    ], i;
    /* alphas here are contrast floors, not taste: --muted at 0.8 clears
       3:1 against the card in BOTH themes (graphics), and the caption
       runs at full alpha to clear 4.5:1 as real text */
    ctx.save();
    ctx.strokeStyle = c.muted;
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 1.25;
    ctx.setLineDash([6, 5]);
    for (i = 0; i < e.length; i++) {
      ctx.beginPath();
      ctx.moveTo(e[i][0].x, e[i][0].y);
      ctx.lineTo(e[i][1].x, e[i][1].y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.fillStyle = c.muted;
    ctx.font = '12px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('a box like this — one straight stroke per edge', W / 2, 0.92 * H);
    ctx.restore();
  }

  /* dash pattern per family so extensions match their critique row */
  var FAM_DASH = { l: [], v: [3, 5], r: [10, 5] };
  var FAM_ARROW = { l: '←', v: '↕', r: '→' };

  function drawReveal(c) {
    var i, j, f, s, L = W + H, lit, dim;
    /* each family's fitted lines, extended across the sheet — dash-
       coded to its critique row; a tapped row is spotlit in accent */
    for (i = 0; i < result.families.length; i++) {
      f = result.families[i];
      lit = (spotlight === i);
      dim = (spotlight !== -1 && !lit);
      /* the extensions ARE the lesson, so they hold 3:1 against the card
         in both themes (muted at 0.8); only a set the player has
         deliberately backgrounded by spotlighting another drops below */
      ctx.save();
      ctx.globalAlpha = lit ? 1 : (dim ? 0.12 : 0.8);
      ctx.strokeStyle = lit ? c.accentText : c.muted;
      ctx.lineWidth = lit ? 1.75 : 1;
      ctx.setLineDash(FAM_DASH[f.key] || []);
      for (j = 0; j < f.idxs.length; j++) {
        s = strokes[f.idxs[j]] && strokes[f.idxs[j]].seg;
        if (!s) continue;
        ctx.beginPath();
        ctx.moveTo(s.mx - L * s.dx, s.my - L * s.dy);
        ctx.lineTo(s.mx + L * s.dx, s.my + L * s.dy);
        ctx.stroke();
      }
      ctx.restore();
    }
    /* ghost corrected box: a true rectangular box reprojected through
       the camera implied by the two best VPs */
    if (result.ghost && spotlight === -1) {
      ctx.save();
      ctx.strokeStyle = c.accentText;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      for (i = 0; i < result.ghost.length; i++) {
        ctx.beginPath();
        ctx.moveTo(result.ghost[i].x1, result.ghost[i].y1);
        ctx.lineTo(result.ghost[i].x2, result.ghost[i].y2);
        ctx.stroke();
      }
      ctx.restore();
    }
    for (i = 0; i < result.families.length; i++) {
      f = result.families[i];
      if (f.vp) drawVP(c, f, spotlight !== -1 && spotlight !== i);
    }
  }

  function drawVP(c, f, dim) {
    var vp = f.vp, m = 12;
    var tag = (f.verdict === 'diverging' ? '✗ ' : '') + (FAM_ARROW[f.key] || '•') + ' vp';
    ctx.save();
    /* accentText, not raw accent: on paper the raw coral only just
       clears 3:1, and this marker names a thing */
    ctx.globalAlpha = dim ? 0.15 : 1;
    ctx.fillStyle = c.accentText;
    ctx.strokeStyle = c.accentText;
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

  /* ---- freehand stroke capture (pointerId-guarded) ----
     One rect per EVENT, not one per sample: a 120Hz pen hands over a dozen
     coalesced positions in a single dispatch, and measuring the canvas box
     a dozen times to convert them is a dozen forced layouts for an answer
     that cannot have changed in between. */
  function pointerPos(ev, rect) {
    var r = rect || canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  /* Sub-pixel repeats are not shape. A hand that presses, sights along the
     edge and only then pulls emits hundreds of samples from the one spot —
     a 240Hz pen makes ~100 of them in 0.4s, a 1000Hz one four times that —
     and fitSegment is an UNWEIGHTED least-squares over the raw list, so
     every copy is a vote. On a normal 4px-bowed 200px edge that pile drags
     the fitted angle by ~0.9°, which is an eighth of the whole zero-point
     span a pen is scored against, always toward the end the hand rested on;
     and strokeBendRMS divides by the same inflated count, so the curve gate
     reads a third gentler than the stroke really is. Dropping them costs a
     FAST stroke nothing — its samples are pixels apart by definition — and
     it also stops the live repaint walking a point list that grows for as
     long as the hand is still. */
  function addSample(pts, p) {
    var last = pts.length ? pts[pts.length - 1] : null;
    if (last && Math.abs(p.x - last.x) < 1 && Math.abs(p.y - last.y) < 1) return;
    pts.push(p);
  }

  /* Pen beats a simultaneous touch. Artists rest the palm BEFORE the
     nib lands, so first-pointer-wins hands the whole edge to the palm
     and the pen draws nothing; pointerId guarding only ever rejected
     the SECOND contact. A pen pointerdown evicts a touch stroke, and
     touch is ignored for a moment after any pen event. */
  var lastPenAt = -1e9;
  var activeType = '';
  var PEN_GUARD_MS = 600;

  function penWins(ev) {
    var now = (typeof ev.timeStamp === 'number') ? ev.timeStamp : Date.now();
    if (ev.pointerType === 'pen') { lastPenAt = now; return true; }
    if (ev.pointerType === 'touch' && now - lastPenAt < PEN_GUARD_MS) return false;
    return true;
  }

  canvas.addEventListener('pointerdown', function (ev) {
    if (phase !== 'draw') return;
    if (!penWins(ev)) return;
    if (activePointer !== null) {
      if (!(ev.pointerType === 'pen' && activeType === 'touch')) return;
      try { canvas.releasePointerCapture(activePointer); } catch (e) {}
      live = null;                       /* discard what the palm drew */
    }
    ev.preventDefault();
    activePointer = ev.pointerId;
    activeType = ev.pointerType || '';
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
    /* preventDefault kills the focus the tap would have given us */
    try { canvas.focus({ preventScroll: true }); } catch (e) {}
    live = [pointerPos(ev)];
    draw();
  });

  canvas.addEventListener('pointermove', function (ev) {
    if (ev.pointerId !== activePointer || !live) return;
    ev.preventDefault();
    /* a 120Hz pen delivers several positions per dispatched event, and
       every one of them feeds the line fit (ArtDaily.samples is that
       pattern once, guarded — this drill used to hand-roll it) */
    var evs = ArtDaily.samples(ev);
    var rect = canvas.getBoundingClientRect();
    for (var i = 0; i < evs.length; i++) addSample(live, pointerPos(evs[i], rect));
    draw();
  });

  function onUp(ev) {
    if (ev.pointerId !== activePointer) return;
    if (ev.cancelable) ev.preventDefault();
    /* "check it" can score the box while a stroke is still in flight (a
       second finger, or Enter). Accepting that stroke afterwards would
       add an edge the reported score never saw — the bar, the reveal
       and any re-analysis on resize would all disagree with the number
       already banked. An interrupted stroke is dropped instead. */
    if (phase !== 'draw') { onCancel(ev); return; }
    /* THE TAIL OF A FAST STROKE. pointerup carries a position of its own,
       and it is the only record of where the nib actually stopped — the
       last pointermove can be most of a frame behind it. Dropping it
       shortened every quick, confident pull, and `seg.len` against
       minStroke() is what decides whether a stroke is an edge at all. */
    if (live && typeof ev.clientX === 'number') {
      var end = pointerPos(ev), tail = live.length ? live[live.length - 1] : null;
      if (!tail || Math.hypot(end.x - tail.x, end.y - tail.y) >= 0.5) live.push(end);
    }
    finishStroke();
  }

  function onCancel(ev) {
    if (ev.pointerId !== activePointer) return;
    live = null;
    activePointer = null;
    activeType = '';
    draw();
  }

  canvas.addEventListener('pointerup', onUp);
  /* Without this, one release off-canvas after a failed setPointerCapture
     left activePointer set forever and the sheet stopped accepting
     strokes until "new round". */
  window.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onCancel);
  window.addEventListener('pointercancel', onCancel);
  /* iOS drops capture without ever sending pointerup */
  canvas.addEventListener('lostpointercapture', onCancel);

  /* A stroke is accepted as an EDGE only if it is long enough and
     straight enough. Rejections never cost the player anything — the
     stroke simply is not recorded, and the hint says why — so a stray
     tap, a dragged scroll or a whole box scribbled in one go all leave
     the round exactly as it was. */
  function finishStroke() {
    var seg = live ? fitSegment(live) : null;
    var bend = seg ? strokeBendRMS(live, seg) : 0;
    if (!seg || seg.len < minStroke()) {
      /* NEVER A DEAD TAP. fitSegment answers null for a press that never
         moved — one point is not a line — and that branch used to say
         nothing at all: the sheet swallowed the press, the edge counter
         did not move, and the first thing a beginner does on a blank
         canvas is tap it once to see what happens. Every sibling drill
         answers a tap in words; this one answered with silence, on the
         one screen where silence reads as "broken". */
      hint.textContent = seg
        ? 'too short to read as an edge — pull a longer line.'
        : 'that was a tap — press and pull one straight line for one edge.';
    } else if (bend > MAX_BEND * seg.len) {
      hint.textContent = 'that one curves — one straight stroke per edge, not a whole box in one go.';
    } else if (strokes.length >= MAX_EDGES) {
      hint.textContent = 'that is plenty of edges — check it.';
    } else {
      strokes.push({ pts: live, seg: seg });
      if (strokes.length === 1) {
        hint.textContent = 'see the dashes past its ends? that is your line extended — the whole trick is watching where it points.';
      } else if (strokes.length === MIN_EDGES) {
        /* the button's ✓ is decoration (aria-hidden in the markup), so the
           sentence that names the button does not read it out either */
        hint.textContent = '“check it” is live now — every extra edge gives the read more to work with.';
      } else if (strokes.length >= MAX_EDGES) {
        hint.textContent = 'that is plenty of edges — check it.';
      } else if (strokes.length < MIN_EDGES) {
        hint.textContent = (MIN_EDGES - strokes.length) + ' more edge' +
          (MIN_EDGES - strokes.length === 1 ? '' : 's') + ' and you can check it.';
      }
    }
    live = null;
    activePointer = null;
    activeType = '';
    updateBar();
    draw();
  }

  /* ---- check → critique → reveal → report (exactly once) ---- */
  function checkBox() {
    if (phase !== 'draw' || strokes.length < MIN_EDGES) return;
    phase = 'result';
    /* let go of any stroke still in flight before the score is banked,
       so nothing can be added to the drawing the analysis just read */
    if (activePointer !== null) {
      try { canvas.releasePointerCapture(activePointer); } catch (e) {}
    }
    live = null;
    activePointer = null;
    activeType = '';
    var segs = [], i;
    for (i = 0; i < strokes.length; i++) segs.push(strokes[i].seg);
    /* scoreOpts() is read BEFORE report(), so "has a previous best" is
       about earlier sessions and not about the score being handed in */
    result = analyzeBox(segs, scoreOpts());
    renderCritique(result);
    draw();
    var res = ArtDaily.report(result.score);
    hudScore.textContent = String(res.score);
    hudBest.textContent = res.best === null ? '–' : String(res.best);
    hint.textContent = 'every line is extended across the sheet. each marked point is a vanishing point — where one set of your edges wants to meet. “new round” for the next box.';
    updateBar();
    /* A first-ever round has no previous best, so isNewBest is
       trivially true and "new best!" celebrates nothing — on the one
       round where the number most needs saying what it IS. The SDK
       marks that round with isFirst; an older vendored SDK simply
       leaves it undefined and the old wording stands. */
    showToast(res.isFirst
      ? 'first score ' + res.score + ' / 100 — your mark to beat'
      : (res.isNewBest ? 'new best! ' : 'score ') + res.score + ' / 100', res.isNewBest);
  }

  /* One row per edge set. Each row is a button: pressing it spotlights
     that set on the sheet and dims the other two, pressing it again (or
     the lit row) drops back to the whole reveal. */
  function renderCritique(r) {
    critique.textContent = '';
    var i, f, v, row, axis, verdict, score, note;
    for (i = 0; i < r.families.length; i++) {
      f = r.families[i];
      v = verdictFor(f, r.tol);
      row = document.createElement('button');
      row.type = 'button';
      row.className = 'crit-row';
      row.setAttribute('aria-pressed', 'false');
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
      row.addEventListener('click', (function (idx) {
        return function () { setSpotlight(spotlight === idx ? -1 : idx); };
      })(i));
      critique.appendChild(row);
    }
    /* At most one whole-drawing note, and it names the cause the reader
       can act on. "No camera sees them together" described a pinhole
       model recovered from the orthocenter of the VP triangle — true,
       and unreadable by the person it was written for. */
    note = null;
    if (r.starved) {
      note = 'couldn’t sort these into three clean directions — draw the three families more distinctly (a box has edges going left, right and up) and check again. nothing was held against you for it.';
    } else if (r.notABox) {
      note = 'these three sets can’t all belong to one box: at least one is spreading where it should be closing. the reveal shows which — that is exactly the thing to fix next.';
      if (r.wobbly) note += ' your lines are also wobbling a fair bit, so steadiness is the quicker win.';
    } else if (r.wobbly) {
      note = 'your lines wobble more than they lean — that is a steadiness thing, not a perspective mistake. draw each edge in one confident pull and the read gets much sharper.';
    }
    if (note) {
      var p = document.createElement('p');
      p.className = 'crit-row crit-note';
      p.textContent = note;
      critique.appendChild(p);
    }
    critique.hidden = false;
  }

  function setSpotlight(idx) {
    spotlight = idx;
    var rows = critique.querySelectorAll('button.crit-row'), i;
    for (i = 0; i < rows.length; i++) {
      rows[i].setAttribute('aria-pressed', String(i === idx));
      rows[i].classList.toggle('is-lit', i === idx);
    }
    hint.textContent = (idx === -1)
      ? 'whole reveal — every line extended, and the point each set aims at. “new round” for the next box.'
      : 'showing just: ' + result.families[idx].label + ' — tap the row again to see all three.';
    draw();
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
  /* "new round" arms first when it would throw away a live round — a
     second press within the window confirms, otherwise it snaps back.
     A box that was never checked is never reported, so a mis-tap here
     used to wipe eleven hand-drawn edges without a word. (The five
     sibling drills all guard this button; this one did not.) */
  var btnRound = document.getElementById('btnRound');
  var roundArmTimer = null, roundArmed = false;
  function disarmRoundBtn() {
    roundArmed = false;
    clearTimeout(roundArmTimer);
    btnRound.innerHTML = 'new round <span aria-hidden="true">↻</span>';
  }
  btnRound.addEventListener('click', function () {
    if (phase === 'draw' && strokes.length && !roundArmed) {
      roundArmed = true;
      btnRound.textContent = 'discard round?';
      roundArmTimer = setTimeout(disarmRoundBtn, 2600);
      return;
    }
    disarmRoundBtn();
    newRound();
  });
  btnCheck.addEventListener('click', checkBox);
  btnUndo.addEventListener('click', undoStroke);
  btnClear.addEventListener('click', clearBox);

  var btnHow = document.getElementById('btnHow');
  var howTo = document.getElementById('howTo');
  btnHow.addEventListener('click', function () {
    howTo.hidden = !howTo.hidden;
    btnHow.setAttribute('aria-expanded', String(!howTo.hidden));
  });

  ArtDaily.onTheme(function () { inkCache = null; paintNow(); });

  /* The hardware changed mid-session (a laptop player plugged in a
     tablet). Every tolerance in the scorer is a function of it, so a
     reveal already on screen must be re-read rather than left claiming
     a standard it was not judged by. The score already reported for
     this round stands — reporting twice would be a lie about how many
     drills were done. */
  ArtDaily.onInput(function () {
    if (phase === 'result' && strokes.length) {
      var segs = [], i;
      for (i = 0; i < strokes.length; i++) segs.push(strokes[i].seg);
      result = analyzeBox(segs, scoreOpts());
      if (spotlight >= result.families.length) spotlight = -1;
      renderCritique(result);
    }
    draw();
  });

  /* One check per frame, not one per resize event: a dragged desktop
     window fires these faster than the sheet can be rebuilt. fitCanvas
     decides whether anything actually moved (height follows width, so an
     iOS toolbar collapsing mid-round is not a resize at all). */
  var resizeRaf = 0;
  window.addEventListener('resize', function () {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(function () {
      resizeRaf = 0;
      if (!fitCanvas()) return;   /* nothing moved, and nothing was cleared */
      paintNow();   /* fitCanvas already blanked the sheet — no empty frame */
    });
  });

  /* ---- boot ---- */
  fitCanvas();
  var best = ArtDaily.best();
  hudBest.textContent = best === null ? '–' : String(best);
  newRound();
})();
