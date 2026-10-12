import { useId } from "react";
import type { Cycle, EdgeRow, Finding } from "./types";

/**
 * Dependency graph drawing, written here (no graph library). Layered left to right, drawn as accessible SVG: the
 * picture has a title and description and every fact in it is also in the adjacent HTML lists and tables, which
 * are the primary accessible form. A drawing is capped at MAX_GRAPH_NODES nodes: bigger inputs draw the first
 * part and say so, and the list views page through the rest, so a graph of thousands of nodes never freezes the page.
 */

export const MAX_GRAPH_NODES = 60;
const NODE_W = 184;
const NODE_H = 44;
const COL_GAP = 72;
const ROW_GAP = 14;
const PAD = 10;

export interface DrawnNode {
  id: string;
  col: number;
  row: number;
  x: number;
  y: number;
  origin: boolean;
  consumer: boolean;
  inCycle: boolean;
  /** Undefined when the source does not say (intermediate nodes); null means "no owner declared". */
  owner: string | null | undefined;
  direct: boolean;
}

export interface DrawnEdge {
  from: string;
  to: string;
  label: string;
}

export interface GraphModel {
  nodes: DrawnNode[];
  edges: DrawnEdge[];
  width: number;
  height: number;
  /** How many of the offered items (findings or edges) fit in the drawing, and how many were offered. */
  drawn: number;
  offered: number;
}

interface Draft {
  id: string;
  col: number;
  origin: boolean;
  consumer: boolean;
  owner: string | null | undefined;
  direct: boolean;
}

function place(drafts: Map<string, Draft>, edges: DrawnEdge[], cycleNodes: Set<string>, drawn: number, offered: number): GraphModel {
  const byCol = new Map<number, Draft[]>();
  for (const d of drafts.values()) byCol.set(d.col, [...(byCol.get(d.col) ?? []), d]);
  const nodes: DrawnNode[] = [];
  let maxRows = 0;
  let maxCol = 0;
  for (const [col, list] of [...byCol.entries()].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    maxRows = Math.max(maxRows, list.length);
    maxCol = Math.max(maxCol, col);
    list.forEach((d, row) =>
      nodes.push({ ...d, row, x: PAD + col * (NODE_W + COL_GAP), y: PAD + row * (NODE_H + ROW_GAP), inCycle: cycleNodes.has(d.id) }),
    );
  }
  return {
    nodes,
    edges,
    width: PAD * 2 + (maxCol + 1) * NODE_W + maxCol * COL_GAP,
    height: PAD * 2 + Math.max(1, maxRows) * NODE_H + Math.max(0, maxRows - 1) * ROW_GAP,
    drawn,
    offered,
  };
}

/**
 * Impact graph: the ordered source-to-consumer paths of the offered findings, one column per hop. Findings are
 * taken in order until the drawing would exceed `maxNodes` (the first finding is always drawn).
 */
export function impactGraphModel(findings: Finding[], cycles: Cycle[] = [], maxNodes = MAX_GRAPH_NODES): GraphModel {
  const drafts = new Map<string, Draft>();
  const edgeKeys = new Set<string>();
  const edges: DrawnEdge[] = [];
  let drawn = 0;
  for (const f of findings) {
    if (drawn > 0 && drafts.size + new Set(f.path.filter((id) => !drafts.has(id))).size > maxNodes) break;
    f.path.forEach((id, index) => {
      const existing = drafts.get(id);
      const isConsumer = index === f.path.length - 1;
      const isOrigin = index === 0;
      if (existing) {
        existing.col = Math.min(existing.col, index);
        existing.origin ||= isOrigin;
        if (isConsumer && index > 0) {
          existing.consumer = true;
          existing.owner = f.consumer_owner;
          existing.direct = existing.direct || f.direct;
        }
      } else {
        drafts.set(id, {
          id,
          col: index,
          origin: isOrigin,
          consumer: isConsumer && index > 0,
          owner: isConsumer && index > 0 ? f.consumer_owner : undefined,
          direct: isConsumer && f.direct,
        });
      }
      const next = f.path[index + 1];
      if (next !== undefined) {
        const key = `${id}\u0000${next}`;
        if (!edgeKeys.has(key)) {
          edgeKeys.add(key);
          const hop = f.hops[index];
          // A very long path keeps only its first and last hops: the join between them is not one hop.
          const elided = hop !== undefined && hop.from !== id;
          edges.push({ from: id, to: next, label: elided ? `… ${f.path_omitted_hops ?? "more"} hops omitted` : (hop?.relation ?? "") });
        }
      }
    });
    drawn += 1;
  }
  const cycleNodes = new Set(cycles.flatMap((c) => c.members));
  return place(drafts, edges, cycleNodes, drawn, findings.length);
}

/** Preview of a snapshot's edges: consumer on the left, what it depends on to the right (longest path layering, bounded). */
export function edgesGraphModel(rows: EdgeRow[], cycles: Cycle[] = [], maxNodes = MAX_GRAPH_NODES): GraphModel {
  const ids = new Set<string>();
  const taken: EdgeRow[] = [];
  for (const edge of rows) {
    const add = [edge.source_id, edge.target_id].filter((id) => !ids.has(id));
    if (taken.length > 0 && ids.size + new Set(add).size > maxNodes) break;
    add.forEach((id) => ids.add(id));
    taken.push(edge);
  }
  const col = new Map<string, number>([...ids].map((id) => [id, 0]));
  // Relax edges a bounded number of times; a cycle simply stops growing at the bound instead of looping.
  for (let round = 0; round < ids.size; round += 1) {
    let changed = false;
    for (const e of taken) {
      if (e.source_id === e.target_id) continue;
      const wanted = (col.get(e.source_id) ?? 0) + 1;
      if (wanted > (col.get(e.target_id) ?? 0) && wanted <= ids.size) {
        col.set(e.target_id, wanted);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const targets = new Set(taken.map((e) => e.target_id));
  const sources = new Set(taken.map((e) => e.source_id));
  const drafts = new Map<string, Draft>();
  for (const id of ids) {
    drafts.set(id, { id, col: Math.min(col.get(id) ?? 0, 6), origin: sources.has(id) && !targets.has(id), consumer: false, owner: undefined, direct: false });
  }
  const edges = taken.map((e) => ({ from: e.source_id, to: e.target_id, label: e.relation }));
  return place(drafts, edges, new Set(cycles.flatMap((c) => c.members)), taken.length, rows.length);
}

const truncate = (id: string, max = 26): string => (id.length <= max ? id : `${id.slice(0, Math.ceil((max - 1) / 2))}…${id.slice(id.length - Math.floor((max - 1) / 2))}`);

export interface GraphViewProps {
  model: GraphModel;
  title: string;
  /** What `drawn` and `offered` count, for the truncation note ("findings" or "edges"). */
  noun: string;
}

/** The SVG drawing, or a plain statement that there is nothing to draw. */
export function GraphView({ model, title, noun }: GraphViewProps) {
  const uid = useId();
  if (model.nodes.length === 0) {
    return (
      <p className="empty-inline" data-state="graph-empty">
        Nothing to draw yet.
      </p>
    );
  }
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const desc = `${model.nodes.length} nodes and ${model.edges.length} links, drawn left to right. The lists next to this drawing contain the same information as text.`;
  return (
    <figure className="graph" data-testid="graph">
      <div className="graph-scroll" role="region" aria-label={`${title} (scrollable)`} tabIndex={0}>
        <svg role="img" aria-labelledby={`${uid}-t ${uid}-d`} viewBox={`0 0 ${model.width} ${model.height}`} width={model.width} height={model.height}>
          <title id={`${uid}-t`}>{title}</title>
          <desc id={`${uid}-d`}>{desc}</desc>
          <defs>
            <marker id={`${uid}-arrow`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className="g-arrow" />
            </marker>
          </defs>
          {model.edges.map((e) => {
            const a = byId.get(e.from);
            const b = byId.get(e.to);
            if (!a || !b) return null;
            const x1 = a.x + NODE_W;
            const y1 = a.y + NODE_H / 2;
            const x2 = b.x;
            const y2 = b.y + NODE_H / 2;
            const mid = Math.max(24, Math.abs(x2 - x1) / 2);
            return <path key={`${e.from}>${e.to}`} className="g-edge" d={`M ${x1} ${y1} C ${x1 + mid} ${y1}, ${x2 - mid} ${y2}, ${x2} ${y2}`} markerEnd={`url(#${uid}-arrow)`} fill="none" />;
          })}
          {model.nodes.map((n) => (
            <g key={n.id} data-node-id={n.id}>
              <title>
                {n.id}
                {n.consumer ? ` (consumer, owner ${n.owner ?? "unknown"})` : ""}
                {n.origin ? " (changed item)" : ""}
                {n.inCycle ? " (in a dependency cycle)" : ""}
              </title>
              <rect
                x={n.x}
                y={n.y}
                width={NODE_W}
                height={NODE_H}
                rx={6}
                className={`g-node${n.origin ? " g-origin" : ""}${n.consumer ? (n.direct ? " g-direct" : " g-transitive") : ""}${n.consumer && !n.owner ? " g-noowner" : ""}`}
              />
              <text x={n.x + 8} y={n.y + 18} className="g-label">
                {n.inCycle ? "↻ " : ""}
                {truncate(n.id)}
              </text>
              <text x={n.x + 8} y={n.y + 35} className="g-sub">
                {n.origin ? "changed item" : n.consumer ? (n.owner ? `owner ${truncate(n.owner, 18)}` : "owner unknown") : "on the path"}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <figcaption className="muted">
        {model.drawn < model.offered ? `Drawing the first ${model.drawn} of ${model.offered} ${noun}; use the list for the rest. ` : ""}
        Thick outline: changed item. Solid outline: direct consumer. Dashed outline: transitive consumer. Dotted outline with “owner unknown”: no owner declared. ↻ marks a dependency cycle.
      </figcaption>
    </figure>
  );
}
