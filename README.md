# Stanford UAV Nav Suite (Navigation Team Tooling)

A self-hosted **webapp + Python backend** for drawing constraints on a Stanford campus map and quickly testing navigation/pathfinding algorithms on a uniform square grid.

The design goal is **plug-and-play algorithms**: nav team members only touch Python files in `backend/algorithms/plugins/`.

---

## What you get

- Stanford-area basemap (Leaflet) with quick switching:
  - OSM road map
  - OpenTopoMap (terrain)
  - Esri World Imagery (satellite)
  - OSM HOT (alternative road style)
- Draw zones:
  - **No-fly zones**: blocked + automatic **10m buffer**
  - **Cost zones**: multiplicative weights (>1 discouraged, <1 encouraged)
- Select a planning area rectangle ("Set planning area to current view")
- Set start + goal markers
- Run a Python algorithm and visualize:
  - path polyline
  - explored nodes (optional)
- Grid is **8-connected** (diagonals allowed) with correct diagonal distance `cell_size * sqrt(2)`.

---

## Quick start (Mac/Linux)

Fastest: one command:

```bash
./run.sh
```

Or do it manually:

### 1) Install prerequisites
- Node.js 18+ (you already have this)
- Python 3.10+ recommended

### 2) Install frontend deps
From the repo root:

```bash
npm install
```

### 3) Install backend deps

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
```

### 4) Run (frontend + backend)

```bash
npm run dev:full
```

Then open the URL Vite prints (usually `http://localhost:5173`).

> If you prefer two terminals:
>
> Terminal A:
> ```bash
> npm run dev
> ```
>
> Terminal B (with venv activated):
> ```bash
> npm run backend
> ```

---

## Core workflow

1. **Zoom** to the part of campus you care about.
2. Click **Set planning area to current view**.
3. Draw zones using the tools on the map (top-left):
   - No-fly (blocked, +10m buffer)
   - Cost (multiplier)
4. Click **Click map to set START**, then click on map.
5. Click **Click map to set GOAL**, then click on map.
6. Choose an algorithm and hit **Run**.

Notes:
- For polygons: **single-click** to add vertices; to finish, **click the first vertex**. (Double-click is intentionally disabled while drawing to avoid accidental triangles on trackpads.)
- If you go down to 1–5m resolution, **zoom in** first.

---

## Adding algorithms (Python, plug-and-play)

Drop a new file into:

```
backend/algorithms/plugins/
```

Each plugin must define:
- `ALGORITHM`: an `AlgorithmSpec(id, name, description)`
- `run(problem: GridProblem, options: RunOptions) -> AlgorithmResult`

Look at `backend/algorithms/plugins/_template.py` for the copy/paste template.

**Authoritative reference:** `backend/algorithms/ALGORITHM_API.md`
This is the full input/output contract and includes a minimal Dijkstra example.

### What your algorithm receives
Your `run()` gets a `GridProblem`:

- `problem.width`, `problem.height`
- `problem.cell_size_m`
- `problem.start`, `problem.goal` (cell ids: `0..(width*height-1)`)
- `problem.blocked[id]` (True/False)
- `problem.cost_multiplier[id]` (float)

Helpers:
- `problem.to_row_col(cell_id)`
- `problem.to_id(col, row)`
- `problem.neighbors8(cell_id)` returns list of `(neighbor_id, step_distance_m)`
- `problem.step_cost(to_id, step_distance_m)` applies the cost multiplier

### What your algorithm must return
An `AlgorithmResult`:

- `path: list[int]` (cell ids from start → goal, inclusive)
- `visited: list[int]` (optional; returned only if requested)
- `expanded: int` (how many nodes you expanded/popped)
- `cost: float` (total cost of the path; `inf` if no path)

---

## Implementation notes

- Map uses Leaflet + Web Mercator internally. Distances are treated as meters (good at Stanford scale).
- Grid is generated from the planning rectangle bounds and the chosen resolution.
- No-fly buffer is applied using turf.js on the frontend.
- Performance guardrail: the UI refuses to build grids > **250k** cells.

---

## Troubleshooting

### "Backend not running" message in the UI
Make sure the Python backend is up:

```bash
source .venv/bin/activate
npm run backend
```

### Satellite/terrain tiles not loading
Some networks block tile servers. Try another network (hotspot), or stick to OSM.

---

## Roadmap ideas (optional)

- Scenario save/load (JSON)
- Battery and charging station routing
- Weather layers and wind-aware cost
- Multi-drone scheduling and task assignment
