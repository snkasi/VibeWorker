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
    addMemoryEntry,
    deleteMemoryEntry,
    fetchDailyLogs,
    searchMemory,
    type MemoryEntry,
    type DailyLog,
} from "@/lib/api";

type MemoryTab = "entries" | "logs" | "files";

const CATEGORY_OPTIONS = [
    { value: "", label: "全部" },
    { value: "preferences", label: "偏好" },
    { value: "facts", label: "事实" },
    { value: "tasks", label: "任务" },
    { value: "reflections", label: "反思" },
    { value: "general", label: "通用" },
];

const CATEGORY_LABELS: Record<string, string> = {
    preferences: "偏好",
    facts: "事实",
    tasks: "任务",
    reflections: "反思",
    general: "通用",
};

const WORKSPACE_FILES = [
    { name: "MEMORY.md", path: "memory/MEMORY.md", icon: "📝" },
    { name: "SOUL.md", path: "workspace/SOUL.md", icon: "💫" },
    { name: "IDENTITY.md", path: "workspace/IDENTITY.md", icon: "🪪" },
    { name: "USER.md", path: "workspace/USER.md", icon: "👤" },
    { name: "AGENTS.md", path: "workspace/AGENTS.md", icon: "📋" },
];

interface MemoryPanelProps {
    onFileOpen?: (path: string) => void;
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    return `${(bytes / 1024).toFixed(1)}KB`;
}

export default function MemoryPanel({ onFileOpen }: MemoryPanelProps) {
    const [activeTab, setActiveTab] = useState<MemoryTab>("entries");
    const [entries, setEntries] = useState<MemoryEntry[]>([]);
    const [dailyLogs, setDailyLogs] = useState<DailyLog[]>([]);
    const [categoryFilter, setCategoryFilter] = useState("");
    const [searchQuery, setSearchQuery] = useState("");
    const [searchResult, setSearchResult] = useState<string | null>(null);
    const [isSearching, setIsSearching] = useState(false);
    const [isLoading, setIsLoading] = useState(false);

    // Add entry form
    const [showAddForm, setShowAddForm] = useState(false);
    const [newContent, setNewContent] = useState("");
    const [newCategory, setNewCategory] = useState("general");
    const [isAdding, setIsAdding] = useState(false);

    const loadEntries = useCallback(async () => {
        setIsLoading(true);
        try {
            const data = await fetchMemoryEntries(categoryFilter || undefined);
            setEntries(data.entries);
        } catch {
            // Backend might not be running
        } finally {
            setIsLoading(false);
        }
    }, [categoryFilter]);

    const loadDailyLogs = useCallback(async () => {
        try {
            const logs = await fetchDailyLogs();
            setDailyLogs(logs);
        } catch {
            // Backend might not be running
        }
    }, []);

    useEffect(() => {
        if (activeTab === "entries") loadEntries();
        if (activeTab === "logs") loadDailyLogs();
    }, [activeTab, loadEntries, loadDailyLogs]);

    const handleSearch = async () => {
        if (!searchQuery.trim()) return;
        setIsSearching(true);
        setSearchResult(null);
        try {
            const result = await searchMemory(searchQuery);
            setSearchResult(result);
        } catch {
            setSearchResult("搜索失败，请检查后端连接。");
        } finally {
            setIsSearching(false);
        }
    };

    const handleAddEntry = async () => {
        if (!newContent.trim()) return;
        setIsAdding(true);
        try {
            await addMemoryEntry(newContent.trim(), newCategory);
            setNewContent("");
            setShowAddForm(false);
            await loadEntries();
        } catch {
            // Ignore
        } finally {
            setIsAdding(false);
        }
    };

    const handleDeleteEntry = async (e: React.MouseEvent, entryId: string) => {
        e.stopPropagation();
        try {
            await deleteMemoryEntry(entryId);
            await loadEntries();
        } catch {
            // Ignore
        }
    };

    return (
        <div className="flex flex-col h-full">
            {/* Tab Bar */}
            <div className="flex items-center gap-1 px-2 pt-1 pb-1">
                {(
                    [
                        { id: "entries", label: "记忆", icon: FileText },
                        { id: "logs", label: "日记", icon: Calendar },
                        { id: "files", label: "人格", icon: FileText },
                    ] as const
                ).map((tab) => (
                    <button
                        key={tab.id}
                        onClick={() => {
                            setActiveTab(tab.id);
                            setSearchResult(null);
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

            {/* Search Bar (entries & logs tabs) */}
            {activeTab !== "files" && (
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
                                    setSearchResult(null);
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

            {/* Search Results */}
            {searchResult !== null && (
                <div className="px-2 pb-2">
                    <div className="p-2 rounded-lg bg-primary/5 border border-primary/10">
                        <div className="flex items-center justify-between mb-1">
                            <span className="text-[10px] font-medium text-primary">搜索结果</span>
                            <button onClick={() => setSearchResult(null)}>
                                <X className="w-3 h-3 text-muted-foreground/50 hover:text-muted-foreground" />
                            </button>
                        </div>
                        <p className="text-xs text-foreground/80 whitespace-pre-wrap break-words leading-relaxed max-h-40 overflow-y-auto">
                            {searchResult}
                        </p>
                    </div>
                </div>
            )}

            {/* Content */}
            <ScrollArea className="flex-1 overflow-hidden">
                <div className="p-2 space-y-1 w-full overflow-hidden">
                    {/* Entries Tab */}
                    {activeTab === "entries" && (
                        <>
                            {/* Category Filter */}
                            <div className="flex flex-wrap gap-1 px-1 pb-1.5">
                                {CATEGORY_OPTIONS.map((opt) => (
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
                                    </button>
                                ))}
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <button
                                            onClick={() => setShowAddForm(!showAddForm)}
                                            className="px-1.5 py-0.5 text-[10px] rounded-full bg-primary/10 text-primary hover:bg-primary/20 transition-all"
                                        >
                                            <Plus className="w-3 h-3" />
                                        </button>
                                    </TooltipTrigger>
                                    <TooltipContent>添加记忆</TooltipContent>
                                </Tooltip>
                            </div>

                            {/* Add Entry Form */}
                            {showAddForm && (
                                <div className="mx-1 p-2 rounded-lg border border-border/50 bg-card space-y-2">
                                    <textarea
                                        value={newContent}
                                        onChange={(e) => setNewContent(e.target.value)}
                                        placeholder="输入记忆内容..."
                                        className="w-full h-16 p-2 text-xs rounded-md border border-border/50 bg-background resize-none focus:outline-none focus:ring-1 focus:ring-primary/30"
                                    />
                                    <div className="flex items-center gap-2">
                                        <select
                                            value={newCategory}
                                            onChange={(e) => setNewCategory(e.target.value)}
                                            className="h-6 px-2 text-[10px] rounded border border-border/50 bg-background"
                                        >
                                            {CATEGORY_OPTIONS.filter((o) => o.value).map((opt) => (
                                                <option key={opt.value} value={opt.value}>
                                                    {opt.label}
                                                </option>
                                            ))}
                                        </select>
                                        <div className="flex-1" />
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-6 px-2 text-[10px]"
                                            onClick={() => setShowAddForm(false)}
                                        >
                                            取消
                                        </Button>
                                        <Button
                                            size="sm"
                                            className="h-6 px-3 text-[10px]"
                                            onClick={handleAddEntry}
                                            disabled={isAdding || !newContent.trim()}
                                        >
                                            {isAdding ? (
                                                <Loader2 className="w-3 h-3 animate-spin" />
                                            ) : (
                                                "添加"
                                            )}
                                        </Button>
                                    </div>
                                </div>
                            )}

                            {/* Entries List */}
                            {isLoading && entries.length === 0 && (
                                <div className="flex items-center justify-center py-6">
                                    <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                                </div>
                            )}
                            {!isLoading && entries.length === 0 && (
                                <div className="px-3 py-8 text-center">
                                    <p className="text-xs text-muted-foreground">暂无持久记忆</p>
                                    <p className="text-xs text-muted-foreground/60 mt-1">
                                        对话中会自动积累记忆
                                    </p>
                                </div>
                            )}
                            {entries.map((entry) => (
                                <div
                                    key={entry.entry_id}
                                    className="px-3 py-2 rounded-xl text-sm hover:bg-accent/50 transition-all group"
                                >
                                    <div className="flex items-start gap-2">
                                        <span className="text-[10px] text-muted-foreground/60 shrink-0 mt-0.5">
                                            {entry.timestamp}
                                        </span>
                                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary/70 shrink-0">
                                            {CATEGORY_LABELS[entry.category] || entry.category}
                                        </span>
                                        <Trash2
                                            className="w-3 h-3 mt-0.5 opacity-0 group-hover:opacity-40 hover:!opacity-100 hover:text-destructive shrink-0 transition-opacity cursor-pointer ml-auto"
                                            onClick={(e) => handleDeleteEntry(e, entry.entry_id)}
                                        />
                                    </div>
                                    <p className="text-xs text-foreground/80 mt-1 break-words leading-relaxed">
                                        {entry.content}
                                    </p>
                                </div>
                            ))}
                        </>
                    )}

                    {/* Daily Logs Tab */}
                    {activeTab === "logs" && (
                        <>
                            {dailyLogs.length === 0 && (
                                <div className="px-3 py-8 text-center">
                                    <p className="text-xs text-muted-foreground">暂无日记</p>
                                    <p className="text-xs text-muted-foreground/60 mt-1">
                                        对话过程中会自动生成每日日记
                                    </p>
                                </div>
                            )}
                            {dailyLogs.map((log) => (
                                <button
                                    key={log.date}
                                    className="w-full text-left px-3 py-2.5 rounded-xl text-sm hover:bg-accent transition-all duration-150 flex items-center gap-2 group"
                                    onClick={() => onFileOpen?.(log.path)}
                                >
                                    <Calendar className="w-3.5 h-3.5 text-primary/60 shrink-0" />
                                    <span className="flex-1 font-mono text-xs">{log.date}</span>
                                    <span className="text-[10px] text-muted-foreground/50">
                                        {formatSize(log.size)}
                                    </span>
                                    <ChevronRight className="w-3.5 h-3.5 opacity-0 group-hover:opacity-40 transition-opacity" />
                                </button>
                            ))}
                        </>
                    )}

                    {/* Files Tab */}
                    {activeTab === "files" && (
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
        </div>
    );
}
