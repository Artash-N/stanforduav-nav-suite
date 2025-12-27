# Algorithm API (Python Plugins)

This document is the **authoritative reference** for writing navigation algorithms
for the Stanford UAV Navigation Tooling Suite.

If you're a nav team member, **this is the only part you need** to implement a
new pathfinding approach:

```
backend/algorithms/plugins/
```

Everything else (GUI, grid construction, polygon rasterization) is handled for you.

---

## Big picture

1. The GUI lets you:
   - choose a **planning area** (rectangle)
   - select a **grid resolution** in meters
   - draw zones:
     - **No-fly** polygons (buffered by 10m) → become blocked cells
     - **Cost** polygons → become multiplicative costs
   - set **start** and **goal** points

2. The frontend builds a grid and sends this **GridProblem** to the Python backend.

3. The backend calls your plugin:

```py
result = run(problem, options)
```

4. The GUI visualizes:
   - the returned `path`
   - optionally, your `visited` list as explored nodes

---

## Files you touch

### Add a new algorithm

Create a new file:

```
backend/algorithms/plugins/my_algo.py
```

Copy/paste from:

```
backend/algorithms/plugins/_template.py
```

The backend auto-loads plugins on startup.

In dev, the backend runs with auto-reload, so saving the file updates the server.

---

## The required plugin interface

Every plugin must define two things:

### 1) `ALGORITHM: AlgorithmSpec`

```py
from backend.algorithms.types import AlgorithmSpec

ALGORITHM = AlgorithmSpec(
    id="astar",
    name="A*",
    description="A* search with Euclidean heuristic",
)
```

The UI dropdown uses `id` and `name`.

### 2) `run(problem: GridProblem, options: RunOptions) -> AlgorithmResult`

```py
from backend.algorithms.types import AlgorithmResult, GridProblem, RunOptions

def run(problem: GridProblem, options: RunOptions) -> AlgorithmResult:
    ...
```

---

## GridProblem (your input)

You do **not** receive latitude/longitude.
You receive a clean, algorithm-friendly grid abstraction.

### Core fields

- `problem.width: int`
- `problem.height: int`
- `problem.cell_size_m: float`
- `problem.start: int` (cell id)
- `problem.goal: int` (cell id)
- `problem.blocked: list[bool]` (length = width*height)
- `problem.cost_multiplier: list[float]` (length = width*height)

Cell ids are **row-major**:

```text
id = row * width + col
```

### Helpers you should use

#### Coordinate helpers

```py
col, row = problem.to_row_col(cell_id)
cell_id = problem.to_id(col, row)
```

#### Block / cost helpers

```py
problem.is_blocked(cell_id)        # bool
problem.get_multiplier(cell_id)    # float (>=0)
```

#### Neighbors (8-connected)

```py
for nid, step_dist_m in problem.neighbors8(cell_id):
    ...
```

This yields **only valid, in-bounds, non-blocked** neighbors.

The step distance is:
- orthogonal: `cell_size_m`
- diagonal: `cell_size_m * sqrt(2)`

#### Standard step cost

```py
edge_cost = problem.step_cost(nid, step_dist_m)
```

By default, step cost is:

```text
step_dist_m * cost_multiplier[nid]
```

You are free to define your own cost model (battery, wind, risk, etc.), but the
helpers make it consistent across algorithms.

#### Admissible A* heuristic

```py
h = problem.heuristic_euclidean_m(cell_id)
```

If you allow multipliers < 1.0 (encouraged zones), scale by the minimum possible
multiplier to remain admissible:

```py
min_m = 0.5  # example
h = problem.heuristic_euclidean_m(cell_id, min_multiplier=min_m)
```

---

## RunOptions (input)

`options.return_visited: bool`

If true, the UI will display explored nodes.

`options.max_visited: int`

Hard cap for how many visited nodes you should return.
Returning millions will slow the UI.

---

## AlgorithmResult (your output)

You must return:

```py
AlgorithmResult(
    path=[...],        # list[int] cell ids from start -> goal
    visited=[...],     # list[int] explored cell ids (optional)
    expanded=1234,     # int
    cost=567.8,        # float (inf if no path)
)
```

### Path rules

- `path` must be a list of **cell ids**.
- It should include start and goal.
- If there is no valid route: `path=[]` and `cost=inf`.

### Visited rules

- Only return visited nodes if `options.return_visited` is True.
- Respect `options.max_visited`.

---

## Minimal working example (Dijkstra)

```py
from __future__ import annotations

from heapq import heappop, heappush
from math import inf

from ..types import AlgorithmResult, AlgorithmSpec, GridProblem, RunOptions, reconstruct_path

ALGORITHM = AlgorithmSpec(id="dijkstra_min", name="Dijkstra (min)")


def run(problem: GridProblem, options: RunOptions) -> AlgorithmResult:
    n = problem.size()
    dist = [inf] * n
    came = [-1] * n
    dist[problem.start] = 0.0

    pq: list[tuple[float, int]] = [(0.0, problem.start)]
    visited: list[int] = []
    expanded = 0

    while pq:
        d, u = heappop(pq)
        if d != dist[u]:
            continue
        expanded += 1
        if options.return_visited and len(visited) < options.max_visited:
            visited.append(u)

        if u == problem.goal:
            break

        for v, step_dist in problem.neighbors8(u):
            nd = d + problem.step_cost(v, step_dist)
            if nd < dist[v]:
                dist[v] = nd
                came[v] = u
                heappush(pq, (nd, v))

    path = reconstruct_path(came, problem.start, problem.goal)
    cost = dist[problem.goal] if path else inf
    return AlgorithmResult(path=path, visited=visited, expanded=expanded, cost=cost)
```
