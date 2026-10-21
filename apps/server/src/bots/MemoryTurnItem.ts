import type { MemoryMessage, OrchestrationV2TurnItem } from "@satslab/contracts";
import * as DateTime from "effect/DateTime";

const toolContent = (item: OrchestrationV2TurnItem) => {
  switch (item.type) {
    case "dynamic_tool":
      return {
        name: item.toolName ?? item.title ?? "tool",
        input: item.input,
        output: item.output,
      };
    case "command_execution":
      return {
        name: "command_execution",
        input: item.input,
        output: { output: item.output, exitCode: item.exitCode, status: item.status },
      };
    case "file_search":
      return { name: "file_search", input: item.pattern, output: item.results };
    case "web_search":
      return { name: "web_search", input: item.patterns, output: item.results };
    case "file_change":
      return {
        name: "file_change",
        input: item.fileName,
        output: {
          status: item.status,
          additions: item.additions,
          deletions: item.deletions,
          diff: item.diffStr,
          old: item.oldStr,
          new: item.newStr,
          changes: item.changes,
        },
      };
    case "subagent":
      return {
        name: "subagent",
        input: { id: item.subagentId, threadId: item.childThreadId, prompt: item.prompt },
        output: { status: item.status, result: item.result },
      };
    case "error":
      return { name: "error", input: item.failure, output: undefined };
    case "proposed_plan":
      return { name: "proposed_plan", input: item.markdown, output: undefined };
    case "todo_list":
      return {
        name: "todo_list",
        input: { steps: item.steps, explanation: item.explanation },
        output: undefined,
      };
    default:
      return undefined;
  }
};

// Runtime bookkeeping stays in the thread journal; memory retains the actual tool exchange.
export function memoryTurnItem(item: OrchestrationV2TurnItem): Omit<MemoryMessage, "id">[] {
  if (["running", "pending", "waiting"].includes(item.status)) return [];
  const content = toolContent(item);
  if (!content) return [];
  const date = DateTime.formatIso(item.updatedAt);
  const result: Omit<MemoryMessage, "id">[] = [
    {
      key: `item:${item.id}:call`,
      kind: "tool",
      text: `${content.name}(${JSON.stringify(content.input) ?? ""})${item.status === "completed" ? "" : ` [${item.status}]`}`,
      date,
    },
  ];
  if (content.output !== undefined)
    result.push({
      key: `item:${item.id}:result`,
      kind: "echo",
      text:
        typeof content.output === "string"
          ? content.output
          : (JSON.stringify(content.output) ?? ""),
      date,
    });
  return result;
}
