// A* (A-Star) shortest-path algorithm.
//
// Pure TypeScript implementation — no native deps, suitable for the
// React Native bundle.  Used by the Tracking + Ride Detail screens to
// compute a path from the driver's current location to the rider's
// pickup once a booking is Confirmed.
//
// Why A* and not Dijkstra/BFS?
//   * BFS ignores edge weights — bad for distance-weighted maps.
//   * Dijkstra is correct but explores every node up to the goal's
//     distance.  On a 60×60 grid that's 3 600 expansions worst-case.
//   * A* uses an admissible heuristic to prune the frontier toward the
//     goal — typical real-world expansion is 5-15 % of Dijkstra.
//
// The heuristic we use is the great-circle (haversine) distance from a
// node to the goal, which is **always ≤ true road distance** between
// any two real-world points.  That's the definition of admissible, so
// A* with this heuristic is guaranteed to return the optimal path
// (lowest total g-cost).
//
// Graph used here is a regular NxN grid built between the start and
// goal lat/lng with a configurable margin.  Each cell has 8-direction
// connectivity (orthogonal + diagonal) so the path can step at any
// angle.  Edge cost = haversine distance between cell centres.  Cells
// can be flagged as blocked via the `isBlocked` callback so callers
// can layer in obstacles (e.g. water, no-go zones) later without
// touching the algorithm.

export type LatLng = { lat: number; lng: number };

export type AStarOptions = {
  /** Number of grid cells per side. Total nodes = N×N. Default 60. */
  gridSize?: number;
  /**
   * Extra padding around the start/goal bounding box, in *cells*.  Lets
   * the optimal path bow out around obstacles instead of being forced
   * along the start-goal axis.  Default 4 cells of margin.
   */
  marginCells?: number;
  /**
   * Optional obstacle predicate — return true to forbid the path from
   * crossing this cell.  Receives the *centre* lat/lng of the cell.
   * Defaults to "no obstacles".
   */
  isBlocked?: (latLng: LatLng) => boolean;
  /**
   * Optional terrain-cost multiplier — return a number ≥ 1 to make a
   * cell more expensive to traverse without forbidding it.  E.g. value
   * 1.5 = 50 % more expensive.  Defaults to 1 (uniform).
   */
  terrainCost?: (latLng: LatLng) => number;
};

export type AStarResult = {
  /**
   * Path of lat/lng points from start to goal, inclusive.  Empty when
   * the search exhausted the open set without finding the goal.
   */
  path: LatLng[];
  /** Total path length in metres (haversine, summed). */
  distanceMeters: number;
  /** How many cells were expanded — useful for instrumentation. */
  expanded: number;
  /** Whether the goal was actually reached. */
  found: boolean;
  /** Grid size used (helps debug rendering). */
  gridSize: number;
};

const EARTH_RADIUS_M = 6371000;

/** Great-circle distance between two lat/lng points, in metres. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

// 8-direction movement offsets (row delta, col delta).
const NEIGHBOURS: Array<[number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1]
];

/**
 * Compute the shortest path between two real-world points using A* on
 * a grid graph.
 *
 * Implementation outline:
 *  1. Build a NxN grid spanning the start/goal bounding box (+ margin).
 *  2. Snap start and goal to their containing cells.
 *  3. Run A*:
 *      - openSet:  min-heap ordered by f(n) = g(n) + h(n)
 *      - closedSet: bool[] — once expanded, never re-explored
 *      - cameFrom:  parent index per node, used for path reconstruction
 *      - gScore:    best known cost from start to each node
 *      - fScore:    gScore + heuristic
 *  4. On goal, walk cameFrom → reverse → return.
 *
 * Worst-case complexity: O(E·log V) ≈ O(8·N²·log N²).  At N=60 that's
 * ~57k log-2 ops, well under 30 ms on a phone.
 */
export function findPathAStar(
  start: LatLng,
  goal: LatLng,
  options: AStarOptions = {}
): AStarResult {
  const N = clampInt(options.gridSize ?? 60, 8, 120);
  const margin = clampInt(options.marginCells ?? 4, 0, N / 2);
  const blocked = options.isBlocked;
  const terrain = options.terrainCost;

  // Defensive: if either endpoint isn't a finite number, return an empty
  // result instead of building a NaN grid.  A NaN-laden polyline would
  // crash react-native-maps native code.
  if (
    !start ||
    !goal ||
    !Number.isFinite(start.lat) ||
    !Number.isFinite(start.lng) ||
    !Number.isFinite(goal.lat) ||
    !Number.isFinite(goal.lng)
  ) {
    return { path: [], distanceMeters: 0, expanded: 0, found: false, gridSize: N };
  }
  // Same-point optimisation: nothing to search.
  if (
    Math.abs(start.lat - goal.lat) < 1e-9 &&
    Math.abs(start.lng - goal.lng) < 1e-9
  ) {
    return {
      path: [start, goal],
      distanceMeters: 0,
      expanded: 0,
      found: true,
      gridSize: N
    };
  }

  // 1. Bounding box (with margin in *cells* — converted to lat/lng below).
  const minLat = Math.min(start.lat, goal.lat);
  const maxLat = Math.max(start.lat, goal.lat);
  const minLng = Math.min(start.lng, goal.lng);
  const maxLng = Math.max(start.lng, goal.lng);

  // Cell size in degrees, BEFORE margin expansion.
  const innerLatStep = Math.max((maxLat - minLat) / Math.max(N - 1, 1), 1e-7);
  const innerLngStep = Math.max((maxLng - minLng) / Math.max(N - 1, 1), 1e-7);

  // Pad the bbox by `margin` cells on each side and recompute step.
  const paddedMinLat = minLat - margin * innerLatStep;
  const paddedMaxLat = maxLat + margin * innerLatStep;
  const paddedMinLng = minLng - margin * innerLngStep;
  const paddedMaxLng = maxLng + margin * innerLngStep;

  const latStep = (paddedMaxLat - paddedMinLat) / Math.max(N - 1, 1);
  const lngStep = (paddedMaxLng - paddedMinLng) / Math.max(N - 1, 1);

  function cellCentre(row: number, col: number): LatLng {
    return {
      lat: paddedMinLat + row * latStep,
      lng: paddedMinLng + col * lngStep
    };
  }
  function snap(p: LatLng): { row: number; col: number } {
    const row = Math.round((p.lat - paddedMinLat) / latStep);
    const col = Math.round((p.lng - paddedMinLng) / lngStep);
    return {
      row: clampInt(row, 0, N - 1),
      col: clampInt(col, 0, N - 1)
    };
  }
  const idx = (row: number, col: number) => row * N + col;

  const startCell = snap(start);
  const goalCell = snap(goal);
  const startIdx = idx(startCell.row, startCell.col);
  const goalIdx = idx(goalCell.row, goalCell.col);

  // 2. State arrays — flat for cache friendliness.
  const total = N * N;
  const gScore = new Float64Array(total);
  const fScore = new Float64Array(total);
  const cameFrom = new Int32Array(total);
  const closed = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    gScore[i] = Infinity;
    fScore[i] = Infinity;
    cameFrom[i] = -1;
  }
  gScore[startIdx] = 0;
  fScore[startIdx] = haversineMeters(start, goal);

  // 3. Priority queue — binary heap keyed on fScore.
  const open = new MinHeap();
  open.push(startIdx, fScore[startIdx]);

  let expanded = 0;
  let foundGoal = false;

  while (open.size > 0) {
    const current = open.pop();
    if (current === undefined) break;
    if (closed[current]) continue;
    closed[current] = 1;
    expanded++;

    if (current === goalIdx) {
      foundGoal = true;
      break;
    }

    const cRow = Math.floor(current / N);
    const cCol = current % N;
    const cCentre = cellCentre(cRow, cCol);

    for (const [dRow, dCol] of NEIGHBOURS) {
      const nRow = cRow + dRow;
      const nCol = cCol + dCol;
      if (nRow < 0 || nRow >= N || nCol < 0 || nCol >= N) continue;

      const nIdx = idx(nRow, nCol);
      if (closed[nIdx]) continue;

      const nCentre = cellCentre(nRow, nCol);
      if (blocked && blocked(nCentre)) continue;

      const stepCost =
        haversineMeters(cCentre, nCentre) * (terrain ? terrain(nCentre) : 1);
      const tentative = gScore[current] + stepCost;
      if (tentative >= gScore[nIdx]) continue;

      cameFrom[nIdx] = current;
      gScore[nIdx] = tentative;
      // Tie-break: prefer paths that head toward the goal directly.
      // This keeps A* tight along the start→goal axis when there are
      // no obstacles, instead of fanning out symmetrically.
      const h = haversineMeters(nCentre, goal);
      fScore[nIdx] = tentative + h * 1.0001;
      open.push(nIdx, fScore[nIdx]);
    }
  }

  // 4. Reconstruct path.  When we didn't reach the goal, return the
  // partial path to the lowest-f node we expanded so the caller can
  // still draw something useful.
  let endIdx = foundGoal ? goalIdx : startIdx;
  if (!foundGoal) {
    let bestF = Infinity;
    for (let i = 0; i < total; i++) {
      if (!closed[i]) continue;
      if (fScore[i] < bestF) {
        bestF = fScore[i];
        endIdx = i;
      }
    }
  }

  const reverse: LatLng[] = [];
  let walk = endIdx;
  // Cap the walk to avoid pathological loops if cameFrom ever cycles
  // (it shouldn't — but defensive).
  let safety = total + 1;
  while (walk !== -1 && safety-- > 0) {
    const r = Math.floor(walk / N);
    const c = walk % N;
    reverse.push(cellCentre(r, c));
    if (walk === startIdx) break;
    walk = cameFrom[walk];
  }
  reverse.reverse();

  // Stitch the *exact* user-supplied start and goal onto the path so
  // the polyline visually anchors to the markers, not to grid centres.
  const path: LatLng[] =
    reverse.length === 0 ? [] : [start, ...reverse.slice(1, -1), foundGoal ? goal : reverse[reverse.length - 1]];

  // 5. Sum path length.
  let distance = 0;
  for (let i = 1; i < path.length; i++) {
    distance += haversineMeters(path[i - 1], path[i]);
  }

  return {
    path,
    distanceMeters: distance,
    expanded,
    found: foundGoal,
    gridSize: N
  };
}

// ---------------------------------------------------------------------
// Min-heap priority queue keyed on f-score.  Standard implementation:
// node values stored in two parallel arrays so we don't allocate a
// wrapper object per push.
// ---------------------------------------------------------------------
class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];

  get size(): number {
    return this.ids.length;
  }

  push(id: number, key: number): void {
    this.ids.push(id);
    this.keys.push(key);
    this.bubbleUp(this.ids.length - 1);
  }

  pop(): number | undefined {
    const n = this.ids.length;
    if (n === 0) return undefined;
    const top = this.ids[0];
    const lastId = this.ids.pop()!;
    const lastKey = this.keys.pop()!;
    if (n > 1) {
      this.ids[0] = lastId;
      this.keys[0] = lastKey;
      this.sinkDown(0);
    }
    return top;
  }

  private bubbleUp(i: number) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[i] < this.keys[parent]) {
        this.swap(i, parent);
        i = parent;
      } else {
        return;
      }
    }
  }

  private sinkDown(i: number) {
    const n = this.ids.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let smallest = i;
      if (l < n && this.keys[l] < this.keys[smallest]) smallest = l;
      if (r < n && this.keys[r] < this.keys[smallest]) smallest = r;
      if (smallest === i) return;
      this.swap(i, smallest);
      i = smallest;
    }
  }

  private swap(a: number, b: number) {
    const ti = this.ids[a];
    const tk = this.keys[a];
    this.ids[a] = this.ids[b];
    this.keys[a] = this.keys[b];
    this.ids[b] = ti;
    this.keys[b] = tk;
  }
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
