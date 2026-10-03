// Orchestrator Context Builder — post-chat 副作用（记忆写入 + Reflection）
import { memoryScheduler } from "../memory/memory-scheduler";
import { isMemoryEnabled } from "../memory/memory-mode";

export function scheduleMemoryWrite(userInput: string, assistantReply: string, conversationId?: string): void {
  if (!isMemoryEnabled()) return;
  memoryScheduler.scheduleMemoryWrite(userInput, assistantReply, conversationId);
}
