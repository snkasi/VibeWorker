"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import { Send, Square, Sparkles, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { type ToolCall } from "@/lib/api";
import { useSessionState, useSessionActions } from "@/lib/sessionStore";
import type { ThinkingStep } from "@/lib/sessionStore";
import ApprovalDialog from "./ApprovalDialog";
import PlanCard from "./PlanCard";

/** Custom code renderer with syntax highlighting for ReactMarkdown */
const markdownCodeComponents = {
    code({ className, children, ...props }: React.ComponentPropsWithRef<"code">) {
        const match = /language-(\w+)/.exec(className || "");
        const codeString = String(children).replace(/\n$/, "");
        if (match) {
            return (
                <SyntaxHighlighter
                    style={oneLight}
                    language={match[1]}
                    PreTag="div"
                    customStyle={{
                        margin: 0,
                        padding: "0.75rem 1rem",
                        background: "transparent",
                        fontSize: "0.7rem",
                        lineHeight: 1.6,
                    }}
                    codeTagProps={{
                        style: {
                            fontFamily: "'JetBrains Mono', var(--font-geist-mono), monospace",
                        },
                    }}
                >
                    {codeString}
                </SyntaxHighlighter>
            );
        }
        return (
            <code className={className} {...props}>
                {children}
            </code>
        );
    },
};

interface ChatPanelProps {
    sessionId: string;
    onFileOpen?: (path: string) => void;
}

/** Map tool names to friendly Chinese labels with emoji */
const TOOL_LABELS: Record<string, { label: string; icon: string }> = {
    read_file: { label: "读取文件", icon: "📄" },
    fetch_url: { label: "获取网页", icon: "🌐" },
    python_repl: { label: "执行代码", icon: "🐍" },
    terminal: { label: "执行命令", icon: "💻" },
    search_knowledge_base: { label: "检索知识库", icon: "🔍" },
    memory_write: { label: "存储记忆", icon: "💾" },
    memory_search: { label: "搜索记忆", icon: "🧠" },
    plan_create: { label: "制定计划", icon: "📋" },
    plan_update: { label: "更新进度", icon: "📊" },
};

function getToolDisplay(toolName: string) {
    if (TOOL_LABELS[toolName]) return TOOL_LABELS[toolName];
    // MCP tools: mcp_servername_toolname → "MCP: toolname"
    if (toolName.startsWith("mcp_")) {
        const parts = toolName.substring(4).split("_");
        const toolPart = parts.length > 1 ? parts.slice(1).join("_") : parts[0];
        return { label: `MCP: ${toolPart}`, icon: "🔌" };
    }
    return { label: toolName, icon: "🔧" };
}

/** Normalize a tool call: detect [CACHE_HIT] marker in output and strip it */
function normalizeToolCall(tc: ToolCall): ToolCall {
    if (tc.cached || !tc.output?.startsWith("[CACHE_HIT]")) return tc;
    return {
        ...tc,
        output: tc.output.substring(11),
        cached: true,
    };
}

/** Extract a human-readable summary from tool input JSON */
function getToolInputSummary(toolName: string, input?: string): string {
    if (!input) return "";
    try {
        const parsed = JSON.parse(input);
        switch (toolName) {
            case "read_file":
                return parsed.file_path || parsed.path || input;
            case "fetch_url":
                return parsed.url || input;
            case "python_repl":
                return (parsed.code || input).slice(0, 80) + ((parsed.code || input).length > 80 ? "..." : "");
            case "terminal":
                return parsed.command || input;
            case "search_knowledge_base":
                return parsed.query || input;
            default:
                return input.slice(0, 80);
        }
    } catch {
        // input is not JSON, try to parse key=value style like: {'file_path':'...'}
        const match = input.match(/['"]?(?:file_path|url|command|query|code)['"]?\s*[:=]\s*['"]([^'"]+)/i);
        if (match) return match[1];
        return input.slice(0, 80);
    }
}

/** Convert literal \n sequences in strings to real newlines */
function unescapeNewlines(str: string): string {
    return str.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
}

/** Wrap code/command content as a markdown code block */
function wrapAsCodeBlock(code: string, lang = ""): string {
    const cleaned = unescapeNewlines(code);
    return `\`\`\`${lang}\n${cleaned}\n\`\`\``;
}

/** Render tool input in a friendly formatted way */
function ToolInputDisplay({ toolName, input }: { toolName: string; input: string }) {
    try {
        const parsed = JSON.parse(input);
        const entries = Object.entries(parsed);

        // Check if there are code/command fields that need special rendering
        const codeEntries = entries.filter(([key]) => key === "code" || key === "command");
        const otherEntries = entries.filter(([key]) => key !== "code" && key !== "command");

        return (
            <div className="space-y-2">
                {/* Non-code fields: render as a single JSON code block */}
                {otherEntries.length > 0 && (
                    <div className="text-xs rounded-lg overflow-hidden chat-message-content tool-detail-content">
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownCodeComponents}>
                            {wrapAsCodeBlock(
                                JSON.stringify(
                                    Object.fromEntries(otherEntries),
                                    null,
                                    2
                                ),
                                "json"
                            )}
                        </ReactMarkdown>
                    </div>
                )}
                {/* Code/command fields: render with syntax highlighting */}
                {codeEntries.map(([key, value]) => {
                    const strValue = typeof value === "string" ? value : JSON.stringify(value, null, 2);
                    const lang = key === "code" ? "python" : "bash";
                    return (
                        <div key={key}>
                            <span className="text-[10px] uppercase tracking-wider text-muted-foreground/50 font-semibold">{key}</span>
                            <div className="mt-0.5 text-xs rounded-lg overflow-hidden chat-message-content tool-detail-content">
                                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownCodeComponents}>
                                    {wrapAsCodeBlock(strValue, lang)}
                                </ReactMarkdown>
                            </div>
                        </div>
                    );
                })}
            </div>
        );
    } catch {
        // Fallback: render raw input as a code block
        return (
            <div className="text-xs rounded-lg overflow-hidden chat-message-content tool-detail-content">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownCodeComponents}>
                    {wrapAsCodeBlock(unescapeNewlines(input), "json")}
                </ReactMarkdown>
            </div>
        );
    }
}

/** Render tool output in a readable format with Markdown */
function ToolOutputDisplay({ toolName, output }: { toolName: string; output: string }) {
    const processed = unescapeNewlines(output);
    const displayText = processed.length > 3000
        ? processed.slice(0, 3000) + "\n\n---\n> ⚠️ 内容过长，已截断显示"
        : processed;

    // python_repl / terminal: wrap in code block for syntax highlighting
    if (toolName === "python_repl" || toolName === "terminal") {
        const wrapped = `\`\`\`\n${displayText}\n\`\`\``;
        return (
            <div className="text-xs max-h-72 overflow-y-auto rounded-lg chat-message-content tool-detail-content">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownCodeComponents}>
                    {wrapped}
                </ReactMarkdown>
            </div>
        );
    }

    // All other tools: render as rich Markdown
    return (
        <div className="text-xs max-h-72 overflow-y-auto rounded-lg bg-muted/40 p-2.5 chat-message-content tool-detail-content">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownCodeComponents}>
                {displayText}
            </ReactMarkdown>
        </div>
    );
}

export default function ChatPanel({
    sessionId,
    onFileOpen,
}: ChatPanelProps) {
    // Store-driven state
    const { messages, isStreaming, streamingContent, thinkingSteps, approvalRequest, currentPlan } = useSessionState(sessionId);
    const { sendMessage, stopStream, clearApproval, addSessionAllowedTool } = useSessionActions(sessionId);

    // Local UI state
    const [inputValue, setInputValue] = useState("");
    const [expandedTools, setExpandedTools] = useState<Set<number>>(new Set());
    const [expandedStreamingTools, setExpandedStreamingTools] = useState<Set<number>>(new Set());
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);

    // Reset expandedStreamingTools when a new stream starts
    const prevStreamingRef = useRef(false);
    useEffect(() => {
        if (isStreaming && !prevStreamingRef.current) {
            setExpandedStreamingTools(new Set());
        }
        prevStreamingRef.current = isStreaming;
    }, [isStreaming]);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages, streamingContent]);

    // Auto-focus input when session changes
    useEffect(() => {
        inputRef.current?.focus();
    }, [sessionId]);

    const handleSend = useCallback(() => {
        const text = inputValue.trim();
        if (!text || isStreaming) return;
        setInputValue("");
        sendMessage(text);
    }, [inputValue, isStreaming, sendMessage]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    const handleStop = useCallback(() => {
        stopStream();
    }, [stopStream]);

    const toggleToolExpand = (index: number) => {
        setExpandedTools((prev) => {
            const next = new Set(prev);
            if (next.has(index)) next.delete(index);
            else next.add(index);
            return next;
        });
    };

    const toggleStreamingToolExpand = (index: number) => {
        setExpandedStreamingTools((prev) => {
            const next = new Set(prev);
            if (next.has(index)) next.delete(index);
            else next.add(index);
            return next;
        });
    };

    return (
        <div className="flex flex-col h-full">
            {/* Messages Area */}
            <div className="flex-1 overflow-y-auto px-6 py-4">
                {messages.length === 0 && !isStreaming && (
                    <div className="flex flex-col items-center justify-center h-full text-center animate-fade-in-up">
                        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[var(--vw-blue)] to-[var(--vw-blue)]/70 flex items-center justify-center mb-4 shadow-lg">
                            <Sparkles className="w-8 h-8 text-white" />
                        </div>
                        <h2 className="text-xl font-semibold mb-2">VibeWorker</h2>
                        <p className="text-muted-foreground text-sm max-w-md">
                            你的本地 AI 副手，拥有真实记忆和可扩展技能。
                            <br />
                            输入消息开始对话...
                        </p>
                    </div>
                )}

                {messages.map((msg, i) => (
                    <div
                        key={i}
                        className={`mb-4 animate-fade-in-up ${msg.role === "user" ? "flex justify-end" : ""
                            }`}
                    >
                        {msg.role === "user" ? (
                            <div className="max-w-[75%] px-4 py-3 rounded-2xl rounded-tr-md bg-[var(--vw-blue)] text-white shadow-sm">
                                <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                            </div>
                        ) : (
                            <div className="max-w-[90%]">
                                {/* Historical Plan Card */}
                                {msg.plan && (
                                    <PlanCard plan={msg.plan} defaultCollapsed />
                                )}
                                {/* Tool Calls (Collapsible Thoughts) */}
                                {msg.tool_calls && msg.tool_calls.length > 0 && (
                                    <div className="mb-3 space-y-2">
                                        {msg.tool_calls.map((rawTc, j) => {
                                            const tc = normalizeToolCall(rawTc);
                                            return (
                                            <div key={j} className="tool-call-card">
                                                <div
                                                    className="tool-call-header"
                                                    onClick={() => toggleToolExpand(i * 100 + j)}
                                                >
                                                    <div className="w-2 h-2 rounded-full bg-green-500" />
                                                    <span className="text-xs font-medium text-muted-foreground">
                                                        {getToolDisplay(tc.tool).icon} {getToolDisplay(tc.tool).label}
                                                    </span>
                                                    <span className="text-xs text-muted-foreground/60 truncate flex-1 font-mono">
                                                        {getToolInputSummary(tc.tool, tc.input)}
                                                    </span>
                                                    {tc.cached && (
                                                        <span title="使用缓存" className="inline-flex">
                                                            <Zap className="w-3 h-3 text-muted-foreground/30" />
                                                        </span>
                                                    )}
                                                    <span className="text-xs text-muted-foreground/40">
                                                        {expandedTools.has(i * 100 + j) ? "▼" : "▶"}
                                                    </span>
                                                </div>
                                                {expandedTools.has(i * 100 + j) && (
                                                    <div className="tool-call-body animate-fade-in-up">
                                                        {tc.input && (
                                                            <div className="mb-2.5">
                                                                <div className="text-[10px] uppercase tracking-wider text-muted-foreground/50 font-semibold mb-1">输入</div>
                                                                <ToolInputDisplay toolName={tc.tool} input={tc.input} />
                                                            </div>
                                                        )}
                                                        {tc.output && (
                                                            <div>
                                                                <div className="text-[10px] uppercase tracking-wider text-muted-foreground/50 font-semibold mb-1">输出</div>
                                                                <ToolOutputDisplay toolName={tc.tool} output={tc.output} />
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                            );
                                        })}
                                    </div>
                                )}
                                {/* Response Content */}
                                <div className="chat-message-content text-sm">
                                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownCodeComponents}>
                                        {msg.content}
                                    </ReactMarkdown>
                                </div>
                            </div>
                        )}
                    </div>
                ))}

                {/* Streaming response */}
                {isStreaming && (
                    <div className="mb-4 animate-fade-in-up">
                        {/* Live Plan Card */}
                        {currentPlan && (
                            <PlanCard plan={currentPlan} isLive />
                        )}
                        {/* Live thinking steps - grouped by tool */}
                        {thinkingSteps.length > 0 && (
                            <div className="mb-3 space-y-2">
                                {(() => {
                                    // Group steps into tool calls with input/output
                                    const toolGroups: { tool: string; input?: string; output?: string; isComplete: boolean; cached?: boolean }[] = [];
                                    for (const step of thinkingSteps) {
                                        if (step.type === "tool_start") {
                                            toolGroups.push({
                                                tool: step.tool,
                                                input: step.input,
                                                isComplete: false,
                                            });
                                        } else if (step.type === "tool_end") {
                                            // Find matching tool_start and add output
                                            for (let i = toolGroups.length - 1; i >= 0; i--) {
                                                if (toolGroups[i].tool === step.tool && !toolGroups[i].isComplete) {
                                                    toolGroups[i].output = step.output;
                                                    toolGroups[i].isComplete = true;
                                                    toolGroups[i].cached = step.cached;
                                                    break;
                                                }
                                            }
                                        }
                                    }
                                    return toolGroups.map((tc, j) => (
                                        <div key={j} className="tool-call-card">
                                            <div
                                                className="tool-call-header cursor-pointer"
                                                onClick={() => toggleStreamingToolExpand(j)}
                                            >
                                                <div className={`w-2 h-2 rounded-full ${tc.isComplete ? "bg-green-500" : "bg-amber-500 animate-pulse-soft"}`} />
                                                <span className="text-xs font-medium text-muted-foreground">
                                                    {getToolDisplay(tc.tool).icon} {getToolDisplay(tc.tool).label}
                                                </span>
                                                <span className="text-xs text-muted-foreground/60 truncate flex-1 font-mono">
                                                    {getToolInputSummary(tc.tool, tc.input)}
                                                </span>
                                                {tc.cached && (
                                                    <span title="使用缓存" className="inline-flex">
                                                        <Zap className="w-3 h-3 text-muted-foreground/30" />
                                                    </span>
                                                )}
                                                <span className="text-xs text-muted-foreground/40">
                                                    {expandedStreamingTools.has(j) ? "▼" : "▶"}
                                                </span>
                                            </div>
                                            {expandedStreamingTools.has(j) && (
                                                <div className="tool-call-body animate-fade-in-up">
                                                    {tc.input && (
                                                        <div className="mb-2.5">
                                                            <div className="text-[10px] uppercase tracking-wider text-muted-foreground/50 font-semibold mb-1">输入</div>
                                                            <ToolInputDisplay toolName={tc.tool} input={tc.input} />
                                                        </div>
                                                    )}
                                                    {tc.output ? (
                                                        <div>
                                                            <div className="text-[10px] uppercase tracking-wider text-muted-foreground/50 font-semibold mb-1">输出</div>
                                                            <ToolOutputDisplay toolName={tc.tool} output={tc.output} />
                                                        </div>
                                                    ) : (
                                                        <div className="flex items-center gap-2 text-xs text-muted-foreground/50">
                                                            <div className="w-3 h-3 border-2 border-amber-500/30 border-t-amber-500 rounded-full animate-spin" />
                                                            执行中...
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    ));
                                })()}
                            </div>
                        )}
                        {/* Thinking indicator - show when all tools are complete but no content yet */}
                        {(() => {
                            const allToolsComplete = thinkingSteps.length > 0 &&
                                thinkingSteps.filter(s => s.type === "tool_start").length ===
                                thinkingSteps.filter(s => s.type === "tool_end").length;
                            const lastStep = thinkingSteps[thinkingSteps.length - 1];
                            const isThinking = allToolsComplete && !streamingContent;

                            if (isThinking && lastStep?.type === "tool_end") {
                                return (
                                    <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground animate-fade-in-up">
                                        <div className="flex items-center gap-1">
                                            <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse-soft" style={{ animationDelay: "0ms" }} />
                                            <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse-soft" style={{ animationDelay: "150ms" }} />
                                            <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse-soft" style={{ animationDelay: "300ms" }} />
                                        </div>
                                        <span>正在分析结果，思考下一步...</span>
                                    </div>
                                );
                            }
                            return null;
                        })()}
                        {streamingContent && (
                            <div className="chat-message-content text-sm">
                                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownCodeComponents}>
                                    {streamingContent}
                                </ReactMarkdown>
                                <span className="inline-block w-2 h-4 bg-primary/60 ml-0.5 animate-pulse-soft rounded-sm" />
                            </div>
                        )}
                        {!streamingContent && thinkingSteps.length === 0 && (
                            <div className="flex items-center gap-2 text-muted-foreground">
                                <div className="flex items-center gap-1">
                                    <div className="w-2 h-2 rounded-full bg-primary/40 animate-pulse-soft" style={{ animationDelay: "0ms" }} />
                                    <div className="w-2 h-2 rounded-full bg-primary/40 animate-pulse-soft" style={{ animationDelay: "200ms" }} />
                                    <div className="w-2 h-2 rounded-full bg-primary/40 animate-pulse-soft" style={{ animationDelay: "400ms" }} />
                                </div>
                                <span className="text-xs">正在思考...</span>
                            </div>
                        )}
                    </div>
                )}

                <div ref={messagesEndRef} />
            </div>

            {/* Input Area */}
            <div className="border-t border-border/50 px-4 py-3">
                <div className="flex items-end gap-2 glass rounded-2xl px-4 py-2">
                    <textarea
                        ref={inputRef}
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="输入消息... (Shift+Enter 换行)"
                        disabled={isStreaming}
                        rows={1}
                        className="flex-1 resize-none bg-transparent border-none outline-none text-sm py-1.5 max-h-32 placeholder:text-muted-foreground/50"
                        style={{ minHeight: "36px" }}
                        onInput={(e) => {
                            const target = e.target as HTMLTextAreaElement;
                            target.style.height = "auto";
                            target.style.height = Math.min(target.scrollHeight, 128) + "px";
                        }}
                    />
                    {isStreaming ? (
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={handleStop}
                            className="rounded-xl hover:bg-destructive/10 hover:text-destructive shrink-0"
                            id="stop-button"
                        >
                            <Square className="w-4 h-4" />
                        </Button>
                    ) : (
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={handleSend}
                            disabled={!inputValue.trim()}
                            className="rounded-xl hover:bg-primary/10 hover:text-primary shrink-0"
                            id="send-button"
                        >
                            <Send className="w-4 h-4" />
                        </Button>
                    )}
                </div>
            </div>

            {/* Security Approval Dialog */}
            <ApprovalDialog
                request={approvalRequest}
                onResolved={() => clearApproval()}
                onAllowForSession={(tool) => addSessionAllowedTool(tool)}
            />
        </div>
    );
}
