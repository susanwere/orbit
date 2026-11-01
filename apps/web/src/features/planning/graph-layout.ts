export interface NodeSize {
  readonly width: number;
  readonly height: number;
}
export interface LayoutNode extends NodeSize {
  readonly id: string;
}
export interface LayoutEdge {
  readonly from: string;
  readonly to: string;
}
export interface NodeBounds extends LayoutNode {
  readonly x: number;
  readonly y: number;
}
export interface GraphBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}
export interface GraphLayout {
  readonly nodes: ReadonlyMap<string, NodeBounds>;
  readonly bounds: GraphBounds;
}

const COLUMN_GAP = 100;
const ROW_GAP = 48;

/** Pixel-space geometry at 100% zoom. Layout never depends on execution status or viewport size. */
export function layoutGraph(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
): GraphLayout {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parents = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) {
    if (byId.has(edge.from) && byId.has(edge.to)) parents.get(edge.to)!.push(edge.from);
  }
  const ranks = new Map<string, number>();
  const visiting = new Set<string>();
  function rank(id: string): number {
    const cachedRank = ranks.get(id);
    if (cachedRank !== undefined) return cachedRank;
    // Invalid cycles remain visible as backward edges; this does not alter backend dependencies.
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const parentRanks = parents.get(id)!.map(rank);
    const nodeRank = parentRanks.length ? Math.max(...parentRanks) + 1 : 0;
    visiting.delete(id);
    ranks.set(id, nodeRank);
    return nodeRank;
  }
  [...byId.keys()].sort().forEach(rank);
  const columns = new Map<number, LayoutNode[]>();
  for (const node of nodes) {
    const column = rank(node.id);
    columns.set(column, [...(columns.get(column) ?? []), node]);
  }
  const positionedNodes = new Map<string, NodeBounds>();
  let columnLeft = 0;
  for (const [, columnNodes] of [...columns.entries()].sort(([left], [right]) => left - right)) {
    const desiredY = (node: LayoutNode) => {
      const parentPositions = parents.get(node.id)!.flatMap((id) => {
        const parent = positionedNodes.get(id);
        return parent ? [parent.y] : [];
      });
      return parentPositions.length
        ? parentPositions.reduce((sum, y) => sum + y, 0) / parentPositions.length
        : 0;
    };
    const orderedNodes = [...columnNodes].sort(
      (left, right) => desiredY(left) - desiredY(right) || left.id.localeCompare(right.id),
    );
    const columnWidth = Math.max(...orderedNodes.map((node) => node.width));
    let previousBottom = -Infinity;
    const columnPositions = orderedNodes.map((node) => {
      const y = Math.max(desiredY(node), previousBottom + ROW_GAP + node.height / 2);
      previousBottom = y + node.height / 2;
      return { ...node, x: columnLeft + columnWidth / 2, y };
    });
    const offset =
      columnPositions.reduce((sum, node) => sum + node.y - desiredY(node), 0) /
      columnPositions.length;
    for (const node of columnPositions)
      positionedNodes.set(node.id, { ...node, y: node.y - offset });
    columnLeft += columnWidth + COLUMN_GAP;
  }
  const rectangles = [...positionedNodes.values()];
  return {
    nodes: positionedNodes,
    bounds: rectangles.length
      ? {
          left: Math.min(...rectangles.map((node) => node.x - node.width / 2)),
          right: Math.max(...rectangles.map((node) => node.x + node.width / 2)),
          top: Math.min(...rectangles.map((node) => node.y - node.height / 2)),
          bottom: Math.max(...rectangles.map((node) => node.y + node.height / 2)),
        }
      : { left: 0, right: 0, top: 0, bottom: 0 },
  };
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Prefer direct curves. Only bypass cards that actually obstruct a connection, using a local corridor. */
export function routeEdge(layout: GraphLayout, edge: LayoutEdge): Point[] {
  const source = layout.nodes.get(edge.from);
  const target = layout.nodes.get(edge.to);
  if (!source || !target) return [];
  const start = { x: source.x + source.width / 2, y: source.y };
  const end = { x: target.x - target.width / 2, y: target.y };
  const bendX = (start.x + end.x) / 2;
  let route = cubicCurve(start, { x: bendX, y: start.y }, { x: bendX, y: end.y }, end);
  const obstacles = [...layout.nodes.values()].filter(
    (node) => node.id !== source.id && node.id !== target.id,
  );
  const intersects = (points: Point[], node: NodeBounds) =>
    points.some(
      (point) =>
        point.x > node.x - node.width / 2 - 12 &&
        point.x < node.x + node.width / 2 + 12 &&
        point.y > node.y - node.height / 2 - 12 &&
        point.y < node.y + node.height / 2 + 12,
    );
  const blocked = new Map<string, NodeBounds>();
  for (let attempt = 0; attempt <= obstacles.length; attempt++) {
    const collisions = obstacles.filter((node) => intersects(route, node));
    if (!collisions.length) return route;
    collisions.forEach((node) => blocked.set(node.id, node));
    const blockers = [...blocked.values()];
    const above = Math.min(...blockers.map((node) => node.y - node.height / 2)) - 80;
    const below = Math.max(...blockers.map((node) => node.y + node.height / 2)) + 80;
    const corridorY =
      Math.abs(start.y - above) + Math.abs(end.y - above) <=
      Math.abs(start.y - below) + Math.abs(end.y - below)
        ? above
        : below;
    const middle = { x: bendX, y: corridorY };
    const handleOffset = (end.x - start.x) / 4;
    route = [
      ...cubicCurve(
        start,
        { x: start.x + handleOffset, y: start.y },
        { x: start.x + handleOffset, y: corridorY },
        middle,
      ),
      ...cubicCurve(
        middle,
        { x: end.x - handleOffset, y: corridorY },
        { x: end.x - handleOffset, y: end.y },
        end,
      ).slice(1),
    ];
  }
  return route;
}

function cubicCurve(start: Point, firstControl: Point, secondControl: Point, end: Point): Point[] {
  return Array.from({ length: 25 }, (_, index) => {
    const t = index / 24;
    const inverse = 1 - t;
    return {
      x:
        inverse ** 3 * start.x +
        3 * inverse ** 2 * t * firstControl.x +
        3 * inverse * t ** 2 * secondControl.x +
        t ** 3 * end.x,
      y:
        inverse ** 3 * start.y +
        3 * inverse ** 2 * t * firstControl.y +
        3 * inverse * t ** 2 * secondControl.y +
        t ** 3 * end.y,
    };
  });
}
