"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import { Bug, X, ChevronRight, ChevronDown, Copy, Check } from "lucide-react";
import CollapsibleInput from "./CollapsibleInput";
import { Button } from "@/components/ui/button";
import { sessionStore, useSessionState } from "@/lib/sessionStore";
import type { DebugCall, DebugDivider, DebugLLMCall, DebugToolCall } from "@/lib/api";
import { isDivider, isLLMCall } from "@/lib/sessionStore";

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

// ---- Divider Card ----
function DividerCard({ call }: { call: DebugDivider }) {
  const time = new Date(call.timestamp);
  const timeStr = time.toLocaleString();
  const truncatedMessage = call.userMessage.length > 80
    ? call.userMessage.slice(0, 80) + "..."
    : call.userMessage;

  return (
    <div className="my-3 py-2.5 rounded-md bg-blue-50/80 dark:bg-blue-950/40">
      <div className="flex items-start gap-2.5 px-2.5 text-xs">
        <span className="shrink-0 text-lg">&#x1F4AC;</span>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-blue-700 dark:text-blue-300 mb-1">用户请求</div>
          <div className="text-blue-600/80 dark:text-blue-400/80 truncate font-mono text-[11px] mb-1">
            {truncatedMessage}
          </div>
          <div className="text-[10px] text-blue-500/60 dark:text-blue-500/50">
            {timeStr}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Motivation Card ----
function MotivationCard({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div className="my-2 py-1.5 px-3 rounded-md bg-muted/50">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="text-[10px]">&#x275D;</span>
        <span>{text}</span>
      </div>
    </div>
  );
}

// ---- Debug Call Item ----
function DebugCallItem({ call }: { call: DebugLLMCall | DebugToolCall }) {
  // Always collapsed by default
  const [expanded, setExpanded] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  // Determine card status
  const isRunning = !!call._inProgress;
  const hasError = !isRunning && call.output?.startsWith("[ERROR]");

  // Background classes based on status
  let bgClass = "bg-card/50";  // Default: white/card
  if (isRunning) {
    bgClass = "bg-amber-50/80 dark:bg-amber-950/30 animate-pulse";
  } else if (hasError) {
    bgClass = "bg-red-50/80 dark:bg-red-950/30";
  }

  if (isLLMCall(call)) {
    // Node-specific label colors for task mode
    const nodeColorMap: Record<string, string> = {
      planner: "bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300",
      executor: "bg-green-100 dark:bg-green-950 text-green-700 dark:text-green-300",
      replanner: "bg-orange-100 dark:bg-orange-950 text-orange-700 dark:text-orange-300",
      router: "bg-purple-100 dark:bg-purple-950 text-purple-700 dark:text-purple-300",
      agent: "bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-400",
    };
    const nodeLabel: Record<string, string> = {
      planner: "Planner",
      executor: "Executor",
      replanner: "Replanner",
      router: "Router",
      agent: call.node || "agent",
    };

    const nodeCls = call.node ? (nodeColorMap[call.node] || nodeColorMap.agent) : nodeColorMap.agent;
    const nodeText = call.node ? (nodeLabel[call.node] || call.node) : "";

    return (
      <div className={`rounded-lg border border-border overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-300 ${bgClass}`}>
        <button
          type="button"
          className="w-full flex items-center gap-2 p-2.5 text-left hover:bg-muted/30 transition-colors"
          onClick={() => setExpanded(!expanded)}
        >
          <span className="shrink-0">
            {expanded ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-xs">&#x1F916;</span>
              <span className="text-xs font-medium">LLM</span>
              {nodeText && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono font-semibold ${nodeCls}`}>
                  {nodeText}
                </span>
              )}
              <span className="text-[10px] text-muted-foreground/70 font-mono truncate">
                {call.model}
              </span>
              <span className="text-[10px] text-muted-foreground/60 ml-auto">
                {formatDuration(call.duration_ms)}
              </span>
            </div>
            {call.total_tokens != null && (
              <div className="text-[10px] text-muted-foreground/50 mt-0.5">
                {call.tokens_estimated && <span title="估算值（流式输出时 API 不返回 token 信息）">~</span>}
                {formatTokens(call.total_tokens)} tokens
                {call.input_tokens != null && call.output_tokens != null && (
                  <span className="text-muted-foreground/40">
                    {" "}({call.tokens_estimated && "~"}{formatTokens(call.input_tokens)} in / {call.tokens_estimated && "~"}{formatTokens(call.output_tokens)} out)
                  </span>
                )}
              </div>
            )}
          </div>
        </button>
        <div
          ref={contentRef}
          className={`overflow-hidden transition-all duration-300 ease-in-out ${
            expanded ? "max-h-[800px] opacity-100" : "max-h-0 opacity-0"
          }`}
        >
          <div className="border-t border-border px-3 py-2 space-y-2">
            {/* Input - 使用可折叠树状展示 */}
            <CollapsibleInput input={call.input || ""} />
            {/* Reasoning — 推理模型的思考过程 */}
            {call.reasoning && (
              <div>
                <div className="text-[10px] font-medium text-purple-500/80 uppercase tracking-wider mb-1">
                  Reasoning ({call.reasoning.length} chars)
                </div>
                <pre className="text-[11px] font-mono whitespace-pre-wrap break-all bg-purple-50/50 dark:bg-purple-950/30 border border-purple-200/40 dark:border-purple-800/30 rounded-md p-2 max-h-[300px] overflow-auto text-foreground/70">
                  {call.reasoning}
                </pre>
              </div>
            )}
            {/* Output */}
            <div>
              <div className="text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider mb-1">Output</div>
              <pre className="text-[11px] font-mono whitespace-pre-wrap break-all bg-muted/30 rounded-md p-2 max-h-[200px] overflow-auto text-foreground/80">
                {call._inProgress ? "(streaming...)" : (call.output || "(no content)")}
              </pre>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Tool call
  return (
    <div className={`rounded-lg border border-border overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-300 ${bgClass}`}>
      <button
        type="button"
        className="w-full flex items-center gap-2 p-2.5 text-left hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="shrink-0">
          {expanded ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
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
            <span className="text-[10px] text-muted-foreground/60 ml-auto">
              {formatDuration(call.duration_ms)}
            </span>
          </div>
        </div>
      </button>
      <div
        ref={contentRef}
        className={`overflow-hidden transition-all duration-300 ease-in-out ${
          expanded ? "max-h-[500px] opacity-100" : "max-h-0 opacity-0"
        }`}
      >
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
      </div>
    </div>
  );
}

// ---- Debug Summary ----
function DebugSummary({ calls }: { calls: DebugCall[] }) {
  const llmCalls = calls.filter(isLLMCall);
  const toolCalls = calls.filter((c): c is DebugToolCall => !isLLMCall(c) && !isDivider(c));

  const llmDuration = llmCalls.reduce((sum, c) => sum + (c.duration_ms || 0), 0);
  const llmTokens = llmCalls.reduce((sum, c) => sum + (c.total_tokens || 0), 0);
  const toolDuration = toolCalls.reduce((sum, c) => sum + (c.duration_ms || 0), 0);
  // 检查是否有估算的 token
  const hasEstimated = llmCalls.some(c => c.tokens_estimated);

  if (calls.length === 0) return null;

  return (
    <div className="border-t border-border pt-2 mt-2 space-y-0.5">
      <div className="text-[10px] text-muted-foreground/50 uppercase tracking-wider mb-1">Summary</div>
      {llmCalls.length > 0 && (
        <div className="text-[11px] text-muted-foreground/70">
          &#x1F916; LLM: {llmCalls.length} calls &middot; {formatDuration(llmDuration)} &middot; {hasEstimated && <span title="包含估算值">~</span>}{formatTokens(llmTokens)} tokens
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
  onClose?: () => void;
}

export default function DebugPanel({ sessionId, onClose }: DebugPanelProps) {
  const { debugCalls, isStreaming } = useSessionState(sessionId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  const handleCopySessionId = useCallback(() => {
    navigator.clipboard.writeText(sessionId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [sessionId]);

  // Auto-scroll to bottom during streaming with smooth behavior
  const prevLengthRef = useRef(0);
  useEffect(() => {
    if (isStreaming && scrollRef.current && debugCalls.length > prevLengthRef.current) {
      const scrollContainer = scrollRef.current;
      scrollContainer.scrollTo({
        top: scrollContainer.scrollHeight,
        behavior: "smooth",
      });
    }
    prevLengthRef.current = debugCalls.length;
  }, [debugCalls.length, isStreaming]);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/40 shrink-0">
        <div className="flex items-center gap-2 group">
          <Bug className="w-4 h-4 text-muted-foreground" />
          <span className="text-xs font-medium">Debug</span>
          {debugCalls.length > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
              {debugCalls.length}
            </span>
          )}
          <span
            className="text-[10px] font-mono text-muted-foreground/60 cursor-pointer hover:text-muted-foreground truncate max-w-[140px] flex items-center gap-1"
            title={`Session: ${sessionId} (点击复制)`}
            onClick={handleCopySessionId}
          >
            {sessionId}
            {copied ? (
              <Check className="w-3 h-3 text-green-500 shrink-0" />
            ) : (
              <Copy className="w-3 h-3 shrink-0 opacity-0 group-hover:opacity-100" />
            )}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="w-6 h-6"
          onClick={onClose}
          title="关闭"
        >
          <X className="w-3.5 h-3.5" />
        </Button>
      </div>

      {/* Call List */}
      <div ref={scrollRef} className="flex-1 overflow-auto px-3 py-2 space-y-2 mb-16 scroll-smooth pb-4">
        {debugCalls.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground/40">
            <Bug className="w-8 h-8 mb-2" />
            <p className="text-xs">Debug mode active</p>
            <p className="text-[10px] mt-1">Send a message to see LLM/Tool calls</p>
          </div>
        ) : (
          <>
            {debugCalls.map((call, index) => (
              <React.Fragment key={index}>
                {isDivider(call) ? (
                  <DividerCard call={call} />
                ) : (
                  <>
                    <MotivationCard text={call.motivation || ""} />
                    <DebugCallItem call={call} />
                  </>
                )}
              </React.Fragment>
            ))}
          </>
        )}
      </div>

      {/* Summary - Fixed at bottom */}
      <div className="shrink-0 border-t border-border px-3 py-2 bg-card/50">
        <DebugSummary calls={debugCalls} />
      </div>
    </div>
  );
}
