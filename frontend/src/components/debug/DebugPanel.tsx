"use client";

import React, { useState, useRef, useEffect } from "react";
import { Bug, Trash2, ChevronRight, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { sessionStore, useSessionState } from "@/lib/sessionStore";
import type { DebugLLMCall, DebugToolCall } from "@/lib/api";

function isLLMCall(call: DebugLLMCall | DebugToolCall): call is DebugLLMCall {
  return "model" in call;
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(n: number | null): string {
  if (n === null || n === undefined) return "-";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// ---- Debug Call Item ----
function DebugCallItem({ call }: { call: DebugLLMCall | DebugToolCall }) {
  const [expanded, setExpanded] = useState(false);

  if (isLLMCall(call)) {
    return (
      <div className="rounded-lg border border-border bg-card/50 overflow-hidden">
        <button
          type="button"
          className="w-full flex items-start gap-2 p-2.5 text-left hover:bg-muted/30 transition-colors"
          onClick={() => setExpanded(!expanded)}
        >
          <span className="shrink-0 mt-0.5">
            {expanded ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs">&#x1F916;</span>
              <span className="text-xs font-medium">LLM</span>
              {call.node && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400 font-mono">
                  {call.node}
                </span>
              )}
              <span className="text-[10px] text-muted-foreground/70 font-mono truncate">
                {call.model}
              </span>
            </div>
            <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground/60">
              <span>{formatDuration(call.duration_ms)}</span>
              {call.total_tokens != null && (
                <span>{formatTokens(call.total_tokens)} tokens</span>
              )}
              {call.input_tokens != null && call.output_tokens != null && (
                <span className="text-muted-foreground/40">
                  ({formatTokens(call.input_tokens)} in / {formatTokens(call.output_tokens)} out)
                </span>
              )}
            </div>
          </div>
        </button>
        {expanded && (
          <div className="border-t border-border px-3 py-2 space-y-2">
            <div>
              <div className="text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider mb-1">Input</div>
              <pre className="text-[11px] font-mono whitespace-pre-wrap break-all bg-muted/30 rounded-md p-2 max-h-[200px] overflow-auto text-foreground/80">
                {call.input || "(empty)"}
              </pre>
            </div>
            <div>
              <div className="text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider mb-1">Output</div>
              <pre className="text-[11px] font-mono whitespace-pre-wrap break-all bg-muted/30 rounded-md p-2 max-h-[200px] overflow-auto text-foreground/80">
                {call.output || "(empty)"}
              </pre>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Tool call
  return (
    <div className="rounded-lg border border-border bg-card/50 overflow-hidden">
      <button
        type="button"
        className="w-full flex items-start gap-2 p-2.5 text-left hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="shrink-0 mt-0.5">
          {expanded ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs">&#x1F527;</span>
            <span className="text-xs font-medium">Tool</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-950 text-amber-600 dark:text-amber-400 font-mono">
              {call.tool}
            </span>
            {call.cached && (
              <span className="text-[10px] px-1 py-0.5 rounded bg-green-50 dark:bg-green-950 text-green-600 dark:text-green-400">
                cached
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground/60">
            <span>{formatDuration(call.duration_ms)}</span>
          </div>
        </div>
      </button>
      {expanded && (
        <div className="border-t border-border px-3 py-2 space-y-2">
          {call.input && (
            <div>
              <div className="text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider mb-1">Input</div>
              <pre className="text-[11px] font-mono whitespace-pre-wrap break-all bg-muted/30 rounded-md p-2 max-h-[150px] overflow-auto text-foreground/80">
                {call.input}
              </pre>
            </div>
          )}
          <div>
            <div className="text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider mb-1">Output</div>
            <pre className="text-[11px] font-mono whitespace-pre-wrap break-all bg-muted/30 rounded-md p-2 max-h-[150px] overflow-auto text-foreground/80">
              {call.output || "(empty)"}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Debug Summary ----
function DebugSummary({ calls }: { calls: (DebugLLMCall | DebugToolCall)[] }) {
  const llmCalls = calls.filter(isLLMCall);
  const toolCalls = calls.filter((c) => !isLLMCall(c)) as DebugToolCall[];

  const llmDuration = llmCalls.reduce((sum, c) => sum + (c.duration_ms || 0), 0);
  const llmTokens = llmCalls.reduce((sum, c) => sum + (c.total_tokens || 0), 0);
  const toolDuration = toolCalls.reduce((sum, c) => sum + (c.duration_ms || 0), 0);

  if (calls.length === 0) return null;

  return (
    <div className="border-t border-border pt-2 mt-2 space-y-0.5">
      <div className="text-[10px] text-muted-foreground/50 uppercase tracking-wider mb-1">Summary</div>
      {llmCalls.length > 0 && (
        <div className="text-[11px] text-muted-foreground/70">
          &#x1F916; LLM: {llmCalls.length} calls &middot; {formatDuration(llmDuration)} &middot; {formatTokens(llmTokens)} tokens
        </div>
      )}
      {toolCalls.length > 0 && (
        <div className="text-[11px] text-muted-foreground/70">
          &#x1F527; Tool: {toolCalls.length} calls &middot; {formatDuration(toolDuration)}
        </div>
      )}
    </div>
  );
}

// ---- Main Panel ----
interface DebugPanelProps {
  sessionId: string;
}

export default function DebugPanel({ sessionId }: DebugPanelProps) {
  const { debugCalls, isStreaming } = useSessionState(sessionId);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom during streaming
  useEffect(() => {
    if (isStreaming && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [debugCalls.length, isStreaming]);

  const handleClear = () => {
    sessionStore.clearDebugCalls(sessionId);
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/40 shrink-0">
        <div className="flex items-center gap-2">
          <Bug className="w-4 h-4 text-muted-foreground" />
          <span className="text-xs font-medium">Debug</span>
          {debugCalls.length > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
              {debugCalls.length}
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="w-6 h-6"
          onClick={handleClear}
          title="清除记录"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </div>

      {/* Call List */}
      <div ref={scrollRef} className="flex-1 overflow-auto px-3 py-2 space-y-2">
        {debugCalls.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground/40">
            <Bug className="w-8 h-8 mb-2" />
            <p className="text-xs">Debug mode active</p>
            <p className="text-[10px] mt-1">Send a message to see LLM/Tool calls</p>
          </div>
        ) : (
          <>
            {debugCalls.map((call, index) => (
              <DebugCallItem key={index} call={call} />
            ))}
            <DebugSummary calls={debugCalls} />
          </>
        )}
      </div>
    </div>
  );
}
