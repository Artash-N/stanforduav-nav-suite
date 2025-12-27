from __future__ import annotations

from math import inf

from ..types import AlgorithmResult, AlgorithmSpec, GridProblem, RunOptions, path_cost, reconstruct_path

ALGORITHM = AlgorithmSpec(
    id="dfs",
    name="DFS (unweighted)",
    description="Depth-first search (ignores cost multipliers).",
)


def run(problem: GridProblem, options: RunOptions) -> AlgorithmResult:
    n = problem.size()
    start = problem.start
    goal = problem.goal

    came_from = [-1] * n
    visited_flags = [False] * n

    stack = [start]
    visited_flags[start] = True

    visited_out = []
    expanded = 0

    while stack:
        cur = stack.pop()
        expanded += 1
        if options.return_visited and len(visited_out) < options.max_visited:
            visited_out.append(cur)

        if cur == goal:
            break

        # neighbors8 yields in a fixed order; DFS behavior depends on that order.
        for nxt, _dist in problem.neighbors8(cur):
            if visited_flags[nxt]:
                continue
            visited_flags[nxt] = True
            came_from[nxt] = cur
            stack.append(nxt)

    path = reconstruct_path(came_from, start, goal)
    cost = path_cost(problem, path) if path else inf

    return AlgorithmResult(path=path, visited=visited_out, expanded=expanded, cost=cost)
