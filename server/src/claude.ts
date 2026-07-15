import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { COORDINATOR_SYSTEM_PROMPT } from "./systemPrompt";
import { resolveClaudeExecutable } from "./claudeBin";

export interface StreamCallbacks {
  onText: (delta: string) => void;
  onTool: (tool: { name: string; command?: string }) => void;
  onDone: (sessionId: string | null) => void;
  onError: (message: string) => void;
}

/**
 * Drive one conversational turn through the Claude Agent SDK.
 *
 * Text is streamed from partial `stream_event` deltas; the orca commands Claude
 * runs are surfaced from `tool_use` blocks on assistant messages so the UI can
 * show what it did. `resume` threads the SDK session across HTTP turns.
 */
export async function runChatTurn(
  message: string,
  sessionId: string | null,
  cwd: string,
  signal: AbortSignal,
  cb: StreamCallbacks,
): Promise<void> {
  const abort = new AbortController();
  if (signal.aborted) abort.abort();
  else signal.addEventListener("abort", () => abort.abort(), { once: true });

  // In a compiled single-file binary the SDK can't find its bundled native CLI;
  // hand it the installed `claude` on PATH. Undefined in a dev checkout (the
  // SDK's own resolver works there), so we only set the key when we found one.
  const claudeExe = resolveClaudeExecutable();

  const options: Options = {
    systemPrompt: COORDINATOR_SYSTEM_PROMPT,
    // Claude drives Orca via the CLI (user's choice) plus doc writing for PRD/spec.
    allowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "TodoWrite"],
    permissionMode: "bypassPermissions",
    // Don't inherit the machine's global CLAUDE.md / settings into the coordinator.
    settingSources: [],
    includePartialMessages: true,
    cwd,
    abortController: abort,
    ...(claudeExe ? { pathToClaudeCodeExecutable: claudeExe } : {}),
    ...(sessionId ? { resume: sessionId } : {}),
    stderr: (d) => {
      if (process.env.DEBUG_SDK) console.error("[sdk]", d);
    },
  };

  let lastSession: string | null = sessionId;

  try {
    for await (const msg of query({ prompt: message, options })) {
      switch (msg.type) {
        case "system":
          if (msg.subtype === "init") lastSession = msg.session_id;
          break;

        case "stream_event": {
          const ev = msg.event as {
            type?: string;
            delta?: { type?: string; text?: string };
          };
          if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
            cb.onText(ev.delta.text ?? "");
          }
          break;
        }

        case "assistant": {
          const content = (msg.message?.content ?? []) as Array<{
            type: string;
            name?: string;
            input?: Record<string, unknown>;
          }>;
          for (const block of content) {
            if (block.type === "tool_use") {
              const command =
                block.name === "Bash" ? (block.input?.command as string | undefined) : undefined;
              cb.onTool({ name: block.name ?? "tool", command });
            }
          }
          lastSession = msg.session_id;
          break;
        }

        case "result":
          lastSession = msg.session_id;
          if (msg.subtype !== "success") {
            cb.onError(`会话结束：${msg.subtype}`);
          }
          break;
      }
    }
    cb.onDone(lastSession);
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      cb.onDone(lastSession);
    } else {
      cb.onError(String((err as Error).message ?? err));
    }
  }
}
