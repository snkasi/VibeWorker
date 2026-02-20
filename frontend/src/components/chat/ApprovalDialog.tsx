"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Shield, ShieldAlert, ShieldCheck, ShieldX, Timer, MessageSquare, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { sendApproval } from "@/lib/api";

/** Tool name → Chinese label mapping (mirrors ChatPanel) */
const TOOL_LABELS: Record<string, { label: string; icon: string }> = {
    read_file: { label: "读取文件", icon: "📄" },
    fetch_url: { label: "获取网页", icon: "🌐" },
    python_repl: { label: "执行代码", icon: "🐍" },
    terminal: { label: "执行命令", icon: "💻" },
    search_knowledge_base: { label: "检索知识库", icon: "🔍" },
    memory_write: { label: "存储记忆", icon: "💾" },
    memory_search: { label: "搜索记忆", icon: "🧠" },
};

function getToolDisplay(toolName: string) {
    if (TOOL_LABELS[toolName]) return TOOL_LABELS[toolName];
    if (toolName.startsWith("mcp_")) {
        const parts = toolName.substring(4).split("_");
        const toolPart = parts.length > 1 ? parts.slice(1).join("_") : parts[0];
        return { label: `MCP: ${toolPart}`, icon: "🔌" };
    }
    return { label: toolName, icon: "🔧" };
}

const RISK_STYLES: Record<string, { bg: string; text: string; label: string; Icon: typeof Shield }> = {
    safe: { bg: "bg-green-100 dark:bg-green-900/30", text: "text-green-700 dark:text-green-400", label: "安全", Icon: ShieldCheck },
    warn: { bg: "bg-amber-100 dark:bg-amber-900/30", text: "text-amber-700 dark:text-amber-400", label: "警告", Icon: ShieldAlert },
    dangerous: { bg: "bg-red-100 dark:bg-red-900/30", text: "text-red-700 dark:text-red-400", label: "危险", Icon: ShieldX },
    blocked: { bg: "bg-red-200 dark:bg-red-900/50", text: "text-red-800 dark:text-red-300", label: "禁止", Icon: ShieldX },
};

export interface ApprovalRequestData {
    request_id: string;
    tool: string;
    input: string;
    risk_level: string;
}

interface ApprovalDialogProps {
    request: ApprovalRequestData | null;
    timeout?: number;
    onResolved: () => void;
    onAllowForSession?: (tool: string) => void;
}

export default function ApprovalDialog({
    request,
    timeout = 60,
    onResolved,
    onAllowForSession,
}: ApprovalDialogProps) {
    const [remaining, setRemaining] = useState(timeout);
    const [sending, setSending] = useState(false);
    // 用户反馈/指示（可选）
    const [feedback, setFeedback] = useState("");
    const [showFeedback, setShowFeedback] = useState(false);

    // Reset timer and feedback when new request comes in
    useEffect(() => {
        if (!request) return;
        setRemaining(timeout);
        setFeedback("");
        setShowFeedback(false);
        const interval = setInterval(() => {
            setRemaining((prev) => {
                if (prev <= 1) {
                    clearInterval(interval);
                    // Auto-deny on timeout
                    handleDecision(false);
                    return 0;
                }
                return prev - 1;
            });
        }, 1000);
        return () => clearInterval(interval);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [request?.request_id]);

    const handleDecision = useCallback(
        async (approved: boolean, allowForSession = false) => {
            if (!request || sending) return;
            setSending(true);
            try {
                // 只在批准时发送 feedback
                const userFeedback = approved && feedback.trim() ? feedback.trim() : undefined;
                await sendApproval(request.request_id, approved, userFeedback);
                // If user chose "allow for session", add tool to allowed list
                if (approved && allowForSession && onAllowForSession) {
                    onAllowForSession(request.tool);
                }
            } catch (err) {
                // 审批可能已超时/自动处理，降级为 warn 避免 Next.js Error Overlay
                console.warn("Failed to send approval (may have expired):", err);
            } finally {
                setSending(false);
                onResolved();
            }
        },
        [request, sending, onResolved, onAllowForSession, feedback]
    );

    if (!request) return null;

    const toolDisplay = getToolDisplay(request.tool);
    const riskStyle = RISK_STYLES[request.risk_level] || RISK_STYLES.warn;
    const RiskIcon = riskStyle.Icon;
    const timerPercent = (remaining / timeout) * 100;

    return (
        <Dialog open={!!request} onOpenChange={() => {}}>
            <DialogContent className="sm:max-w-[480px]" onPointerDownOutside={(e) => e.preventDefault()}>
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Shield className="w-4 h-4" />
                        工具执行审批
                    </DialogTitle>
                    <DialogDescription>
                        Agent 请求执行以下操作，请确认是否允许。
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-3 py-2">
                    {/* Tool name + Risk badge */}
                    <div className="flex items-center gap-2">
                        <span className="text-lg">{toolDisplay.icon}</span>
                        <span className="font-medium text-sm">{toolDisplay.label}</span>
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${riskStyle.bg} ${riskStyle.text}`}>
                            <RiskIcon className="w-3 h-3" />
                            {riskStyle.label}
                        </span>
                    </div>

                    {/* Tool input display */}
                    <div className="rounded-lg border border-border bg-muted/50 p-3 max-h-48 overflow-y-auto">
                        <pre className="text-xs font-mono whitespace-pre-wrap break-all text-foreground/80">
                            {request.input}
                        </pre>
                    </div>

                    {/* Timer bar */}
                    <div className="space-y-1">
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                            <div className="flex items-center gap-1">
                                <Timer className="w-3 h-3" />
                                <span>自动拒绝倒计时</span>
                            </div>
                            <span className={remaining <= 10 ? "text-red-500 font-semibold" : ""}>
                                {remaining}s
                            </span>
                        </div>
                        <div className="h-1.5 rounded-full bg-border overflow-hidden">
                            <div
                                className={`h-full rounded-full transition-all duration-1000 ${
                                    remaining <= 10 ? "bg-red-500" : remaining <= 20 ? "bg-amber-500" : "bg-primary"
                                }`}
                                style={{ width: `${timerPercent}%` }}
                            />
                        </div>
                    </div>

                    {/* 可选的用户反馈/指示 */}
                    <div className="border-t border-border/50 pt-3">
                        <button
                            type="button"
                            onClick={() => setShowFeedback(!showFeedback)}
                            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                        >
                            {showFeedback ? (
                                <ChevronDown className="w-3 h-3" />
                            ) : (
                                <ChevronRight className="w-3 h-3" />
                            )}
                            <MessageSquare className="w-3 h-3" />
                            <span>添加指示（可选）</span>
                        </button>
                        {showFeedback && (
                            <div className="mt-2 animate-in slide-in-from-top-2 duration-200">
                                <textarea
                                    value={feedback}
                                    onChange={(e) => setFeedback(e.target.value)}
                                    placeholder="输入给 AI 的指示，例如：&#10;• 执行后只显示前 10 条结果&#10;• 如果出错，不要重试&#10;• 用中文总结输出内容"
                                    className="w-full h-20 px-3 py-2 text-xs rounded-lg border border-border bg-background resize-none focus:outline-none focus:ring-2 focus:ring-primary/20 placeholder:text-muted-foreground/50"
                                />
                                <p className="mt-1 text-[10px] text-muted-foreground/60">
                                    这些指示会在工具执行后注入，AI 将在后续处理时遵循
                                </p>
                            </div>
                        )}
                    </div>
                </div>

                <DialogFooter className="flex-col sm:flex-row gap-2 sm:gap-2">
                    <Button
                        variant="ghost"
                        onClick={() => handleDecision(true, true)}
                        disabled={sending}
                        className="sm:mr-auto text-muted-foreground hover:text-foreground"
                    >
                        <ShieldCheck className="w-4 h-4 mr-1.5" />
                        本次会话均允许
                    </Button>
                    <Button
                        variant="outline"
                        onClick={() => handleDecision(false)}
                        disabled={sending}
                        className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/30"
                    >
                        <ShieldX className="w-4 h-4 mr-1.5" />
                        拒绝
                    </Button>
                    <Button
                        onClick={() => handleDecision(true)}
                        disabled={sending}
                        className="bg-green-600 hover:bg-green-700 text-white"
                    >
                        <ShieldCheck className="w-4 h-4 mr-1.5" />
                        允许
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
