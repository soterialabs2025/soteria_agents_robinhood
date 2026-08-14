"use client";

import { useState, useEffect, useRef } from "react";
import { useAgent } from "./hooks/useAgent";
import ReactMarkdown from "react-markdown";

export default function Home() {
  const [input, setInput] = useState("");
  const { messages, sendMessage, isThinking } = useAgent();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isThinking]);

  const onSendMessage = async () => {
    if (!input.trim() || isThinking) return;
    const message = input;
    setInput("");
    await sendMessage(message);
  };

  return (
    <div className="console-panel console-glow relative flex h-[min(72vh,720px)] flex-col overflow-hidden rounded-xl border border-console-border bg-console-panel">
      {/* Title bar */}
      <div className="relative z-10 flex items-center gap-2 border-b border-console-border bg-console-bg px-4 py-2.5 text-xs text-demeter-blue-soft/80">
        <span className="h-2.5 w-2.5 rounded-full bg-[#ef4444]/80" />
        <span className="h-2.5 w-2.5 rounded-full bg-console-amber/80" />
        <span className="h-2.5 w-2.5 rounded-full bg-demeter-blue" />
        <span className="ml-2 tracking-wide">liquid-strat-min-v4 — session</span>
      </div>

      {/* Messages */}
      <div className="relative z-10 flex-1 space-y-4 overflow-y-auto p-4 font-mono text-sm leading-relaxed">
        {messages.length === 0 ? (
          <div className="space-y-2 pt-8 text-center text-demeter-blue-soft/70">
            <p className="text-demeter-blue">&gt; demeter --console</p>
            <p className="text-xs">Ask about Liquid holdings, token prices, exit rules, or rotations.</p>
          </div>
        ) : (
          messages.map((msg, index) => (
            <div
              key={index}
              className={
                msg.sender === "user"
                  ? "ml-8 border-l-2 border-demeter-blue/40 pl-3 text-demeter-blue-soft"
                  : "mr-4 text-demeter-blue"
              }
            >
              <span className="mb-1 block text-[10px] uppercase tracking-wider text-demeter-blue-muted">
                {msg.sender === "user" ? "stdin" : "demeter"}
              </span>
              <div
                className={
                  msg.sender === "user"
                    ? "whitespace-pre-wrap"
                    : "prose-console [&_a]:text-demeter-blue-soft [&_a]:underline [&_code]:rounded [&_code]:bg-demeter-blue-muted/25 [&_code]:px-1 [&_code]:text-demeter-blue-soft [&_p]:my-1 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-4"
                }
              >
                <ReactMarkdown
                  components={{
                    a: props => {
                      let href = props.href ?? "";
                      if (typeof href === "string" && href.includes("etherscan.io")) {
                        href = href.replace(
                          /https?:\/\/([\w.-]*\.)?etherscan\.io/g,
                          "https://robinhoodchain.blockscout.com"
                        );
                      }
                      return (
                        <a
                          {...props}
                          href={href}
                          className="text-demeter-blue-soft underline decoration-demeter-blue-muted underline-offset-2 hover:text-demeter-blue"
                          target="_blank"
                          rel="noopener noreferrer"
                        />
                      );
                    },
                  }}
                >
                  {msg.sender === "agent"
                    ? msg.text.replace(
                        /https?:\/\/([\w.-]*\.)?etherscan\.io/g,
                        "https://robinhoodchain.blockscout.com"
                      )
                    : msg.text}
                </ReactMarkdown>
              </div>
            </div>
          ))
        )}

        {isThinking && (
          <div className="flex items-center gap-2 text-demeter-blue-soft/70">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-demeter-blue" />
            <span className="text-xs tracking-wide">processing…</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="relative z-10 border-t border-console-border bg-console-bg p-3">
        <div className="flex items-center gap-2">
          <span className="select-none text-demeter-blue">&gt;</span>
          <input
            type="text"
            className="min-w-0 flex-1 bg-transparent font-mono text-sm text-demeter-blue placeholder:text-demeter-blue-muted outline-none caret-demeter-blue"
            placeholder="type command or question…"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && onSendMessage()}
            disabled={isThinking}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            onClick={onSendMessage}
            disabled={isThinking}
            className={
              isThinking
                ? "cursor-not-allowed rounded-md border border-console-border px-4 py-2 text-xs uppercase tracking-wider text-demeter-blue-muted"
                : "rounded-md border border-demeter-blue/50 bg-demeter-blue/10 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-demeter-blue transition hover:border-demeter-blue hover:bg-demeter-blue/20 hover:shadow-[0_0_16px_rgba(52,125,237,0.2)]"
            }
          >
            send
          </button>
        </div>
      </div>
    </div>
  );
}
