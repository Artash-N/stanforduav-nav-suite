"""
Theta* (weighted LOS) with turn-penalty knobs.

Save as:
    backend/algorithms/plugins/theta_star.py

What it does
------------
- Theta* rewires parents using line-of-sight (LOS) to reduce jerkiness vs grid A*.
- This version respects multiplier zones by integrating weighted cost along LOS segments.
- Adds an optional turn penalty to prefer straighter, UAV-friendlier paths.

Tuning (top-of-file)
--------------------
- TURN_WEIGHT: scales how much turns are discouraged (meters-equivalent).
- TURN_POWER: 1.0 linear, 2.0 quadratic (punishes sharp turns more).
- UTURN_MULT: extra multiplier if the turn angle is very large (near U-turn).
- UTURN_THRESHOLD_RAD: threshold angle (radians) above which UTURN_MULT applies.

Override via options (optional)
-------------------------------
If your RunOptions supports arbitrary fields, you can override:
- options.turn_weight
- options.turn_power
- options.u_turn_mult
- options.u_turn_threshold_rad
"""

from __future__ import annotations

from dataclasses import dataclass
from heapq import heappop, heappush
from math import acos, inf, sqrt
from typing import Dict, List, Tuple

from ..types import AlgorithmResult, AlgorithmSpec, GridProblem, RunOptions

ALGORITHM = AlgorithmSpec(
    id="theta-star",
    name="Theta* (weighted LOS + turn penalty)",
    description="Smoother paths via LOS parent rewiring; integrates zone multipliers; penalizes turns.",
)

# =========================
# Turn-penalty parameters
# =========================
TURN_WEIGHT: float = 12.0          # meters-equivalent; increase to reduce turning
TURN_POWER: float = 2.0           # 1.0 linear, 2.0 quadratic
UTURN_MULT: float = 2.0           # extra penalty multiplier for near U-turns
UTURN_THRESHOLD_RAD: float = 2.35 # ~135 degrees in radians

# =========================
# Misc parameters
# =========================
MAX_GUARD_STEPS_FACTOR: int = 8   # guard to prevent infinite loops in LOS traversal


SQRT2 = sqrt(2.0)


@dataclass(frozen=True)
class _PQItem:
    f: float
    g: float
    node: int


def run(problem: GridProblem, options: RunOptions) -> AlgorithmResult:
    start = problem.start
    goal = problem.goal

    if start == goal:
        return AlgorithmResult(
            path=[start],
            visited=[start] if options.return_visited else [],
            expanded=0,
            cost=0.0,
        )

    cell_size = float(problem.cell_size_m)

    # Heuristic scaling: use minimum cost multiplier to keep it admissible.
    min_mult = _safe_min_multiplier(problem)

    def heuristic(a: int, b: int) -> float:
        ax, ay = _cell_center_m(problem, a, cell_size)
        bx, by = _cell_center_m(problem, b, cell_size)
        dx = ax - bx
        dy = ay - by
        return sqrt(dx * dx + dy * dy) * min_mult

    # g-score and parent pointers
    g: Dict[int, float] = {start: 0.0}
    parent: Dict[int, int] = {start: start}

    # priority queue: (f, g, node)
    open_heap: List[Tuple[float, float, int]] = []
    heappush(open_heap, (heuristic(start, goal), 0.0, start))

    closed: set[int] = set()
    visited_out: List[int] = []
    expanded = 0

    # Pull tuning knobs (options override top-of-file defaults if present)
    turn_weight = float(getattr(options, "turn_weight", TURN_WEIGHT))
    turn_power = float(getattr(options, "turn_power", TURN_POWER))
    uturn_mult = float(getattr(options, "u_turn_mult", UTURN_MULT))
    uturn_thresh = float(getattr(options, "u_turn_threshold_rad", UTURN_THRESHOLD_RAD))

    while open_heap:
        f_cur, g_cur, s = heappop(open_heap)
        if s in closed:
            continue

        closed.add(s)
        expanded += 1

        if options.return_visited and len(visited_out) < options.max_visited:
            visited_out.append(s)

        if s == goal:
            path = _reconstruct_path(parent, start, goal)
            return AlgorithmResult(path=path, visited=visited_out, expanded=expanded, cost=g[s])

        ps = parent.get(s, s)

        # Expand to 8-connected neighbors
        for s2, _unused_step_dist in problem.neighbors8(s):
            if s2 in closed:
                continue

            # Baseline: connect s -> s2
            step_dist = _neighbor_step_distance(problem, s, s2, cell_size)
            base_cost = float(problem.step_cost(s2, step_dist))
            base_turn_pen = _turn_penalty(problem, parent.get(s, s), s, s2, cell_size,
                                          turn_weight, turn_power, uturn_mult, uturn_thresh)
            best_parent = s
            best_tentative = g[s] + base_cost + base_turn_pen

            # Theta* rewiring attempt: connect parent[s] -> s2 if LOS exists
            # (skip s if possible)
            if ps != s:
                has_los, los_cost = _los_cost(problem, ps, s2, cell_size)
                if has_los:
                    los_turn_pen = _turn_penalty(problem, parent.get(ps, ps), ps, s2, cell_size,
                                                 turn_weight, turn_power, uturn_mult, uturn_thresh)
                    cand = g[ps] + los_cost + los_turn_pen
                    if cand < best_tentative:
                        best_tentative = cand
                        best_parent = ps

            # Relaxation
            if best_tentative < g.get(s2, inf):
                g[s2] = best_tentative
                parent[s2] = best_parent
                heappush(open_heap, (best_tentative + heuristic(s2, goal), best_tentative, s2))

    return AlgorithmResult(
        path=[],
        visited=visited_out if options.return_visited else [],
        expanded=expanded,
        cost=inf,
    )


# =========================
# Helpers
# =========================

def _safe_min_multiplier(problem: GridProblem) -> float:
    """
    Best-effort min multiplier to keep heuristic admissible.
    Falls back to 1.0 if unavailable.
    """
    try:
        # cost_multiplier is typically a list/array of floats indexed by cell_id.
        mm = float(min(problem.cost_multiplier))  # type: ignore[arg-type]
        if mm <= 0:
            return 1.0
        return mm
    except Exception:
        return 1.0


def _reconstruct_path(parent: Dict[int, int], start: int, goal: int) -> List[int]:
    # Parent pointers can skip nodes; UI accepts this node chain.
    path: List[int] = []
    cur = goal
    guard = 0
    while True:
        path.append(cur)
        if cur == start:
            break
        nxt = parent.get(cur, cur)
        if nxt == cur:
            return []
        cur = nxt
        guard += 1
        if guard > 5_000_000:
            return []
    path.reverse()
    return path


def _neighbor_step_distance(problem: GridProblem, a: int, b: int, cell_size: float) -> float:
    ar, ac = problem.to_row_col(a)
    br, bc = problem.to_row_col(b)
    dr = abs(br - ar)
    dc = abs(bc - ac)
    if dr == 1 and dc == 1:
        return cell_size * SQRT2
    return cell_size


def _cell_center_m(problem: GridProblem, cell_id: int, cell_size: float) -> Tuple[float, float]:
    """
    Prefer problem.cell_center_m(cell_id) if it exists, otherwise derive from row/col.
    """
    fn = getattr(problem, "cell_center_m", None)
    if callable(fn):
        x, y = fn(cell_id)
        return float(x), float(y)

    r, c = problem.to_row_col(cell_id)
    return (float(c) + 0.5) * cell_size, (float(r) + 0.5) * cell_size


def _turn_penalty(
    problem: GridProblem,
    a: int,
    b: int,
    c: int,
    cell_size: float,
    turn_weight: float,
    turn_power: float,
    uturn_mult: float,
    uturn_threshold_rad: float,
) -> float:
    """
    Penalize heading changes for a -> b -> c.

    Returns a meters-equivalent penalty. If turn_weight=0, returns 0.
    """
    if turn_weight <= 0:
        return 0.0
    if a == b or b == c:
        return 0.0

    ax, ay = _cell_center_m(problem, a, cell_size)
    bx, by = _cell_center_m(problem, b, cell_size)
    cx, cy = _cell_center_m(problem, c, cell_size)

    v1x, v1y = bx - ax, by - ay
    v2x, v2y = cx - bx, cy - by

    n1 = sqrt(v1x * v1x + v1y * v1y)
    n2 = sqrt(v2x * v2x + v2y * v2y)
    if n1 == 0.0 or n2 == 0.0:
        return 0.0

    cos_theta = (v1x * v2x + v1y * v2y) / (n1 * n2)
    cos_theta = max(-1.0, min(1.0, cos_theta))
    theta = acos(cos_theta)

    # Base penalty: weight * theta^power
    pen = turn_weight * (theta ** max(0.0, turn_power))

    # Extra penalty for near U-turns
    if theta >= uturn_threshold_rad:
        pen *= uturn_mult

    return pen


def _los_cost(problem: GridProblem, a: int, b: int, cell_size: float) -> Tuple[bool, float]:
    """
    Returns (has_line_of_sight, cost) from a to b.

    LOS exists iff every cell touched by the segment is non-blocked.
    Cost is the sum of weighted per-step costs along the traversed cell sequence:
        step_cost = step_distance_m * cost_multiplier[to_cell]
    """
    cells = _bresenham_cells(problem, a, b)
    if not cells:
        return False, inf

    for cid in cells:
        if problem.is_blocked(cid):
            return False, inf

    total = 0.0
    for i in range(1, len(cells)):
        prev_id = cells[i - 1]
        cur_id = cells[i]
        step_dist = _neighbor_step_distance(problem, prev_id, cur_id, cell_size)
        total += float(problem.step_cost(cur_id, step_dist))
    return True, total


def _bresenham_cells(problem: GridProblem, a: int, b: int) -> List[int]:
    """
    Enumerate grid cells intersected by the segment from center(a) to center(b),
    using an integer Bresenham traversal over (col,row).

    This yields a connected sequence of cells approximating the segment.

    Note: Not a perfect "supercover", but stable and fast for LOS checks + cost integration.
    """
    ar, ac = problem.to_row_col(a)
    br, bc = problem.to_row_col(b)

    x0, y0 = ac, ar
    x1, y1 = bc, br

    dx = abs(x1 - x0)
    dy = abs(y1 - y0)

    sx = 1 if x0 < x1 else -1
    sy = 1 if y0 < y1 else -1

    err = dx - dy

    cells: List[int] = []
    x, y = x0, y0

    guard = 0
    guard_max = max(problem.width, problem.height) * MAX_GUARD_STEPS_FACTOR + 64

    while True:
        if 0 <= x < problem.width and 0 <= y < problem.height:
            cells.append(problem.to_id(x, y))
        else:
            return []

        if x == x1 and y == y1:
            break

        e2 = 2 * err
        if e2 > -dy:
            err -= dy
            x += sx
        if e2 < dx:
            err += dx
            y += sy

        guard += 1
        if guard > guard_max:
            return []

    return cells
