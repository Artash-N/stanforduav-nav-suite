"""Template algorithm plugin (copy/paste starter).

The navigation team writes algorithms in **Python**. The UI sends a fully-built
grid (blocked cells + cost multipliers + start + goal) to the backend, and the
backend calls your plugin's `run()`.

Where this file lives
---------------------
Put your plugin file in:

    backend/algorithms/plugins/

The backend auto-discovers anything in that folder on startup. In dev we run
uvicorn with `--reload`, so saving a plugin file restarts the backend and picks
up changes.

What you must provide
---------------------
Every plugin MUST define:

1) `ALGORITHM` (AlgorithmSpec)
   - `id`: unique string (used by the UI dropdown)
   - `name`: human-readable
   - `description`: optional

2) `run(problem: GridProblem, options: RunOptions) -> AlgorithmResult`

Algorithm contract
------------------
- The grid is **8-connected** (N,S,E,W + diagonals).
- Diagonal step distance is `cell_size_m * sqrt(2)`.
- The standard edge cost we use is:

      step_cost = step_distance_m * cost_multiplier[to_cell]

  where `cost_multiplier` comes from user-drawn zones. No-fly zones are already
  removed from the neighbor set.

- Return `path` as a list of **cell ids** (ints) from start→goal, inclusive.
- If there is no path, return `path=[]` and `cost=inf`.
- If you want the UI to show explored nodes, put cell ids in `visited`.
  BUT: only do this if `options.return_visited` is True, and cap the size using
  `options.max_visited` to avoid huge responses.

See also
--------
Read `backend/algorithms/types.py` and `backend/algorithms/ALGORITHM_API.md` for
the full interface.
"""

from __future__ import annotations

from math import inf

from ..types import AlgorithmResult, AlgorithmSpec, GridProblem, RunOptions

ALGORITHM = AlgorithmSpec(
    id="template",
    name="Template (does nothing)",
    description="Example plugin structure.",
)


def run(problem: GridProblem, options: RunOptions) -> AlgorithmResult:
    # Example: do nothing.
    #
    # NOTE: Your algorithm should usually start by checking if start==goal.
    # If so, return [start] with cost 0.
    return AlgorithmResult(path=[], visited=[], expanded=0, cost=inf)
