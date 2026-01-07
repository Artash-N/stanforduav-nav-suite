from __future__ import annotations

import time
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .algorithms.loader import load_plugins, list_algorithms
from .algorithms.types import AlgorithmResult, GridBoundsMeters, GridProblem, RunOptions


app = FastAPI(title="Stanford UAV Nav Suite Backend", version="0.2.0")

# In dev, the frontend uses a Vite proxy. This CORS config is just extra safety.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

REGISTRY = load_plugins()


class AlgorithmInfo(BaseModel):
    id: str
    name: str
    description: str = ""


class GridBoundsMetersModel(BaseModel):
    min_x: float
    min_y: float
    max_x: float
    max_y: float


class GridProblemModel(BaseModel):
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    cell_size_m: float = Field(gt=0)
    bounds: GridBoundsMetersModel
    start: int = Field(ge=0)
    goal: int = Field(ge=0)
    blocked: List[int]
    cost_multiplier: List[float]


class RunOptionsModel(BaseModel):
    return_visited: bool = False
    max_visited: int = Field(default=50000, ge=0)
    wind_enabled: bool = False
    wind_direction_deg: float = 0.0
    wind_speed_ms: float = 0.0
    drone_airspeed_ms: float = 10.0


class RunRequestModel(BaseModel):
    algorithm_id: str
    problem: GridProblemModel
    options: Optional[RunOptionsModel] = None


class RunResponseModel(BaseModel):
    path: List[int]
    visited: List[int]
    expanded: int
    cost: float
    runtime_ms: float


@app.get("/api/health")
def health():
    return {"ok": True, "algorithms": len(REGISTRY)}


@app.get("/api/algorithms", response_model=list[AlgorithmInfo])
def algorithms() -> list[AlgorithmInfo]:
    out: list[AlgorithmInfo] = []
    for spec in list_algorithms(REGISTRY):
        out.append(AlgorithmInfo(id=spec.id, name=spec.name, description=spec.description))
    return out


@app.post("/api/run", response_model=RunResponseModel)
def run(req: RunRequestModel) -> RunResponseModel:
    algo = REGISTRY.get(req.algorithm_id)
    if algo is None:
        raise HTTPException(status_code=404, detail=f"Unknown algorithm_id: {req.algorithm_id}")

    p = req.problem
    n = p.width * p.height
    if len(p.blocked) != n:
        raise HTTPException(status_code=400, detail=f"blocked length {len(p.blocked)} != width*height {n}")
    if len(p.cost_multiplier) != n:
        raise HTTPException(
            status_code=400,
            detail=f"cost_multiplier length {len(p.cost_multiplier)} != width*height {n}",
        )
    if p.start >= n or p.goal >= n:
        raise HTTPException(status_code=400, detail="start/goal out of bounds")

    bounds = GridBoundsMeters(
        min_x=p.bounds.min_x,
        min_y=p.bounds.min_y,
        max_x=p.bounds.max_x,
        max_y=p.bounds.max_y,
    )

    blocked_bool = [bool(x) for x in p.blocked]

    problem = GridProblem(
        width=p.width,
        height=p.height,
        cell_size_m=p.cell_size_m,
        bounds=bounds,
        start=p.start,
        goal=p.goal,
        blocked=blocked_bool,
        cost_multiplier=list(map(float, p.cost_multiplier)),
    )

    opts = req.options or RunOptionsModel()
    run_opts = RunOptions(
        return_visited=opts.return_visited,
        max_visited=opts.max_visited,
        wind_enabled=opts.wind_enabled,
        wind_direction_deg=opts.wind_direction_deg,
        wind_speed_ms=opts.wind_speed_ms,
        drone_airspeed_ms=opts.drone_airspeed_ms
    )

    t0 = time.perf_counter()
    try:
        result: AlgorithmResult = algo.run(problem, run_opts)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Algorithm crashed: {type(e).__name__}: {e}")
    t1 = time.perf_counter()

    runtime_ms = (t1 - t0) * 1000.0

    # Ensure visited is empty if not requested (some algos might still populate it).
    visited = result.visited if run_opts.return_visited else []

    return RunResponseModel(
        path=result.path,
        visited=visited,
        expanded=int(result.expanded),
        cost=float(result.cost),
        runtime_ms=runtime_ms,
    )
