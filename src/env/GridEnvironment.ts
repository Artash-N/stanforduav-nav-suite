export type CellId = number;

export interface GridBoundsMeters {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Neighbor {
  id: CellId;
  stepDistanceM: number;
}

export class GridEnvironment {
  readonly cellSizeM: number;
  readonly bounds: GridBoundsMeters;
  readonly width: number;
  readonly height: number;
  readonly blocked: Uint8Array;
  readonly costMultiplier: Float32Array;

  constructor(params: {
    cellSizeM: number;
    bounds: GridBoundsMeters;
    width: number;
    height: number;
    blocked: Uint8Array;
    costMultiplier: Float32Array;
  }) {
    this.cellSizeM = params.cellSizeM;
    this.bounds = params.bounds;
    this.width = params.width;
    this.height = params.height;
    this.blocked = params.blocked;
    this.costMultiplier = params.costMultiplier;
  }

  size(): number {
    return this.width * this.height;
  }

  cellId(col: number, row: number): CellId {
    return row * this.width + col;
  }

  colRow(id: CellId): { col: number; row: number } {
    const row = Math.floor(id / this.width);
    const col = id - row * this.width;
    return { col, row };
  }

  inBounds(col: number, row: number): boolean {
    return col >= 0 && row >= 0 && col < this.width && row < this.height;
  }

  worldToCell(xM: number, yM: number): CellId | null {
    const { minX, minY } = this.bounds;
    const col = Math.floor((xM - minX) / this.cellSizeM);
    const row = Math.floor((yM - minY) / this.cellSizeM);
    if (!this.inBounds(col, row)) return null;
    return this.cellId(col, row);
  }

  cellCenter(id: CellId): { xM: number; yM: number } {
    const { col, row } = this.colRow(id);
    const xM = this.bounds.minX + (col + 0.5) * this.cellSizeM;
    const yM = this.bounds.minY + (row + 0.5) * this.cellSizeM;
    return { xM, yM };
  }

  isBlocked(id: CellId): boolean {
    return this.blocked[id] === 1;
  }

  getCostMultiplier(id: CellId): number {
    return this.costMultiplier[id] || 1;
  }

  // Cost of stepping into neighbor cell. Algorithms can define their own edge costs too.
  stepCost(toId: CellId, stepDistanceM: number): number {
    return stepDistanceM * this.getCostMultiplier(toId);
  }

  neighbors8(id: CellId): Neighbor[] {
    const { col, row } = this.colRow(id);
    const n: Neighbor[] = [];

    const dirs: Array<[number, number, number]> = [
      [1, 0, 1],
      [-1, 0, 1],
      [0, 1, 1],
      [0, -1, 1],
      [1, 1, Math.SQRT2],
      [1, -1, Math.SQRT2],
      [-1, 1, Math.SQRT2],
      [-1, -1, Math.SQRT2]
    ];

    for (const [dc, dr, mult] of dirs) {
      const c = col + dc;
      const r = row + dr;
      if (!this.inBounds(c, r)) continue;
      const nid = this.cellId(c, r);
      if (this.isBlocked(nid)) continue;
      n.push({ id: nid, stepDistanceM: this.cellSizeM * mult });
    }
    return n;
  }
}
