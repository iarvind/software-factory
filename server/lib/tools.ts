// Describing what an agent did with its tools, and what it was refused, in one line each.
import { EDIT_ALLOW, NEVER_DENY } from "./runners/claude.ts";

/** The part of a tool call worth a line in the event log. */
export function toolSummary(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  if (name === "Bash") return String(i.command ?? "").slice(0, 400);
  if (["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"].includes(name)) return String(i.file_path ?? i.notebook_path ?? "");
  if (name === "Grep" || name === "Glob") return String(i.pattern ?? "");
  if (name === "WebFetch" || name === "WebSearch") return String(i.url ?? i.query ?? "");
  if (name === "Agent" || name === "Task") return String(i.description ?? i.prompt ?? "").slice(0, 200);
  return JSON.stringify(i).slice(0, 300);
}

const prefix = (rule: string) => /^Bash\((.*?)(?::\*)?\)$/.exec(rule)?.[1] ?? null;
const matches = (cmd: string, rules: string[]) => rules.some((r) => { const p = prefix(r); return p != null && (cmd === p || cmd.startsWith(`${p} `)); });

/** What would let a refused action through, or why nothing should. */
function remedy(tool: string, input: Record<string, unknown>, mode: string): string {
  if (tool === "Bash") {
    const cmd = String(input.command ?? "").trim().replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, "");
    if (/&&|\|\||;|\||\$\(|`|<<|(^|[^&>])&(?![&>])/.test(cmd)) return "a chained command: every part of it must be allowed";
    if (matches(cmd, NEVER_DENY)) return "never allowed to an agent";
    if (mode === "readonly" && matches(cmd, EDIT_ALLOW)) return "this run only looks; building runs may";
    const word = /^([\w./-]+)/.exec(cmd)?.[1]?.split("/").pop();
    return word ? `to allow it, add Bash(${word}:*) under Tools, Also allow` : "not on the allow list";
  }
  if (["Read", "Grep", "Glob"].includes(tool)) return "outside the worktree? add the folder under Tools, Folders the agent may read";
  if (tool.startsWith("mcp__")) return "check the MCP server under Tools";
  if (mode === "readonly" && ["Edit", "Write", "NotebookEdit", "MultiEdit"].includes(tool)) return "this run only looks";
  return `to allow it, add ${tool} under Tools, Also allow`;
}

/** One line per refused action and what would allow it, for the person reading the item's log. */
export function refusalSummary(denials: unknown[], mode = "edit"): string | null {
  const lines = new Map<string, string>();
  for (const d of denials) {
    const { tool_name: tool = "?", tool_input: input = {} } = (d ?? {}) as { tool_name?: string; tool_input?: Record<string, unknown> };
    const what = toolSummary(tool, input).split("\n")[0].slice(0, 120);
    lines.set(`${tool}:${what}`, `- ${tool}${what ? ` ${what}` : ""} (${remedy(tool, input, mode)})`);
  }
  if (!lines.size) return null;
  return `${lines.size} action(s) were refused by the project's tool rules:\n${[...lines.values()].slice(0, 12).join("\n")}`;
}
