"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
    Search,
    Plus,
    Trash2,
    ChevronRight,
    Calendar,
    FileText,
    X,
    Loader2,
    RefreshCw,
    BarChart3,
    User,
    Bot,
    Wrench,
    Zap,
    ChevronDown,
    Brain,
    Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import {
    fetchMemoryEntries,
    deleteMemoryEntry,
    fetchDailyLogs,
    deleteDailyLog,
    searchMemory,
    fetchMemoryStats,
    fetchRollingSummary,
    reindexMemory,
    fetchDailyLogEntries,
    deleteDailyLogEntry,
    compressMemory,
    type MemoryEntry,
    type MemoryStats,
    type MemorySearchResult,
    type DailyLog,
    type DailyLogEntry,
} from "@/lib/api";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
    Dialog,
    DialogContent,
} from "@/components/ui/dialog";
import AddMemoryDialog from "./AddMemoryDialog";

type MemoryTab = "short-term" | "long-term" | "persona";

// 前端筛选分类：将 reflections + procedural 合并为"经验"
const CATEGORY_OPTIONS = [
    { value: "", label: "全部" },
    { value: "preferences", label: "偏好" },
    { value: "facts", label: "事实" },
    { value: "tasks", label: "任务" },
    { value: "experience", label: "经验" },
    { value: "general", label: "通用" },
];

// 后端分类到前端显示标签的映射
const CATEGORY_LABELS: Record<string, string> = {
    preferences: "偏好",
    facts: "事实",
    tasks: "任务",
    reflections: "经验",
    procedural: "经验",
    general: "通用",
};

// 来源标识图标和标签
const SOURCE_CONFIG: Record<string, { icon: typeof User; label: string; color: string }> = {
    user_explicit: { icon: User, label: "手动", color: "text-blue-500" },
    session_reflect: { icon: Bot, label: "反思", color: "text-green-500" },
    auto_extract: { icon: Bot, label: "提取", color: "text-green-500" },
    auto_reflection: { icon: Wrench, label: "反思", color: "text-orange-500" },
    user_correction: { icon: Zap, label: "纠正", color: "text-red-500" },
    api: { icon: Zap, label: "API", color: "text-purple-500" },
    migration: { icon: RefreshCw, label: "迁移", color: "text-muted-foreground" },
};

// 人格文件列表
const WORKSPACE_FILES = [
    { name: "SOUL.md", path: "workspace/SOUL.md", icon: "💫" },
    { name: "IDENTITY.md", path: "workspace/IDENTITY.md", icon: "🪪" },
    { name: "USER.md", path: "workspace/USER.md", icon: "👤" },
    { name: "AGENTS.md", path: "workspace/AGENTS.md", icon: "📋" },
];

interface MemoryPanelProps {
    onFileOpen?: (path: string) => void;
    onMemoryEntryOpen?: (entry: MemoryEntry) => void;
    onDailyLogEntryOpen?: (date: string, entry: DailyLogEntry) => void;
    refreshKey?: number;
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    return `${(bytes / 1024).toFixed(1)}KB`;
}

// 重要性的颜色映射
function salienceColor(salience: number): string {
    if (salience >= 0.9) return "bg-red-500";
    if (salience >= 0.8) return "bg-amber-500";
    if (salience >= 0.5) return "bg-blue-500";
    return "bg-muted-foreground/30";
}

function SourceBadge({ source }: { source?: string }) {
    const config = SOURCE_CONFIG[source || ""] || SOURCE_CONFIG.api;
    const Icon = config.icon;
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span className={`shrink-0 ${config.color}`}>
                    <Icon className="w-2.5 h-2.5" />
                </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-[10px]">
                来源: {config.label}
            </TooltipContent>
        </Tooltip>
    );
}

// 日志条目类型标签
const LOG_TYPE_LABELS: Record<string, string> = {
    event: "事件",
    auto_extract: "提取",
    reflection: "日记",
};

export default function MemoryPanel({
    onFileOpen,
    onMemoryEntryOpen,
    onDailyLogEntryOpen,
    refreshKey,
}: MemoryPanelProps) {
    const [activeTab, setActiveTab] = useState<MemoryTab>("long-term");
    const [entries, setEntries] = useState<MemoryEntry[]>([]);
    const [dailyLogs, setDailyLogs] = useState<DailyLog[]>([]);
    const [categoryFilter, setCategoryFilter] = useState("");
    const [searchQuery, setSearchQuery] = useState("");
    const [searchResults, setSearchResults] = useState<MemorySearchResult[] | null>(null);
    const [isSearching, setIsSearching] = useState(false);
    const [isLoading, setIsLoading] = useState(false);

    // 统计和摘要
    const [stats, setStats] = useState<MemoryStats | null>(null);
    const [rollingSummary, setRollingSummary] = useState("");
    const [showSummary, setShowSummary] = useState(false);

    // 添加记忆弹窗
    const [showAddDialog, setShowAddDialog] = useState(false);

    // 操作状态
    const [isReindexing, setIsReindexing] = useState(false);

    // 压缩记忆状态
    const [isCompressing, setIsCompressing] = useState(false);
    const [showCompressConfirm, setShowCompressConfirm] = useState(false);
    const [compressResult, setCompressResult] = useState<{
        before: number;
        after: number;
        merged: number;
    } | null>(null);

    // 短期记忆：展开的日期和条目
    const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set());
    const [dateEntries, setDateEntries] = useState<Record<string, DailyLogEntry[]>>({});
    const [loadingDates, setLoadingDates] = useState<Set<string>>(new Set());

    // 短期记忆搜索
    const [shortSearchQuery, setShortSearchQuery] = useState("");
    const [shortSearchResults, setShortSearchResults] = useState<MemorySearchResult[] | null>(null);
    const [isShortSearching, setIsShortSearching] = useState(false);

    // 前端筛选逻辑：将"经验"映射为 reflections + procedural
    const getFilteredEntries = useCallback(() => {
        if (categoryFilter === "experience") {
            return entries.filter(
                (e) => e.category === "reflections" || e.category === "procedural"
            );
        }
        if (categoryFilter) {
            return entries.filter((e) => e.category === categoryFilter);
        }
        return entries;
    }, [entries, categoryFilter]);

    // 获取合并后的分类计数（经验 = reflections + procedural）
    const getExperienceCount = useCallback(() => {
        if (!stats) return 0;
        return (stats.category_counts["reflections"] || 0) + (stats.category_counts["procedural"] || 0);
    }, [stats]);

    const loadEntries = useCallback(async () => {
        setIsLoading(true);
        try {
            const data = await fetchMemoryEntries();
            setEntries(data.entries);
        } catch {
            // 后端可能未运行
        } finally {
            setIsLoading(false);
        }
    }, []);

    const loadStats = useCallback(async () => {
        try {
            const [s, summary] = await Promise.all([
                fetchMemoryStats(),
                fetchRollingSummary(),
            ]);
            setStats(s);
            setRollingSummary(summary);
        } catch {
            // 后端可能未运行
        }
    }, []);

    const loadDailyLogs = useCallback(async () => {
        try {
            const logs = await fetchDailyLogs();
            setDailyLogs(logs);
        } catch {
            // 后端可能未运行
        }
    }, []);

    // 加载长期记忆
    useEffect(() => {
        if (activeTab === "long-term") {
            loadEntries();
            loadStats();
        }
    }, [activeTab, loadEntries, loadStats]);

    // 加载短期记忆（日志列表）
    useEffect(() => {
        if (activeTab === "short-term") {
            loadDailyLogs();
        }
    }, [activeTab, loadDailyLogs]);

    // refreshKey 变化时重新加载
    useEffect(() => {
        if (refreshKey === undefined) return;
        if (activeTab === "long-term") {
            loadEntries();
            loadStats();
        } else if (activeTab === "short-term") {
            loadDailyLogs();
            // 重新加载已展开日期的条目
            expandedDates.forEach((date) => {
                loadDateEntries(date);
            });
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [refreshKey]);

    const loadDateEntries = async (date: string) => {
        setLoadingDates((prev) => new Set(prev).add(date));
        try {
            const entries = await fetchDailyLogEntries(date);
            setDateEntries((prev) => ({ ...prev, [date]: entries }));
        } catch {
            setDateEntries((prev) => ({ ...prev, [date]: [] }));
        } finally {
            setLoadingDates((prev) => {
                const next = new Set(prev);
                next.delete(date);
                return next;
            });
        }
    };

    const toggleDateExpand = (date: string) => {
        setExpandedDates((prev) => {
            const next = new Set(prev);
            if (next.has(date)) {
                next.delete(date);
            } else {
                next.add(date);
                // 首次展开时加载条目
                if (!dateEntries[date]) {
                    loadDateEntries(date);
                }
            }
            return next;
        });
    };

    const handleSearch = async () => {
        if (!searchQuery.trim()) return;
        setIsSearching(true);
        setSearchResults(null);
        try {
            // 长期记忆搜索只检索 long_term 类型
            const { results } = await searchMemory(searchQuery, 5, true, undefined, "long_term");
            setSearchResults(results);
        } catch {
            setSearchResults([]);
        } finally {
            setIsSearching(false);
        }
    };

    const handleShortSearch = async () => {
        if (!shortSearchQuery.trim()) return;
        setIsShortSearching(true);
        setShortSearchResults(null);
        try {
            const { results } = await searchMemory(shortSearchQuery, 10, false, undefined, "daily_log");
            setShortSearchResults(results);
        } catch {
            setShortSearchResults([]);
        } finally {
            setIsShortSearching(false);
        }
    };

    // 点击短期记忆搜索结果：从 source 提取日期，加载条目，按内容匹配后打开编辑器
    const handleShortSearchResultClick = async (result: MemorySearchResult) => {
        // source 格式: "logs/2026-02-22.json"
        const dateMatch = result.source?.match(/(\d{4}-\d{2}-\d{2})/);
        if (!dateMatch) return;
        const date = dateMatch[1];

        // 优先从已缓存的条目中查找，否则请求加载
        let entries = dateEntries[date];
        if (!entries) {
            try {
                entries = await fetchDailyLogEntries(date);
                setDateEntries((prev) => ({ ...prev, [date]: entries }));
            } catch {
                return;
            }
        }

        // 按内容匹配（搜索结果可能被截断到 300 字符，用 startsWith 匹配）
        const matched = entries.find(
            (e) => e.content === result.content || result.content.startsWith(e.content.slice(0, 280))
        );
        if (matched) {
            onDailyLogEntryOpen?.(date, matched);
        }
    };

    const handleDeleteEntry = async (e: React.MouseEvent, entryId: string) => {
        e.stopPropagation();
        if (!confirm("确定要删除这条记忆吗？")) return;
        try {
            await deleteMemoryEntry(entryId);
            await loadEntries();
            await loadStats();
        } catch {
            // 忽略
        }
    };

    const handleDeleteDailyLog = async (e: React.MouseEvent, date: string) => {
        e.stopPropagation();
        if (!confirm(`确定要删除 ${date} 的所有日志吗？`)) return;
        try {
            await deleteDailyLog(date);
            setExpandedDates((prev) => {
                const next = new Set(prev);
                next.delete(date);
                return next;
            });
            await loadDailyLogs();
        } catch {
            // 忽略
        }
    };

    const handleDeleteLogEntry = async (e: React.MouseEvent, date: string, index: number) => {
        e.stopPropagation();
        if (!confirm("确定要删除这条日志吗？")) return;
        try {
            await deleteDailyLogEntry(date, index);
            await loadDateEntries(date);
            await loadDailyLogs();
        } catch {
            // 忽略
        }
    };

    const handleReindex = async () => {
        setIsReindexing(true);
        try {
            await reindexMemory();
        } catch {
            // 忽略
        } finally {
            setIsReindexing(false);
        }
    };

    const handleCompress = async () => {
        setShowCompressConfirm(false);
        setIsCompressing(true);
        setCompressResult(null);
        try {
            const result = await compressMemory();
            // 刷新列表和统计
            await loadEntries();
            await loadStats();
            // 保存结果用于显示
            if (result.status === "ok") {
                setCompressResult({
                    before: result.before,
                    after: result.after,
                    merged: result.merged,
                });
            }
        } catch (err) {
            // 失败时也设置一个特殊状态
            console.error("压缩失败:", err);
        } finally {
            setIsCompressing(false);
        }
    };

    const handleAddMemoryDone = async () => {
        await loadEntries();
        await loadStats();
    };

    const filteredEntries = getFilteredEntries();

    return (
        <div className="flex flex-col h-full">
            {/* Tab Bar — 3 Tab: 短期记忆 / 长期记忆 / 人格基础 */}
            <div className="flex items-center gap-1 px-2 pt-1 pb-1">
                {(
                    [
                        { id: "short-term" as const, label: "短期记忆" },
                        { id: "long-term" as const, label: "长期记忆" },
                        { id: "persona" as const, label: "人格基础" },
                    ]
                ).map((tab) => (
                    <button
                        key={tab.id}
                        onClick={() => {
                            setActiveTab(tab.id);
                            setSearchResults(null);
                            setShortSearchResults(null);
                        }}
                        className={`flex-1 px-2 py-1.5 text-xs rounded-lg transition-all ${
                            activeTab === tab.id
                                ? "bg-primary/10 text-primary font-medium"
                                : "text-muted-foreground hover:bg-accent"
                        }`}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>

            {/* 搜索栏（短期记忆 Tab） */}
            {activeTab === "short-term" && (
                <div className="px-2 py-1.5">
                    <div className="relative">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/50" />
                        <input
                            type="text"
                            placeholder="搜索日记..."
                            value={shortSearchQuery}
                            onChange={(e) => setShortSearchQuery(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") handleShortSearch();
                            }}
                            className="w-full h-7 pl-8 pr-8 text-xs rounded-lg border border-border/50 bg-background focus:outline-none focus:ring-1 focus:ring-primary/30 transition-all"
                        />
                        {shortSearchQuery && (
                            <button
                                onClick={() => {
                                    setShortSearchQuery("");
                                    setShortSearchResults(null);
                                }}
                                className="absolute right-2 top-1/2 -translate-y-1/2"
                            >
                                <X className="w-3 h-3 text-muted-foreground/50 hover:text-muted-foreground" />
                            </button>
                        )}
                    </div>
                    {isShortSearching && (
                        <div className="flex items-center gap-1.5 mt-1.5 px-1">
                            <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
                            <span className="text-[10px] text-muted-foreground">搜索中...</span>
                        </div>
                    )}
                </div>
            )}

            {/* 短期记忆搜索结果 */}
            {shortSearchResults !== null && activeTab === "short-term" && (
                <div className="px-2 pb-2">
                    <div className="p-2 rounded-lg bg-primary/5 border border-primary/10">
                        <div className="flex items-center justify-between mb-1.5">
                            <span className="text-[10px] font-medium text-primary">
                                {shortSearchResults.length > 0
                                    ? `${shortSearchResults.length} 条结果`
                                    : "无结果"}
                            </span>
                            <button onClick={() => setShortSearchResults(null)}>
                                <X className="w-3 h-3 text-muted-foreground/50 hover:text-muted-foreground" />
                            </button>
                        </div>
                        <div className="space-y-1.5 max-h-48 overflow-y-auto">
                            {shortSearchResults.length === 0 && (
                                <p className="text-[10px] text-muted-foreground">
                                    未找到与 &quot;{shortSearchQuery}&quot; 相关的日记
                                </p>
                            )}
                            {shortSearchResults.map((r, i) => (
                                <button
                                    key={i}
                                    className="w-full text-left p-1.5 rounded-md bg-background/50 hover:bg-accent/50 transition-all cursor-pointer"
                                    onClick={() => handleShortSearchResultClick(r)}
                                >
                                    <p className="text-[10px] text-foreground/80 leading-relaxed break-words">
                                        {r.content}
                                    </p>
                                    <span className="text-[9px] text-muted-foreground/40">
                                        {r.source?.replace("logs/", "").replace(".json", "")}
                                    </span>
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {/* 搜索栏（长期记忆 Tab） */}
            {activeTab === "long-term" && (
                <div className="px-2 py-1.5">
                    <div className="relative">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/50" />
                        <input
                            type="text"
                            placeholder="搜索记忆..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") handleSearch();
                            }}
                            className="w-full h-7 pl-8 pr-8 text-xs rounded-lg border border-border/50 bg-background focus:outline-none focus:ring-1 focus:ring-primary/30 transition-all"
                        />
                        {searchQuery && (
                            <button
                                onClick={() => {
                                    setSearchQuery("");
                                    setSearchResults(null);
                                }}
                                className="absolute right-2 top-1/2 -translate-y-1/2"
                            >
                                <X className="w-3 h-3 text-muted-foreground/50 hover:text-muted-foreground" />
                            </button>
                        )}
                    </div>
                    {isSearching && (
                        <div className="flex items-center gap-1.5 mt-1.5 px-1">
                            <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
                            <span className="text-[10px] text-muted-foreground">搜索中...</span>
                        </div>
                    )}
                </div>
            )}

            {/* 搜索结果 */}
            {searchResults !== null && (
                <div className="px-2 pb-2">
                    <div className="p-2 rounded-lg bg-primary/5 border border-primary/10">
                        <div className="flex items-center justify-between mb-1.5">
                            <span className="text-[10px] font-medium text-primary">
                                {searchResults.length > 0
                                    ? `${searchResults.length} 条结果`
                                    : "无结果"}
                            </span>
                            <button onClick={() => setSearchResults(null)}>
                                <X className="w-3 h-3 text-muted-foreground/50 hover:text-muted-foreground" />
                            </button>
                        </div>
                        <div className="space-y-1.5 max-h-48 overflow-y-auto">
                            {searchResults.length === 0 && (
                                <p className="text-[10px] text-muted-foreground">
                                    未找到与 &quot;{searchQuery}&quot; 相关的记忆
                                </p>
                            )}
                            {searchResults.map((r, i) => {
                                // 通过 id 匹配已加载的条目，支持点击打开编辑
                                const matchedEntry = r.id
                                    ? entries.find((e) => e.entry_id === r.id)
                                    : undefined;
                                return (
                                    <button
                                        key={i}
                                        className="w-full text-left p-1.5 rounded-md bg-background/50 hover:bg-accent/50 transition-all cursor-pointer"
                                        onClick={() => {
                                            if (matchedEntry) {
                                                onMemoryEntryOpen?.(matchedEntry);
                                            }
                                        }}
                                    >
                                        <div className="flex items-center gap-1.5 mb-0.5">
                                            {r.category && (
                                                <span className="text-[9px] px-1 py-px rounded bg-primary/10 text-primary/70">
                                                    {CATEGORY_LABELS[r.category] || r.category}
                                                </span>
                                            )}
                                            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${salienceColor(r.salience ?? 0.5)}`} />
                                            <span className="text-[9px] text-muted-foreground/50 ml-auto">
                                                {(r.score * 100).toFixed(0)}%
                                            </span>
                                        </div>
                                        <p className="text-[10px] text-foreground/80 leading-relaxed break-words">
                                            {r.content}
                                        </p>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </div>
            )}

            {/* 内容区 */}
            <ScrollArea className="flex-1 overflow-hidden">
                <div className="p-2 space-y-1 w-full overflow-hidden">

                    {/* ============================================
                        短期记忆 Tab — 日志条目
                        ============================================ */}
                    {activeTab === "short-term" && (
                        <>
                            {dailyLogs.length === 0 && (
                                <div className="px-3 py-8 text-center">
                                    <Calendar className="w-8 h-8 mx-auto mb-2 text-muted-foreground/30" />
                                    <p className="text-xs text-muted-foreground">暂无近期日志</p>
                                    <p className="text-xs text-muted-foreground/60 mt-1">
                                        对话过程中会自动记录
                                    </p>
                                </div>
                            )}
                            {dailyLogs.map((log) => {
                                const isExpanded = expandedDates.has(log.date);
                                const isLoadingEntries = loadingDates.has(log.date);
                                const logEntries = dateEntries[log.date];

                                return (
                                    <div key={log.date} className="rounded-lg overflow-hidden">
                                        {/* 日期行 */}
                                        <button
                                            className="w-full text-left px-3 py-2 text-xs hover:bg-accent/50 transition-all flex items-center gap-2 group"
                                            onClick={() => toggleDateExpand(log.date)}
                                        >
                                            <ChevronDown
                                                className={`w-3 h-3 text-muted-foreground/50 transition-transform shrink-0 ${
                                                    isExpanded ? "rotate-0" : "-rotate-90"
                                                }`}
                                            />
                                            <Calendar className="w-3 h-3 text-primary/50 shrink-0" />
                                            <span className="font-mono text-foreground/70">{log.date}</span>
                                            <span className="text-muted-foreground/40 ml-auto">
                                                {formatSize(log.size)}
                                            </span>
                                            <Trash2
                                                className="w-3 h-3 opacity-0 group-hover:opacity-40 hover:!opacity-100 hover:text-destructive shrink-0 transition-opacity cursor-pointer"
                                                onClick={(e) => handleDeleteDailyLog(e, log.date)}
                                            />
                                        </button>

                                        {/* 展开的条目列表 */}
                                        {isExpanded && (
                                            <div className="pl-4 pr-2 pb-1">
                                                {isLoadingEntries && (
                                                    <div className="flex items-center gap-1.5 py-2 px-2">
                                                        <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
                                                        <span className="text-[10px] text-muted-foreground">加载中...</span>
                                                    </div>
                                                )}
                                                {!isLoadingEntries && logEntries && logEntries.length === 0 && (
                                                    <p className="text-[10px] text-muted-foreground/50 py-2 px-2">
                                                        暂无条目
                                                    </p>
                                                )}
                                                {logEntries?.map((entry) => (
                                                    <button
                                                        key={entry.index}
                                                        className="w-full text-left px-2 py-1.5 rounded-md text-[10px] hover:bg-accent/50 transition-all flex items-start gap-1.5 group/entry"
                                                        onClick={() => onDailyLogEntryOpen?.(log.date, entry)}
                                                    >
                                                        <span className="text-muted-foreground/40 font-mono shrink-0 mt-px">
                                                            {entry.time?.slice(0, 5)}
                                                        </span>
                                                        <span className="flex-1 text-foreground/70 leading-relaxed break-words line-clamp-2">
                                                            {entry.content}
                                                        </span>
                                                        <Trash2
                                                            className="w-3 h-3 opacity-0 group-hover/entry:opacity-40 hover:!opacity-100 hover:text-destructive shrink-0 mt-0.5 transition-opacity cursor-pointer"
                                                            onClick={(e) => handleDeleteLogEntry(e, log.date, entry.index)}
                                                        />
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </>
                    )}

                    {/* ============================================
                        长期记忆 Tab — 记忆条目
                        ============================================ */}
                    {activeTab === "long-term" && (
                        <>
                            {/* Rolling Summary */}
                            {rollingSummary && (
                                <button
                                    onClick={() => setShowSummary(!showSummary)}
                                    className="w-full mx-1 mb-1 p-2 rounded-lg bg-accent/30 border border-border/30 text-left transition-all hover:bg-accent/50"
                                >
                                    <div className="flex items-center gap-1.5">
                                        <BarChart3 className="w-3 h-3 text-primary/60 shrink-0" />
                                        <span className="text-[10px] font-medium text-primary/70">概要</span>
                                        <ChevronDown className={`w-3 h-3 text-muted-foreground/50 ml-auto transition-transform ${showSummary ? "rotate-180" : ""}`} />
                                    </div>
                                    {showSummary && (
                                        <p className="text-[10px] text-foreground/70 mt-1.5 leading-relaxed break-words">
                                            {rollingSummary}
                                        </p>
                                    )}
                                </button>
                            )}

                            {/* Category Filter + Actions */}
                            <div className="flex flex-wrap gap-1 px-1 pb-1.5">
                                {CATEGORY_OPTIONS.map((opt) => {
                                    let count = 0;
                                    if (stats && opt.value) {
                                        if (opt.value === "experience") {
                                            count = getExperienceCount();
                                        } else {
                                            count = stats.category_counts[opt.value] || 0;
                                        }
                                    }
                                    return (
                                        <button
                                            key={opt.value}
                                            onClick={() => setCategoryFilter(opt.value)}
                                            className={`px-2 py-0.5 text-[10px] rounded-full transition-all ${
                                                categoryFilter === opt.value
                                                    ? "bg-primary/15 text-primary font-medium"
                                                    : "bg-accent/50 text-muted-foreground hover:bg-accent"
                                            }`}
                                        >
                                            {opt.label}
                                            {count > 0 && (
                                                <span className="ml-0.5 text-muted-foreground/50">
                                                    {count}
                                                </span>
                                            )}
                                        </button>
                                    );
                                })}
                                <div className="flex items-center gap-0.5 ml-auto">
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <button
                                                onClick={handleReindex}
                                                disabled={isReindexing}
                                                className="px-1 py-0.5 text-[10px] rounded-full bg-accent/50 text-muted-foreground hover:bg-accent transition-all disabled:opacity-50"
                                            >
                                                <RefreshCw className={`w-3 h-3 ${isReindexing ? "animate-spin" : ""}`} />
                                            </button>
                                        </TooltipTrigger>
                                        <TooltipContent>重建索引</TooltipContent>
                                    </Tooltip>
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <button
                                                onClick={() => setShowCompressConfirm(true)}
                                                disabled={isCompressing || (stats?.total_entries || 0) < 2}
                                                className="px-1 py-0.5 text-[10px] rounded-full bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 transition-all disabled:opacity-50"
                                            >
                                                <Sparkles className={`w-3 h-3 ${isCompressing ? "animate-pulse" : ""}`} />
                                            </button>
                                        </TooltipTrigger>
                                        <TooltipContent>整理记忆</TooltipContent>
                                    </Tooltip>
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <button
                                                onClick={() => setShowAddDialog(true)}
                                                className="px-1.5 py-0.5 text-[10px] rounded-full bg-primary/10 text-primary hover:bg-primary/20 transition-all"
                                            >
                                                <Plus className="w-3 h-3" />
                                            </button>
                                        </TooltipTrigger>
                                        <TooltipContent>添加记忆</TooltipContent>
                                    </Tooltip>
                                </div>
                            </div>

                            {/* Entries List */}
                            {isLoading && entries.length === 0 && (
                                <div className="flex items-center justify-center py-6">
                                    <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                                </div>
                            )}
                            {!isLoading && filteredEntries.length === 0 && (
                                <div className="px-3 py-8 text-center">
                                    <Brain className="w-8 h-8 mx-auto mb-2 text-muted-foreground/30" />
                                    <p className="text-xs text-muted-foreground">暂无持久记忆</p>
                                    <p className="text-xs text-muted-foreground/60 mt-1">
                                        对话中会自动积累记忆
                                    </p>
                                </div>
                            )}
                            {filteredEntries.map((entry) => (
                                <button
                                    key={entry.entry_id}
                                    className="w-full text-left px-3 py-2 rounded-xl text-sm hover:bg-accent/50 transition-all group"
                                    onClick={() => onMemoryEntryOpen?.(entry)}
                                >
                                    <div className="flex items-center gap-1.5">
                                        {/* 来源图标 */}
                                        <SourceBadge source={entry.source} />
                                        {/* 重要性圆点 */}
                                        <Tooltip>
                                            <TooltipTrigger asChild>
                                                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${salienceColor(entry.salience ?? 0.5)}`} />
                                            </TooltipTrigger>
                                            <TooltipContent side="top" className="text-[10px]">
                                                重要性: {(entry.salience ?? 0.5).toFixed(1)}
                                            </TooltipContent>
                                        </Tooltip>
                                        {/* 分类标签 */}
                                        <span className="text-[10px] px-1.5 py-px rounded-full bg-primary/10 text-primary/70 shrink-0">
                                            {CATEGORY_LABELS[entry.category] || entry.category}
                                        </span>
                                        {/* 时间戳 */}
                                        <span className="text-[10px] text-muted-foreground/40 ml-auto shrink-0">
                                            {entry.timestamp}
                                        </span>
                                        {/* 访问次数 */}
                                        {entry.access_count && entry.access_count > 1 && (
                                            <span className="text-[9px] text-muted-foreground/30 shrink-0">
                                                x{entry.access_count}
                                            </span>
                                        )}
                                        {/* 删除按钮 */}
                                        <Trash2
                                            className="w-3 h-3 opacity-0 group-hover:opacity-40 hover:!opacity-100 hover:text-destructive shrink-0 transition-opacity cursor-pointer"
                                            onClick={(e) => handleDeleteEntry(e, entry.entry_id)}
                                        />
                                    </div>
                                    <p className="text-xs text-foreground/80 mt-1 break-words leading-relaxed">
                                        {entry.content}
                                    </p>
                                </button>
                            ))}

                            {/* Stats Footer */}
                            {stats && stats.total_entries > 0 && (
                                <div className="px-2 pt-2 pb-1 border-t border-border/30 mt-2">
                                    <div className="flex items-center justify-between text-[9px] text-muted-foreground/40">
                                        <span>{stats.total_entries} 条记忆</span>
                                        <span>v{stats.version || 2}</span>
                                    </div>
                                </div>
                            )}
                        </>
                    )}

                    {/* ============================================
                        人格基础 Tab — 人格文件
                        ============================================ */}
                    {activeTab === "persona" && (
                        <div className="space-y-1">
                            {WORKSPACE_FILES.map((file) => (
                                <button
                                    key={file.path}
                                    className="w-full text-left px-3 py-2.5 rounded-xl text-sm hover:bg-accent transition-all duration-150 flex items-center gap-2 group"
                                    onClick={() => onFileOpen?.(file.path)}
                                >
                                    <span>{file.icon}</span>
                                    <span className="flex-1">{file.name}</span>
                                    <ChevronRight className="w-3.5 h-3.5 opacity-0 group-hover:opacity-40 transition-opacity" />
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </ScrollArea>

            {/* 添加记忆弹窗 */}
            <AddMemoryDialog
                open={showAddDialog}
                onOpenChange={setShowAddDialog}
                onAdded={handleAddMemoryDone}
            />

            {/* 压缩确认弹窗 */}
            <AlertDialog open={showCompressConfirm} onOpenChange={setShowCompressConfirm}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle className="flex items-center gap-2">
                            <Sparkles className="w-4 h-4 text-amber-500" />
                            整理长期记忆
                        </AlertDialogTitle>
                        <AlertDialogDescription asChild>
                            <div className="space-y-2 text-sm text-muted-foreground">
                                <span className="block">此操作将自动整理你的长期记忆：</span>
                                <ul className="list-disc list-inside text-xs space-y-1">
                                    <li>合并相似的记忆条目</li>
                                    <li>去除冗余信息</li>
                                    <li>重新评估记忆的重要性</li>
                                </ul>
                                <span className="block text-xs text-muted-foreground/70 pt-1">
                                    整理前会自动备份，可从 memory.json.pre-compress 恢复。
                                </span>
                            </div>
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>取消</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={handleCompress}
                            className="bg-amber-500 hover:bg-amber-600"
                        >
                            开始整理
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            {/* 压缩进度弹窗 */}
            <Dialog open={isCompressing}>
                <DialogContent className="sm:max-w-md [&>button]:hidden">
                    <div className="flex flex-col items-center py-6 gap-4">
                        <div className="relative">
                            <Sparkles className="w-10 h-10 text-amber-500 animate-pulse" />
                            <Loader2 className="w-5 h-5 animate-spin text-amber-600 absolute -bottom-1 -right-1" />
                        </div>
                        <div className="text-center space-y-1">
                            <p className="text-sm font-medium">正在整理记忆...</p>
                            <p className="text-xs text-muted-foreground">
                                分析相似度、合并内容、重评重要性
                            </p>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>

            {/* 压缩完成提示 */}
            <Dialog open={compressResult !== null} onOpenChange={() => setCompressResult(null)}>
                <DialogContent className="sm:max-w-sm">
                    <div className="flex flex-col items-center py-4 gap-3">
                        <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center">
                            <Sparkles className="w-6 h-6 text-green-600" />
                        </div>
                        <div className="text-center space-y-1">
                            <p className="text-sm font-medium">整理完成</p>
                            {compressResult && (
                                <p className="text-xs text-muted-foreground">
                                    {compressResult.before} 条 → {compressResult.after} 条
                                    {compressResult.merged > 0 && (
                                        <span className="text-amber-600">
                                            {" "}（合并了 {compressResult.merged} 条）
                                        </span>
                                    )}
                                </p>
                            )}
                        </div>
                        <button
                            onClick={() => setCompressResult(null)}
                            className="mt-2 px-4 py-1.5 text-xs rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                        >
                            完成
                        </button>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}
