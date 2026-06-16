/**
 * TypeScript Server Protocol Types
 *
 * Type definitions for tsserver communication.
 * Extracted from tsserver-client.ts for reusability.
 */

export interface Location {
  line: number;
  offset: number;
}

export interface DefinitionResult {
  file: string;
  start: Location;
  end: Location;
  contextStart?: Location;
  contextEnd?: Location;
}

export interface ReferenceEntry {
  file: string;
  start: Location;
  end: Location;
  isDefinition: boolean;
  isWriteAccess: boolean;
  lineText: string;
}

export interface QuickInfoResult {
  displayString: string;
  documentation: string;
  kind: string;
  kindModifiers: string;
  start: Location;
  end: Location;
}

export interface NavToItem {
  name: string;
  kind: string;
  file: string;
  start: Location;
  end: Location;
  containerName: string;
  containerKind: string;
  matchKind: string;
}

export interface NavBarItem {
  text: string;
  kind: string;
  kindModifiers: string;
  spans: Array<{ start: Location; end: Location }>;
  childItems: NavBarItem[];
}

export interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  command: string;
}

export interface TsServerMessage {
  type: string;
  request_seq?: number;
  success?: boolean;
  body?: unknown;
  message?: string;
  command?: string;
}
