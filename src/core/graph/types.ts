/**
 * Module Graph Types
 *
 * Type definitions for import/export dependency graph.
 * Extracted from module-graph.ts for reusability.
 */

export interface ImportEdge {
  target: string;
  specifiers: string[];
  isTypeOnly: boolean;
  isDynamic: boolean;
}

export interface ModuleGraph {
  forward: Map<string, ImportEdge[]>;
  reverse: Map<string, ImportEdge[]>;
  files: Set<string>;
}

export interface BuildGraphResult {
  graph: ModuleGraph;
  resolver: ResolverFactory;
}

export interface RawImport {
  specifier: string;
  names: string[];
  isTypeOnly: boolean;
  isDynamic: boolean;
}

export interface DepTreeOpts {
  depth?: number;
  includeTypeOnly?: boolean;
}

export interface DepTreeResult {
  root: string;
  nodes: number;
  files: string[];
}

export interface DependentsOpts {
  depth?: number;
  includeTypeOnly?: boolean;
}

export interface DependentsResult {
  root: string;
  nodes: number;
  directCount: number;
  files: string[];
  byPackage: Record<string, string[]>;
}

export interface CycleOpts {
  file?: string;
  package?: string;
}

export interface CycleResult {
  count: number;
  cycles: string[][];
}

export interface PathOpts {
  includeTypeOnly?: boolean;
}

export interface PathResult {
  path: string[] | null;
  hops: number;
  chain: Array<{ file: string; imports: string[] }>;
}

export interface SubgraphOpts {
  depth?: number;
  direction?: "imports" | "dependents" | "both";
}

export interface SubgraphResult {
  nodes: string[];
  edges: Array<{
    from: string;
    to: string;
    specifiers: string[];
    isTypeOnly: boolean;
  }>;
  stats: { nodeCount: number; edgeCount: number };
}

export interface BoundaryResult {
  internalEdges: number;
  incomingEdges: Array<{ from: string; to: string; specifiers: string[] }>;
  outgoingEdges: Array<{ from: string; to: string; specifiers: string[] }>;
  sharedDependencies: string[];
  isolationScore: number;
}

type ResolverFactory = unknown;
