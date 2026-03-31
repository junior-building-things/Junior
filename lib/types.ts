export type Priority = 'P0' | 'P1' | 'P2' | 'P3';

export interface ChatMessage {
  role: 'user' | 'model';
  content: string;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  name: string;
  result: string;
}
