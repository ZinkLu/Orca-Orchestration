import type { DagResponse } from "./types";

export interface ChatHandlers {
  onText: (delta: string) => void;
  onTool: (tool: { name: string; command?: string }) => void;
  onDone: (sessionId: string | null) => void;
  onError: (message: string) => void;
}

/**
 * POST a chat turn and consume the Server-Sent-Events stream the backend emits.
 * EventSource only supports GET, so we read the fetch body stream manually.
 */
export async function streamChat(
  message: string,
  sessionId: string | null,
  signal: AbortSignal,
  h: ChatHandlers,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, sessionId }),
      signal,
    });
  } catch (err) {
    if ((err as Error).name !== "AbortError") h.onError(String(err));
    return;
  }
  if (!res.ok || !res.body) {
    h.onError(`服务端返回 HTTP ${res.status}`);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        dispatchFrame(frame, h);
      }
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") h.onError(String(err));
  }
}

function dispatchFrame(frame: string, h: ChatHandlers): void {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return;
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(dataLines.join("\n"));
  } catch {
    return;
  }
  switch (event) {
    case "text":
      h.onText(String(payload.delta ?? ""));
      break;
    case "tool":
      h.onTool({ name: String(payload.name ?? ""), command: payload.command as string | undefined });
      break;
    case "done":
      h.onDone((payload.sessionId as string) ?? null);
      break;
    case "error":
      h.onError(String(payload.message ?? "未知错误"));
      break;
  }
}

export async function fetchDag(): Promise<DagResponse> {
  const res = await fetch("/api/dag");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as DagResponse;
}

export async function resolveGate(id: string, resolution: string): Promise<void> {
  const res = await fetch(`/api/gates/${encodeURIComponent(id)}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resolution }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function resetTasks(): Promise<void> {
  const res = await fetch("/api/reset", { method: "POST" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
