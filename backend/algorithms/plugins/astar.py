from __future__ import annotations

import heapq
from math import inf

from ..types import AlgorithmResult, AlgorithmSpec, GridProblem, RunOptions, reconstruct_path

ALGORITHM = AlgorithmSpec(
    id="astar",
    name="A*",
    description="A* with Euclidean heuristic (scaled for multipliers).",
)


def run(problem: GridProblem, options: RunOptions) -> AlgorithmResult:
    n = problem.size()
    start = problem.start
    goal = problem.goal

    # Min multiplier used to keep heuristic admissible even if you have encouraged (<1) zones.
    try:
        min_mult = min(problem.cost_multiplier)
        if not (min_mult > 0):
            min_mult = 1.0
    except Exception:
        min_mult = 1.0

    g = [inf] * n
    g[start] = 0.0
    came_from = [-1] * n

    # (f, g, node)
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
            ng = cur_g + problem.step_cost(nxt, step_dist)
            if ng < g[nxt]:
                g[nxt] = ng
                came_from[nxt] = cur
                h = problem.heuristic_euclidean_m(nxt, min_mult)
                heapq.heappush(pq, (ng + h, ng, nxt))

    path = reconstruct_path(came_from, start, goal)
    cost = g[goal] if path else inf
    return AlgorithmResult(path=path, visited=visited_out, expanded=expanded, cost=cost)
