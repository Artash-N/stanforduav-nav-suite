from __future__ import annotations

import heapq
from math import inf

from ..types import AlgorithmResult, AlgorithmSpec, GridProblem, RunOptions, reconstruct_path

ALGORITHM = AlgorithmSpec(
    id="dijkstra",
    name="Dijkstra",
    description="Optimal shortest path w.r.t. step distance * cost multiplier.",
)


def run(problem: GridProblem, options: RunOptions) -> AlgorithmResult:
    n = problem.size()
    start = problem.start
    goal = problem.goal

    dist = [inf] * n
    dist[start] = 0.0
    came_from = [-1] * n

    pq: list[tuple[float, int]] = [(0.0, start)]
    visited_out = []
    expanded = 0

    while pq:
        d, cur = heapq.heappop(pq)
        if d != dist[cur]:
            continue
        expanded += 1
        if options.return_visited and len(visited_out) < options.max_visited:
            visited_out.append(cur)

        if cur == goal:
            break

        for nxt, step_dist in problem.neighbors8(cur):
            nd = d + problem.step_cost(nxt, step_dist)
            if nd < dist[nxt]:
                dist[nxt] = nd
                came_from[nxt] = cur
                heapq.heappush(pq, (nd, nxt))

    path = reconstruct_path(came_from, start, goal)
    cost = dist[goal] if path else inf
    return AlgorithmResult(path=path, visited=visited_out, expanded=expanded, cost=cost)
