export interface AlgorithmInfo {
  id: string;
  name: string;
  description?: string;
}

export interface GridBoundsMeters {
  min_x: number;
  min_y: number;
  max_x: number;
  max_y: number;
}

export interface GridProblemPayload {
  width: number;
  height: number;
  cell_size_m: number;
  bounds: GridBoundsMeters;
  start: number;
  goal: number;
  // Flattened row-major arrays of length width*height.
  blocked: number[]; // 0/1
  cost_multiplier: number[]; // float multipliers (>=0)
}

export interface RunOptions {
  return_visited?: boolean;
  max_visited?: number;
}

export interface RunRequest {
  algorithm_id: string;
  problem: GridProblemPayload;
  options?: RunOptions;
}

export interface RunResponse {
  path: number[];
  visited: number[];
  expanded: number;
  cost: number;
  runtime_ms: number;
}
