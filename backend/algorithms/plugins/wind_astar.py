from __future__ import annotations

import heapq
from math import cos, inf, radians, sqrt

from ..types import AlgorithmResult, AlgorithmSpec, GridProblem, RunOptions, reconstruct_path

ALGORITHM = AlgorithmSpec(
    id="wind_astar",
    name="A* (Wind-Aware)",
    description="A* with uniform wind field cost adjustments.",
)


def _wind_cost_factor(
    wind_dir_deg: float,
    wind_speed_ms: float,
    drone_airspeed_ms: float,
    movement_dir_deg: float,
) -> float:
    """Calculate wind cost factor for a movement direction.

    Returns a multiplier > 0 applied to the base step cost.
    Values < 1.0: tailwind (energy savings)
    Values > 1.0: headwind/crosswind (energy cost increase)
    """
    if wind_speed_ms <= 0:
        return 1.0

    wind_rad = radians(wind_dir_deg)
    move_rad = radians(movement_dir_deg)

    angle_diff = wind_rad - move_rad
    wind_component_along_path = wind_speed_ms * cos(angle_diff)

    ground_speed = drone_airspeed_ms + wind_component_along_path

    if ground_speed <= 0.1:
        return 1000.0

    return drone_airspeed_ms / ground_speed


def _movement_direction_deg(
    problem: GridProblem,
    from_id: int,
    to_id: int,
) -> float:
    """Calculate movement direction in degrees (0-360) for a step."""
    fx, fy = problem.cell_center_m(from_id)
    tx, ty = problem.cell_center_m(to_id)
    dx = tx - fx
    dy = ty - fy
    return degrees_from_vector(dx, dy)


def degrees_from_vector(dx: float, dy: float) -> float:
    """Convert vector (dx, dy) to degrees (0-360, where 0=East, 90=North)."""
    deg = 0.0
    if dy != 0 or dx != 0:
        from math import atan2
        deg = atan2(dy, dx)
        deg = (deg * 180.0 / 3.141592653589793) % 360.0
    return deg


def run(problem: GridProblem, options: RunOptions) -> AlgorithmResult:
    n = problem.size()
    start = problem.start
    goal = problem.goal

    wind_enabled = getattr(options, "wind_enabled", False)
    wind_dir_deg = getattr(options, "wind_direction_deg", 0.0)
    wind_speed_ms = getattr(options, "wind_speed_ms", 0.0)
    drone_airspeed_ms = getattr(options, "drone_airspeed_ms", 10.0)

    min_mult = 1.0
    try:
        min_mult = min(problem.cost_multiplier)
        if not (min_mult > 0):
            min_mult = 1.0
    except Exception:
        min_mult = 1.0

    if wind_enabled and wind_speed_ms > 0:
        min_wind_factor = _wind_cost_factor(wind_dir_deg, wind_speed_ms, drone_airspeed_ms, wind_dir_deg)
        min_mult *= min_wind_factor

    g = [inf] * n
    g[start] = 0.0
    came_from = [-1] * n

    pq: list[tuple[float, float, int]] = [(problem.heuristic_euclidean_m(start, min_mult), 0.0, start)]

    visited_out = []
    expanded = 0

    while pq:
        f, cur_g, cur = heapq.heappop(pq)
        if cur_g != g[cur]:
            continue

        expanded += 1
        if options.return_visited and len(visited_out) < options.max_visited:
            visited_out.append(cur)

        if cur == goal:
            break

        for nxt, step_dist in problem.neighbors8(cur):
            base_cost = problem.step_cost(nxt, step_dist)
            actual_cost = base_cost

            if wind_enabled and wind_speed_ms > 0:
                move_dir = _movement_direction_deg(problem, cur, nxt)
                wind_factor = _wind_cost_factor(wind_dir_deg, wind_speed_ms, drone_airspeed_ms, move_dir)
                actual_cost = base_cost * wind_factor

            ng = cur_g + actual_cost
            if ng < g[nxt]:
                g[nxt] = ng
                came_from[nxt] = cur
                h = problem.heuristic_euclidean_m(nxt, min_mult)
                heapq.heappush(pq, (ng + h, ng, nxt))

    path = reconstruct_path(came_from, start, goal)
    cost = g[goal] if path else float('inf')
    if cost == float('inf'):
        cost = 1e30
    return AlgorithmResult(path=path, visited=visited_out, expanded=expanded, cost=cost)
