"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
    ChevronRight,
    ChevronDown,
    X,
    Trash2,
    Sparkles,
    Globe,
    Bot,
    FileText,
    Languages,
    Wrench,
    Plug,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import {
    fetchCacheStats,
    fetchCacheEntries,
    deleteCacheEntry,
    clearCache,
    cleanupCache,
    type CacheType,
    type CacheStats,
    type CacheEntryPreview,
} from "@/lib/api";

// Known core cache type metadata
const CORE_CACHE_META: Record<string, { label: string; icon: React.ElementType }> = {
    url: { label: "URL 缓存", icon: Globe },
    llm: { label: "LLM 缓存", icon: Bot },
    prompt: { label: "Prompt 缓存", icon: FileText },
    translate: { label: "翻译缓存", icon: Languages },
};

function isMcpCache(id: string): boolean {
    // MCP tool caches: tool_mcp_server_tool or tool_test_mcp_tool etc.
    return id.startsWith("tool_") && id.includes("mcp");
}

function getCacheLabel(id: string): string {
    if (CORE_CACHE_META[id]) return CORE_CACHE_META[id].label;
    if (isMcpCache(id)) {
        const nameNode = id.replace(/^tool_/, "").replace(/^mcp_/, "");
        return `MCP: ${nameNode}`;
    }
    // tool_xxx -> "工具: xxx"
    if (id.startsWith("tool_")) {
        return `工具: ${id.replace("tool_", "").replace(/_/g, " ")}`;
    }
    return id;
}

function getCacheIcon(id: string): React.ElementType {
    if (CORE_CACHE_META[id]) return CORE_CACHE_META[id].icon;
    if (isMcpCache(id)) return Plug;
    return Wrench;
}

function formatBytes(bytes: number): string {
    if (bytes === 0) return "0B";
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatMB(mb: number): string {
    if (mb === 0) return "0MB";
    if (mb < 0.01) return "<0.01MB";
    return `${mb.toFixed(2)}MB`;
}

function formatRelativeTime(timestamp: number): string {
    const now = Date.now() / 1000;
    const diff = now - timestamp;
    if (diff < 60) return "刚刚";
    if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
    return `${Math.floor(diff / 86400)}天前`;
}

function formatTTL(seconds: number): string {
    if (seconds < 60) return `${seconds}秒`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}小时`;
    return `${Math.floor(seconds / 86400)}天`;
}

/**
 * Calculate combined hit rate from L1 + L2.
 * Flow: request → L1 hit (done) → L1 miss → L2 hit/miss
 * So total requests = L1.hits + L2.hits + L2.misses
 */
function getCombinedHitRate(l1: { hits: number }, l2: { hits: number; misses: number }): string {
    const totalHits = l1.hits + l2.hits;
    const totalRequests = l1.hits + l2.hits + l2.misses;
    if (totalRequests === 0) return "-";
    return ((totalHits / totalRequests) * 100).toFixed(1);
}

const PAGE_SIZE = 10;

// Preferred display order for core types
const CORE_ORDER = ["url", "llm", "prompt", "translate"];

interface CachePanelProps {
    onFileOpen?: (path: string) => void;
}

export default function CachePanel({ onFileOpen }: CachePanelProps) {
    const [stats, setStats] = useState<CacheStats | null>(null);
    const [expandedType, setExpandedType] = useState<CacheType | null>(null);
    const [entries, setEntries] = useState<CacheEntryPreview[]>([]);
    const [entriesTotal, setEntriesTotal] = useState(0);
    const [entriesPage, setEntriesPage] = useState(1);
    const [loading, setLoading] = useState(false);

    // Derive ordered cache type keys from stats
    const cacheTypeKeys = useMemo(() => {
        if (!stats) return [];
        const keys = Object.keys(stats);
        // Core types first in fixed order, then tool_* types sorted
        const core = CORE_ORDER.filter((k) => keys.includes(k));
        const tools = keys.filter((k) => !CORE_ORDER.includes(k)).sort();
        return [...core, ...tools];
    }, [stats]);

    const loadStats = useCallback(async () => {
        try {
            const data = await fetchCacheStats();
            setStats(data);
        } catch {
            // Backend might not be running
        }
    }, []);

    useEffect(() => {
        loadStats();
    }, [loadStats]);

    const loadEntries = useCallback(async (type: CacheType, page: number = 1) => {
        setLoading(true);
        try {
            const data = await fetchCacheEntries(type, page, PAGE_SIZE);
            if (page === 1) {
                setEntries(data.entries);
            } else {
                setEntries((prev) => [...prev, ...data.entries]);
            }
            setEntriesTotal(data.total);
            setEntriesPage(page);
        } catch {
            // ignore
        } finally {
            setLoading(false);
        }
    }, []);

    const handleExpand = useCallback(
        (type: CacheType) => {
            if (expandedType === type) {
                setExpandedType(null);
                setEntries([]);
                setEntriesTotal(0);
                setEntriesPage(1);
            } else {
                setExpandedType(type);
                setEntries([]);
                setEntriesTotal(0);
                setEntriesPage(1);
                loadEntries(type, 1);
            }
        },
        [expandedType, loadEntries]
    );

    const handleDeleteEntry = useCallback(
        async (type: CacheType, key: string) => {
            try {
                await deleteCacheEntry(type, key);
                setEntries((prev) => prev.filter((e) => e.key !== key));
                setEntriesTotal((prev) => prev - 1);
                loadStats();
            } catch {
                // ignore
            }
        },
        [loadStats]
    );

    const handleClearType = useCallback(
        async (type: CacheType) => {
            const label = getCacheLabel(type);
            if (!confirm(`确定要清空所有 ${label} 吗？`)) return;
            try {
                await clearCache(type);
                if (expandedType === type) {
                    setEntries([]);
                    setEntriesTotal(0);
                }
                loadStats();
            } catch {
                // ignore
            }
        },
        [expandedType, loadStats]
    );

    const handleClearAll = useCallback(async () => {
        if (!confirm("确定要清空所有缓存吗？")) return;
        try {
            await clearCache("all");
            setEntries([]);
            setEntriesTotal(0);
            loadStats();
        } catch {
            // ignore
        }
    }, [loadStats]);

    const handleCleanup = useCallback(async () => {
        try {
            await cleanupCache();
            loadStats();
            if (expandedType) {
                loadEntries(expandedType, 1);
            }
        } catch {
            // ignore
        }
    }, [loadStats, expandedType, loadEntries]);

    const handleLoadMore = useCallback(() => {
        if (expandedType) {
            loadEntries(expandedType, entriesPage + 1);
        }
    }, [expandedType, entriesPage, loadEntries]);

    if (!stats) {
        return (
            <div className="px-3 py-8 text-center">
                <p className="text-xs text-muted-foreground">加载缓存信息...</p>
            </div>
        );
    }

    return (
        <div className="space-y-1">
            {/* Action buttons */}
            <div className="flex items-center gap-1 px-2 pb-1">
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={handleCleanup}
                        >
                            <Sparkles className="w-3 h-3 mr-1" />
                            清理
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>清理过期缓存</TooltipContent>
                </Tooltip>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                            onClick={handleClearAll}
                        >
                            <Trash2 className="w-3 h-3 mr-1" />
                            清空全部
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>清空所有缓存</TooltipContent>
                </Tooltip>
            </div>

            {/* Cache type accordion - dynamically from stats keys */}
            {cacheTypeKeys.map((id) => {
                const typeStats = stats[id];
                if (!typeStats) return null;

                if (id.startsWith("tool_") && typeStats.l2.file_count === 0) {
                    return null;
                }


                const Icon = getCacheIcon(id);
                const label = getCacheLabel(id);
                const isExpanded = expandedType === id;
                const fileCount = typeStats.l2.file_count;
                const sizeMB = typeStats.l2.size_mb;

                return (
                    <div key={id}>
                        {/* Category header */}
                        <button
                            className={`w-full text-left px-3 py-2 rounded-xl text-sm transition-all duration-150 flex items-center gap-2 group ${isExpanded
                                ? "bg-primary/10 text-primary"
                                : "hover:bg-accent text-foreground/70"
                                }`}
                            onClick={() => handleExpand(id)}
                        >
                            {isExpanded ? (
                                <ChevronDown className="w-3.5 h-3.5 shrink-0" />
                            ) : (
                                <ChevronRight className="w-3.5 h-3.5 shrink-0" />
                            )}
                            <Icon className="w-3.5 h-3.5 shrink-0" />
                            <span className="flex-1 min-w-0 truncate font-medium text-xs">
                                {label}
                            </span>
                            <span className="text-[10px] text-muted-foreground/40 shrink-0 w-10 text-right">
                                {formatMB(sizeMB)}
                            </span>
                            <span className="text-[10px] text-muted-foreground/60 shrink-0 w-6 text-right">
                                {fileCount}条
                            </span>
                            <span
                                className={`text-[10px] px-1.5 py-0.5 rounded-md shrink-0 ${typeStats.enabled
                                    ? "text-green-600 bg-green-50"
                                    : "text-muted-foreground bg-muted/50"
                                    }`}
                            >
                                {typeStats.enabled ? "开" : "关"}
                            </span>
                        </button>

                        {/* Expanded content */}
                        {isExpanded && (
                            <div className="ml-3 mr-1 mt-1 space-y-1">
                                {/* Stats summary */}
                                <div className="flex items-center justify-between px-2 py-1.5 text-[10px] text-muted-foreground/60 bg-muted/30 rounded-lg">
                                    <span>
                                        命中率: {getCombinedHitRate(typeStats.l1, typeStats.l2)}% | TTL: {formatTTL(typeStats.ttl)}
                                    </span>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-5 px-1.5 text-[10px] text-destructive hover:text-destructive"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handleClearType(id);
                                        }}
                                    >
                                        清空
                                    </Button>
                                </div>

                                {/* Entries list */}
                                {entries.length === 0 && !loading && (
                                    <div className="px-2 py-3 text-center">
                                        <p className="text-[10px] text-muted-foreground/50">
                                            暂无缓存条目
                                        </p>
                                    </div>
                                )}

                                {entries.map((entry, idx) => (
                                    <button
                                        key={entry.key}
                                        className="w-full text-left flex items-start gap-1.5 px-2 py-1.5 rounded-lg hover:bg-accent/50 transition-colors group/entry"
                                        onClick={() => onFileOpen?.(`.cache/${id}/${entry.key.substring(0, 2)}/${entry.key}.json`)}
                                    >
                                        <span className="text-[10px] text-muted-foreground/30 mt-0.5 shrink-0">
                                            {idx === entries.length - 1 ? "└" : "├"}
                                        </span>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-1">
                                                <span className="text-[11px] font-mono text-foreground/60 truncate">
                                                    {entry.key.substring(0, 10)}...
                                                </span>
                                                <span className="text-[10px] text-muted-foreground/40 shrink-0">
                                                    ({formatBytes(entry.size_bytes)})
                                                </span>
                                            </div>
                                            <p className="text-[10px] text-muted-foreground/40 truncate">
                                                {formatRelativeTime(entry.created_at)}
                                                {entry.preview ? ` · ${entry.preview.substring(0, 40)}` : ""}
                                            </p>
                                        </div>
                                        <span
                                            className="opacity-0 group-hover/entry:opacity-60 hover:!opacity-100 transition-opacity shrink-0 mt-0.5"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                handleDeleteEntry(id, entry.key);
                                            }}
                                        >
                                            <X className="w-3 h-3 text-destructive" />
                                        </span>
                                    </button>
                                ))}

                                {/* Load more */}
                                {entries.length < entriesTotal && (
                                    <button
                                        className="w-full text-center py-1.5 text-[10px] text-primary/60 hover:text-primary transition-colors rounded-lg hover:bg-accent/30"
                                        onClick={handleLoadMore}
                                        disabled={loading}
                                    >
                                        {loading
                                            ? "加载中..."
                                            : `加载更多 (还有 ${entriesTotal - entries.length} 条)`}
                                    </button>
                                )}

                                {loading && entries.length === 0 && (
                                    <div className="px-2 py-3 text-center">
                                        <p className="text-[10px] text-muted-foreground/50">
                                            加载中...
                                        </p>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
