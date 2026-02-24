"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import { Send, Square, Zap, ChevronRight, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { type ToolCall, type MessageSegment } from "@/lib/api";
import { useSessionState, useSessionActions } from "@/lib/sessionStore";
import type { ThinkingStep } from "@/lib/sessionStore";
import ApprovalDialog from "./ApprovalDialog";
import PlanCard from "./PlanCard";
import Typewriter from "./Typewriter";

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
    isModelConfigured?: boolean;
    onRequestOnboarding?: () => void;
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

/** 判断工具是否支持显示沙箱环境标签（仅 terminal 和 python_repl） */
function showsSandboxTag(toolName: string): boolean {
    return toolName === "terminal" || toolName === "python_repl";
}

/** 渲染沙箱环境标签 */
function SandboxTag({ sandbox }: { sandbox?: "local" | "docker" }) {
    if (sandbox === "docker") {
        return (
            <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 font-medium">
                🐳 Docker
            </span>
        );
    }
    return (
        <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground/60 font-medium">
            💻 本地
        </span>
    );
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

/**
 * 计算 segments 的折叠分割点。
 * 返回最终回答起始的 segment 索引，如果不需要折叠则返回 -1。
 *
 * 规则：从末尾向前找最后一个有内容的 text segment 作为最终回答。
 * 这样在 Plan 模式下（summarizer → agent 生成总结），
 * 中间过程的文本和工具调用都会被折叠，只展示最终总结。
 */
function getFinalAnswerIndex(segments: MessageSegment[]): number {
    // 至少要有一个 tool segment 才需要折叠
    const hasTools = segments.some(s => s.type === "tool");
    if (!hasTools) return -1;
    // 从末尾往前找最后一个有内容的 text segment
    for (let i = segments.length - 1; i >= 0; i--) {
        const seg = segments[i];
        if (seg.type === "text" && seg.content?.trim()) {
            // 确保它前面确实有需要折叠的内容（至少有一个 tool 在它之前）
            const hasToolBefore = segments.slice(0, i).some(s => s.type === "tool");
            if (hasToolBefore) return i;
            break;
        }
    }
    return -1;
}

/** 统计 segments 中工具调用的数量 */
function countToolSegments(segments: MessageSegment[]): number {
    return segments.filter(s => s.type === "tool").length;
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
    isModelConfigured = true,
    onRequestOnboarding,
}: ChatPanelProps) {
    // Store-driven state
    const { messages, isStreaming, streamingContent, streamingSegments, thinkingSteps, approvalRequest, planApprovalRequest, currentPlan, planFadeOut, planStepTimestamps, planStepActivity, streamingPhase } = useSessionState(sessionId);
    const { sendMessage, stopStream, clearApproval, addSessionAllowedTool, approvePlan } = useSessionActions(sessionId);

    // Local UI state
    const [inputValue, setInputValue] = useState("");
    const [expandedTools, setExpandedTools] = useState<Set<number>>(new Set());
    const [expandedStreamingTools, setExpandedStreamingTools] = useState<Set<number>>(new Set());
    // 记录哪些消息的中间过程被展开了（默认折叠）
    const [expandedProcesses, setExpandedProcesses] = useState<Set<number>>(new Set());
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
    }, [messages, streamingContent, streamingSegments]);

    // Auto-focus input when session changes
    useEffect(() => {
        inputRef.current?.focus();
    }, [sessionId]);

    const handleSend = useCallback(() => {
        if (!isModelConfigured && onRequestOnboarding) {
            onRequestOnboarding();
            return;
        }
        const text = inputValue.trim();
        if (!text || isStreaming) return;
        setInputValue("");
        sendMessage(text);
    }, [inputValue, isStreaming, sendMessage, isModelConfigured, onRequestOnboarding]);

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

    // 正在播放收起动画的消息索引
    const [collapsingProcesses, setCollapsingProcesses] = useState<Set<number>>(new Set());
    // 折叠按钮 ref，收起后用于滚动定位
    const processToggleRefs = useRef<Map<number, HTMLDivElement>>(new Map());

    const toggleProcessExpand = (msgIndex: number) => {
        setExpandedProcesses((prev) => {
            const next = new Set(prev);
            if (next.has(msgIndex)) {
                // 收起：先播放动画，动画结束后再真正隐藏
                setCollapsingProcesses((cp) => new Set(cp).add(msgIndex));
                setTimeout(() => {
                    setExpandedProcesses((p) => {
                        const n = new Set(p);
                        n.delete(msgIndex);
                        return n;
                    });
                    setCollapsingProcesses((cp) => {
                        const n = new Set(cp);
                        n.delete(msgIndex);
                        return n;
                    });
                    // 收起后滚动到折叠按钮位置，保持用户视野稳定
                    requestAnimationFrame(() => {
                        processToggleRefs.current.get(msgIndex)?.scrollIntoView({
                            behavior: "smooth",
                            block: "nearest",
                        });
                    });
                }, 250);
            } else {
                next.add(msgIndex);
            }
            return next;
        });
    };

    return (
        <div className="flex flex-col h-full">
            {/* Messages Area */}
            <div className="flex-1 overflow-y-auto px-6 py-4">
                {/* Sticky PlanCard — 执行中悬浮在滚动区域顶部 */}
                {currentPlan && (isStreaming || planFadeOut) && (
                    <div className="sticky top-0 z-10 -mx-6 px-6 pt-2 pb-1 bg-gradient-to-b from-background via-background/95 to-transparent">
                        <PlanCard
                            plan={currentPlan}
                            isLive={isStreaming && !planFadeOut}
                            isFadingOut={planFadeOut}
                            awaitingApproval={!!planApprovalRequest && planApprovalRequest.plan_id === currentPlan.plan_id}
                            onApprove={approvePlan}
                            stepTimestamps={planStepTimestamps}
                            stepActivity={planStepActivity}
                        />
                    </div>
                )}
                {messages.length === 0 && !isStreaming && (
                    <div className="flex flex-col items-center justify-center h-full text-center animate-fade-in-up">
                        <img src="/logo.png" alt="VibeWorker Logo" className="w-16 h-16 mb-4 dark:invert opacity-90" />
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
                            <div
                                className="max-w-[75%] px-4 py-3 rounded-2xl rounded-tr-md bg-[var(--vw-blue)] text-white shadow-sm"
                                onCopy={(e) => {
                                    // 浏览器选中 block 元素时会在首尾附带多余换行，手动清理
                                    const sel = window.getSelection()?.toString();
                                    if (sel) {
                                        e.preventDefault();
                                        e.clipboardData.setData("text/plain", sel.replace(/^\n+|\n+$/g, ""));
                                    }
                                }}
                            >
                                <span className="text-sm whitespace-pre-wrap block">{msg.content}</span>
                            </div>
                        ) : (
                            <div className="max-w-[90%]">
                                {/* Historical Plan Card */}
                                {msg.plan && (
                                    <PlanCard plan={msg.plan} defaultCollapsed />
                                )}
                                {/* 按时间顺序渲染 segments（文本和工具调用穿插显示） */}
                                {msg.segments && msg.segments.length > 0 ? (
                                    (() => {
                                        const finalIdx = getFinalAnswerIndex(msg.segments);
                                        const shouldCollapse = finalIdx > 0;
                                        const isProcessExpanded = expandedProcesses.has(i);
                                        const toolCount = shouldCollapse ? countToolSegments(msg.segments.slice(0, finalIdx)) : 0;

                                        // 渲染单个 segment 的辅助函数
                                        const renderSegment = (seg: MessageSegment, j: number) => {
                                            if (seg.type === "text") {
                                                return seg.content ? (
                                                    <div key={j} className="chat-message-content text-sm">
                                                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownCodeComponents}>
                                                            {seg.content}
                                                        </ReactMarkdown>
                                                    </div>
                                                ) : null;
                                            }
                                            // seg.type === "tool"
                                            const tc = normalizeToolCall(seg as ToolCall);
                                            const segWithSandbox = seg as MessageSegment & { sandbox?: "local" | "docker" };
                                            const expandKey = i * 1000 + j;
                                            return (
                                                <div key={j} className="my-2">
                                                    <div className="tool-call-card">
                                                        <div
                                                            className="tool-call-header"
                                                            onClick={() => toggleToolExpand(expandKey)}
                                                        >
                                                            <div className="w-2 h-2 rounded-full bg-green-500" />
                                                            <span className="text-xs font-medium text-muted-foreground">
                                                                {getToolDisplay(tc.tool).icon} {getToolDisplay(tc.tool).label}
                                                            </span>
                                                            <span className="text-xs text-muted-foreground/60 truncate flex-1 font-mono">
                                                                {getToolInputSummary(tc.tool, tc.input)}
                                                            </span>
                                                            {showsSandboxTag(tc.tool) && tc.output && (
                                                                <SandboxTag sandbox={segWithSandbox.sandbox} />
                                                            )}
                                                            {tc.cached && (
                                                                <span title="使用缓存" className="inline-flex">
                                                                    <Zap className="w-3 h-3 text-muted-foreground/30" />
                                                                </span>
                                                            )}
                                                            <span className="text-xs text-muted-foreground/40">
                                                                {expandedTools.has(expandKey) ? "▼" : "▶"}
                                                            </span>
                                                        </div>
                                                        {expandedTools.has(expandKey) && (
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
                                                </div>
                                            );
                                        };

                                        return shouldCollapse ? (
                                            <>
                                                {/* 中间过程：可折叠区域 */}
                                                <div className="mb-2" ref={(el) => { if (el) processToggleRefs.current.set(i, el); }}>
                                                    <div
                                                        className="flex items-center gap-2 px-3 py-2 rounded-xl border border-border/50 bg-muted/30 cursor-pointer hover:bg-muted/50 transition-colors"
                                                        onClick={() => toggleProcessExpand(i)}
                                                    >
                                                        {isProcessExpanded ? (
                                                            <ChevronDown className="w-3.5 h-3.5 text-muted-foreground/60 shrink-0" />
                                                        ) : (
                                                            <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/60 shrink-0" />
                                                        )}
                                                        <span className="text-xs text-muted-foreground">
                                                            🔄 已经帮您隐藏了 {toolCount} 个过程输出信息
                                                        </span>
                                                    </div>
                                                    {isProcessExpanded && (
                                                        <div className={`mt-1 rounded-xl bg-muted border border-border/60 overflow-hidden ${collapsingProcesses.has(i) ? "animate-collapse-up" : "animate-fade-in-up"}`}>
                                                            <div className="pl-3 pr-2 py-2">
                                                                {msg.segments.slice(0, finalIdx).map((seg, j) => renderSegment(seg, j))}
                                                            </div>
                                                            <div
                                                                className="flex items-center justify-center gap-1.5 px-3 py-1.5 border-t border-border/40 cursor-pointer hover:bg-muted/50 transition-colors"
                                                                onClick={() => toggleProcessExpand(i)}
                                                            >
                                                                <ChevronUp className="w-3 h-3 text-muted-foreground/50" />
                                                                <span className="text-xs text-muted-foreground/60">隐藏过程输出信息</span>
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                                {/* 最终回答：始终展开 */}
                                                {msg.segments.slice(finalIdx).map((seg, j) => renderSegment(seg, finalIdx + j))}
                                            </>
                                        ) : (
                                            /* 不需要折叠：正常渲染所有 segments */
                                            <>
                                                {msg.segments.map((seg, j) => renderSegment(seg, j))}
                                            </>
                                        );
                                    })()
                                ) : (
                                    /* 兼容旧格式：没有 segments 时沿用原逻辑 */
                                    <>
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
                                        {msg.content && (
                                            <div className="chat-message-content text-sm">
                                                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownCodeComponents}>
                                                    {msg.content}
                                                </ReactMarkdown>
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>
                        )}
                    </div>
                ))}

                {/* Streaming response — 按时间顺序穿插显示文本和工具调用 */}
                {isStreaming && (
                    <div className="mb-4 animate-fade-in-up">
                        {/* PlanCard 已移至 sticky 区域 */}
                        {/* 按 segments 时间顺序渲染 */}
                        {streamingSegments.length > 0 && (
                            <>
                                {streamingSegments.map((seg, j) => {
                                    if (seg.type === "text") {
                                        return seg.content ? (
                                            <Typewriter
                                                key={j}
                                                text={seg.content}
                                                speed={15}
                                                isStreaming={isStreaming}
                                            >
                                                {(displayText) => (
                                                    <div className="chat-message-content text-sm">
                                                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownCodeComponents}>
                                                            {displayText}
                                                        </ReactMarkdown>
                                                        {/* 最后一个文本片段时显示光标 */}
                                                        {j === streamingSegments.length - 1 && (
                                                            <span className="inline-block w-2 h-4 bg-primary/60 ml-0.5 animate-pulse-soft rounded-sm" />
                                                        )}
                                                    </div>
                                                )}
                                            </Typewriter>
                                        ) : null;
                                    }
                                    // seg.type === "tool"
                                    const isComplete = !!seg.output;
                                    const streamSegWithSandbox = seg as MessageSegment & { sandbox?: "local" | "docker" };
                                    return (
                                        <div key={j} className="my-2">
                                            <div className="tool-call-card">
                                                <div
                                                    className="tool-call-header cursor-pointer"
                                                    onClick={() => toggleStreamingToolExpand(j)}
                                                >
                                                    <div className={`w-2 h-2 rounded-full ${isComplete ? "bg-green-500" : "bg-amber-500 animate-pulse-soft"}`} />
                                                    <span className="text-xs font-medium text-muted-foreground">
                                                        {getToolDisplay(seg.tool).icon} {getToolDisplay(seg.tool).label}
                                                    </span>
                                                    <span className="text-xs text-muted-foreground/60 truncate flex-1 font-mono">
                                                        {getToolInputSummary(seg.tool, seg.input)}
                                                    </span>
                                                    {showsSandboxTag(seg.tool) && isComplete && (
                                                        <SandboxTag sandbox={streamSegWithSandbox.sandbox} />
                                                    )}
                                                    {seg.cached && (
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
                                                        {seg.input && (
                                                            <div className="mb-2.5">
                                                                <div className="text-[10px] uppercase tracking-wider text-muted-foreground/50 font-semibold mb-1">输入</div>
                                                                <ToolInputDisplay toolName={seg.tool} input={seg.input} />
                                                            </div>
                                                        )}
                                                        {seg.output ? (
                                                            <div>
                                                                <div className="text-[10px] uppercase tracking-wider text-muted-foreground/50 font-semibold mb-1">输出</div>
                                                                <ToolOutputDisplay toolName={seg.tool} output={seg.output} />
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
                                        </div>
                                    );
                                })}
                                {/* 思考指示器：最后一个 segment 是已完成的工具调用且无后续文本时 */}
                                {(() => {
                                    const lastSeg = streamingSegments[streamingSegments.length - 1];
                                    if (lastSeg && lastSeg.type === "tool" && lastSeg.output) {
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
                            </>
                        )}
                        {/* 初始等待指示器 */}
                        {streamingSegments.length === 0 && (
                            <div className="flex items-center gap-2 text-muted-foreground">
                                <div className="flex items-center gap-1">
                                    <div className="w-2 h-2 rounded-full bg-primary/40 animate-pulse-soft" style={{ animationDelay: "0ms" }} />
                                    <div className="w-2 h-2 rounded-full bg-primary/40 animate-pulse-soft" style={{ animationDelay: "200ms" }} />
                                    <div className="w-2 h-2 rounded-full bg-primary/40 animate-pulse-soft" style={{ animationDelay: "400ms" }} />
                                </div>
                                <span className="text-xs">{streamingPhase || "正在思考..."}</span>
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
