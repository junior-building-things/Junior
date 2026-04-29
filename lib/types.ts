export type Priority = 'P0' | 'P1' | 'P2' | 'P3';

export interface ChatMessage {
  role: 'user' | 'model';
  content: string;
  // Optional metadata used for storage / merge across the chat-level
  // and user-level history files. Not sent to Gemini — the chat()
  // helper strips them down to {role, parts} before the model call.
  ts?: number;             // unix ms — sort + dedup key
  chatId?: string;         // origin chat id
  senderOpenId?: string;   // user-role messages only
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  name: string;
  result: string;
}
