from __future__ import annotations

from dataclasses import dataclass
from math import hypot, isfinite
from typing import Iterable, List, Optional, Tuple


@dataclass(frozen=True)
class AlgorithmSpec:
    """Metadata for an algorithm plugin."""

    id: str
    name: str
    description: str = ""


@dataclass(frozen=True)
class GridBoundsMeters:
    """Bounds of the planning area in Web Mercator meters (EPSG:3857)."""

    min_x: float
    min_y: float
    max_x: float
    max_y: float


@dataclass
class RunOptions:
    return_visited: bool = False
    max_visited: int = 50000


@dataclass
class GridProblem:
    """A single-source single-target grid routing problem.

    Notes
    -----
    - Cell ids are row-major: id = row * width + col
    - The grid is 8-connected: N,S,E,W and diagonals.
    - Stepping cost is: step_distance_m * cost_multiplier[to_cell]

    This class provides helper utilities so algorithm authors can focus on
    graph search logic, not bookkeeping.
    """

    width: int
    height: int
    cell_size_m: float
    bounds: GridBoundsMeters
    start: int
    goal: int
    blocked: List[bool]
    cost_multiplier: List[float]

    def size(self) -> int:
        return self.width * self.height

    def in_bounds(self, col: int, row: int) -> bool:
        return 0 <= col < self.width and 0 <= row < self.height

    def to_id(self, col: int, row: int) -> int:
        return row * self.width + col

    def to_row_col(self, cell_id: int) -> Tuple[int, int]:
        row = cell_id // self.width
        col = cell_id - row * self.width
        return col, row

    def cell_center_m(self, cell_id: int) -> Tuple[float, float]:
        """Return (x_m, y_m) for the center of a cell in Web Mercator meters.

        Most algorithms don't need world coordinates (they operate on ids),
        but this becomes useful for extensions like wind fields, battery models,
        charging station proximity, etc.
        """

        col, row = self.to_row_col(cell_id)
        x = self.bounds.min_x + (col + 0.5) * self.cell_size_m
        y = self.bounds.min_y + (row + 0.5) * self.cell_size_m
        return x, y

    def is_blocked(self, cell_id: int) -> bool:
        return bool(self.blocked[cell_id])

    def get_multiplier(self, cell_id: int) -> float:
        m = self.cost_multiplier[cell_id]
        if not isfinite(m) or m <= 0:
            return 1.0
        return float(m)

    def step_cost(self, to_id: int, step_distance_m: float) -> float:
        return float(step_distance_m) * self.get_multiplier(to_id)

    def neighbors8(self, cell_id: int) -> Iterable[Tuple[int, float]]:
        """Yield (neighbor_id, step_distance_m) for free (non-blocked) neighbors."""
        col, row = self.to_row_col(cell_id)
        cs = self.cell_size_m
        # (dc, dr, distance_multiplier)
        dirs = (
            (1, 0, 1.0),
            (-1, 0, 1.0),
            (0, 1, 1.0),
            (0, -1, 1.0),
            (1, 1, 2**0.5),
            (1, -1, 2**0.5),
            (-1, 1, 2**0.5),
            (-1, -1, 2**0.5),
        )
        for dc, dr, mult in dirs:
            c = col + dc
            r = row + dr
            if not self.in_bounds(c, r):
                continue
            nid = self.to_id(c, r)
            if self.is_blocked(nid):
                continue
            yield nid, cs * mult

    def heuristic_euclidean_m(self, cell_id: int, min_multiplier: Optional[float] = None) -> float:
        """Admissible Euclidean heuristic in meters.

        If you use cost multipliers that can be < 1 (encouraged zones), the
        heuristic must be scaled by the minimum possible multiplier to stay
        admissible.
        """
        col_a, row_a = self.to_row_col(cell_id)
        col_b, row_b = self.to_row_col(self.goal)
        dx = col_b - col_a
        dy = row_b - row_a
        base = self.cell_size_m * hypot(dx, dy)
        if min_multiplier is None:
            return base
        if not isfinite(min_multiplier) or min_multiplier <= 0:
            return base
        return base * float(min_multiplier)


@dataclass
class AlgorithmResult:
    path: List[int]
    visited: List[int]
    expanded: int
    cost: float


def reconstruct_path(came_from: List[int], start: int, goal: int) -> List[int]:
    if goal < 0 or goal >= len(came_from):
        return []
    if came_from[goal] == -1 and goal != start:
        return []
    out: List[int] = []
    cur = goal
    while True:
        out.append(cur)
        if cur == start:
            break
        cur = came_from[cur]
        if cur == -1:
            return []
    out.reverse()
    return out


def path_cost(problem: GridProblem, path: List[int]) -> float:
    if len(path) < 2:
        return 0.0 if len(path) == 1 else float('inf')
    total = 0.0
    for a, b in zip(path, path[1:]):
        ac, ar = problem.to_row_col(a)
        bc, br = problem.to_row_col(b)
        step_dist = problem.cell_size_m * hypot(bc - ac, br - ar)
        total += problem.step_cost(b, step_dist)
    return total
