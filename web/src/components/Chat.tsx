import { useEffect, useRef, useState } from "react";
import { streamChat } from "../api";
import type { ChatMessage } from "../types";

function shorten(cmd: string, max = 120): string {
  const oneLine = cmd.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

export function Chat({ onTurnComplete }: { onTurnComplete: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const sessionIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Instant pin-to-bottom: with rapid streaming deltas, "smooth" fights itself
    // and stutters. Frequent small jumps read as smooth on their own.
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function patchLast(fn: (m: ChatMessage) => ChatMessage) {
    setMessages((prev) => {
      if (!prev.length) return prev;
      const copy = prev.slice();
      copy[copy.length - 1] = fn(copy[copy.length - 1]);
      return copy;
    });
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);
    setMessages((prev) => [
      ...prev,
      { role: "user", text },
      { role: "assistant", text: "", tools: [], streaming: true },
    ]);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    await streamChat(text, sessionIdRef.current, ctrl.signal, {
      onText: (delta) => patchLast((m) => ({ ...m, text: m.text + delta })),
      onTool: (tool) =>
        patchLast((m) => ({ ...m, tools: [...(m.tools ?? []), { name: tool.name, command: tool.command }] })),
      onDone: (sid) => {
        if (sid) sessionIdRef.current = sid;
        patchLast((m) => ({ ...m, streaming: false }));
        setBusy(false);
        onTurnComplete();
      },
      onError: (msg) => {
        patchLast((m) => ({ ...m, text: m.text + `\n\n⚠️ ${msg}`, streaming: false }));
        setBusy(false);
      },
    });
  }

  function stop() {
    abortRef.current?.abort();
    patchLast((m) => ({ ...m, streaming: false }));
    setBusy(false);
  }

  return (
    <div className="chat">
      <div className="chat__scroll" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="chat__welcome">
            <h2>与 Claude 协调员对话</h2>
            <p>
              描述你想做的项目或功能。Claude 会和你澄清需求、给出技术方案，并把执行计划拆解成
              Orca 编排任务 —— 右侧会实时长出这张任务 DAG。
            </p>
            <div className="chat__examples">
              {[
                "帮我规划一个多人协作的待办事项 SaaS 的 MVP",
                "把一个博客系统拆成可并行开发的任务 DAG",
              ].map((ex) => (
                <button key={ex} onClick={() => setInput(ex)}>
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg msg--${m.role}`}>
            <div className="msg__role">{m.role === "user" ? "你" : "Claude"}</div>
            {m.tools && m.tools.length > 0 && (
              <div className="msg__tools">
                {m.tools.map((t, j) => (
                  <div key={j} className="tool-chip" title={t.command}>
                    <span className="tool-chip__icon">✎</span>
                    <code>{t.command ? shorten(t.command) : t.name}</code>
                  </div>
                ))}
              </div>
            )}
            {m.text && (
              <div className="msg__text">
                {m.text}
                {m.streaming && <span className="caret" aria-hidden="true" />}
              </div>
            )}
            {m.streaming && !m.text && (
              <div className="msg__text msg__text--thinking" aria-label="Claude 正在思考">
                <span className="thinking-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="chat__composer">
        <textarea
          value={input}
          placeholder="描述需求，或回答 Claude 的问题…（Enter 发送，Shift+Enter 换行）"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
        />
        {busy ? (
          <button className="btn btn--stop" onClick={stop}>
            停止
          </button>
        ) : (
          <button className="btn btn--send" onClick={send} disabled={!input.trim()}>
            发送
          </button>
        )}
      </div>
    </div>
  );
}
