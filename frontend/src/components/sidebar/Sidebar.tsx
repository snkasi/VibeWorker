"use client";

import React, { useState, useEffect, useRef, useCallback, useLayoutEffect } from "react";
import {
    MessageSquare,
    Brain,
    Puzzle,
    Database,
    Plug,
    Plus,
    Trash2,
    Store,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { fetchSessions, createSession, deleteSession, fetchSkills, deleteSkill, type Session, type Skill, type MemoryEntry, type DailyLogEntry } from "@/lib/api";
import { useIsSessionStreaming, sessionStore } from "@/lib/sessionStore";
import { formatRelativeTime } from "@/lib/utils";
import SkillsStoreDialog from "@/components/store/SkillsStoreDialog";
import CachePanel from "./CachePanel";
import MemoryPanel from "./MemoryPanel";
import McpPanel from "./McpPanel";

type ViewMode = "chat" | "memory" | "skills" | "mcp" | "cache";

interface SidebarProps {
    currentSessionId: string;
    onSessionSelect: (sessionId: string) => void;
    onViewChange: (view: ViewMode) => void;
    currentView: ViewMode;
    onFileOpen?: (path: string) => void;
    onRefreshReady?: (refreshFn: () => void) => void;
    onUpdateTitleReady?: (updateFn: (sessionId: string, title: string) => void) => void;
    onMemoryEntryOpen?: (entry: MemoryEntry) => void;
    onDailyLogEntryOpen?: (date: string, entry: DailyLogEntry) => void;
    memoryRefreshKey?: number;
}

const NAV_ITEMS: { id: ViewMode; icon: React.ElementType; label: string }[] = [
    { id: "chat", icon: MessageSquare, label: "会话" },
    { id: "memory", icon: Brain, label: "记忆" },
    { id: "skills", icon: Puzzle, label: "技能" },
    { id: "mcp", icon: Plug, label: "MCP" },
    { id: "cache", icon: Database, label: "缓存" },
];

/** Session list item — extracted as a component to use hooks per-item */
const SessionItem = React.forwardRef<HTMLButtonElement, {
    session: Session;
    isSelected: boolean;
    onSelect: () => void;
    onDelete: (e: React.MouseEvent) => void;
}>(({ session, isSelected, onSelect, onDelete }, ref) => {
    const isStreaming = useIsSessionStreaming(session.session_id);
    return (
        <button
            ref={ref}
            className={`relative z-10 w-full text-left px-3 py-2.5 rounded-xl text-sm transition-colors duration-150 group flex items-center gap-2 overflow-hidden ${isSelected
                ? "text-primary font-medium"
                : "hover:bg-accent/50 text-foreground/70"
                }`}
            onClick={onSelect}
        >
            <MessageSquare className="w-3.5 h-3.5 shrink-0 opacity-50" />
            <span className="flex-1 min-w-0 line-clamp-2 break-words">
                {session.title || session.preview || "新会话"}
            </span>
            {isStreaming && (
                <span className="relative flex h-2 w-2 shrink-0">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
                </span>
            )}
            <span className="text-[10px] text-muted-foreground/40 shrink-0">
                {formatRelativeTime(session.updated_at)}
            </span>
            <Trash2
                className="w-3.5 h-3.5 opacity-0 group-hover:opacity-40 hover:!opacity-100 hover:text-destructive shrink-0 transition-opacity"
                onClick={onDelete}
            />
        </button>
    );
});
SessionItem.displayName = "SessionItem";

/** Session list with sliding selection indicator */
function SessionList({
    sessions,
    currentSessionId,
    onSessionSelect,
    onDeleteSession
}: {
    sessions: Session[];
    currentSessionId: string;
    onSessionSelect: (id: string) => void;
    onDeleteSession: (e: React.MouseEvent, id: string) => void;
}) {
    const containerRef = useRef<HTMLDivElement>(null);
    const itemRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
    const [indicatorStyle, setIndicatorStyle] = useState<{ top: number; height: number } | null>(null);

    const updateIndicator = useCallback(() => {
        const container = containerRef.current;
        const selectedItem = itemRefs.current.get(currentSessionId);

        if (container && selectedItem) {
            const containerRect = container.getBoundingClientRect();
            const itemRect = selectedItem.getBoundingClientRect();
            setIndicatorStyle({
                top: itemRect.top - containerRect.top,
                height: itemRect.height,
            });
        }
    }, [currentSessionId]);

    // Update indicator position when selection changes or sessions change
    useLayoutEffect(() => {
        updateIndicator();
    }, [currentSessionId, sessions, updateIndicator]);

    // Also update on window resize
    useEffect(() => {
        window.addEventListener("resize", updateIndicator);
        return () => window.removeEventListener("resize", updateIndicator);
    }, [updateIndicator]);

    const setItemRef = useCallback((id: string, el: HTMLButtonElement | null) => {
        if (el) {
            itemRefs.current.set(id, el);
        } else {
            itemRefs.current.delete(id);
        }
    }, []);

    return (
        <div ref={containerRef} className="relative">
            {/* Sliding selection indicator */}
            {indicatorStyle && (
                <div
                    className="absolute left-0 right-0 bg-primary/10 rounded-xl transition-all duration-200 ease-out"
                    style={{
                        top: indicatorStyle.top,
                        height: indicatorStyle.height,
                    }}
                />
            )}
            {/* Session items */}
            <div className="space-y-1">
                {sessions.map((session) => (
                    <SessionItem
                        key={session.session_id}
                        ref={(el) => setItemRef(session.session_id, el)}
                        session={session}
                        isSelected={session.session_id === currentSessionId}
                        onSelect={() => onSessionSelect(session.session_id)}
                        onDelete={(e) => onDeleteSession(e, session.session_id)}
                    />
                ))}
            </div>
        </div>
    );
}

export default function Sidebar({
    currentSessionId,
    onSessionSelect,
    onViewChange,
    currentView,
    onFileOpen,
    onRefreshReady,
    onUpdateTitleReady,
    onMemoryEntryOpen,
    onDailyLogEntryOpen,
    memoryRefreshKey,
}: SidebarProps) {
    const [sessions, setSessions] = useState<Session[]>([]);
    const [skills, setSkills] = useState<Skill[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [storeOpen, setStoreOpen] = useState(false);

    // Fetch sessions
    useEffect(() => {
        loadSessions();
    }, []);

    // Expose refresh function to parent
    useEffect(() => {
        if (onRefreshReady) {
            onRefreshReady(loadSessions);
        }
    }, [onRefreshReady]);

    // 暴露即时更新会话标题的函数给父组件
    const updateSessionTitle = useCallback((sessionId: string, title: string) => {
        setSessions((prev) =>
            prev.map((s) =>
                s.session_id === sessionId ? { ...s, title } : s
            )
        );
    }, []);

    useEffect(() => {
        if (onUpdateTitleReady) {
            onUpdateTitleReady(updateSessionTitle);
        }
    }, [onUpdateTitleReady, updateSessionTitle]);

    useEffect(() => {
        if (currentView === "skills") {
            loadSkills();
        }
    }, [currentView]);

    const initialLoadDone = useRef(false);

    const loadSessions = async () => {
        try {
            const data = await fetchSessions();
            setSessions(data);
            // On first load, auto-select the most recent session
            if (!initialLoadDone.current && data.length > 0) {
                initialLoadDone.current = true;
                onSessionSelect(data[0].session_id);
            }
        } catch {
            // Backend might not be running
        }
    };

    const loadSkills = async () => {
        try {
            const data = await fetchSkills();
            setSkills(data);
        } catch {
            // Backend might not be running
        }
    };

    const handleNewSession = async () => {
        setIsLoading(true);
        try {
            const id = await createSession();
            await loadSessions();
            onSessionSelect(id);
        } catch {
            // Fallback for offline
            const id = `session_${Date.now()}`;
            onSessionSelect(id);
        }
        setIsLoading(false);
    };

    const handleDeleteSession = async (
        e: React.MouseEvent,
        sessionId: string
    ) => {
        e.stopPropagation();
        try {
            sessionStore.removeSession(sessionId);
            await deleteSession(sessionId);
            await loadSessions();
            if (sessionId === currentSessionId) {
                onSessionSelect("main_session");
            }
        } catch {
            // Ignore
        }
    };

    const handleDeleteSkill = async (
        e: React.MouseEvent,
        skillName: string
    ) => {
        e.stopPropagation();
        if (!confirm(`确定要删除技能「${skillName}」吗？`)) return;
        try {
            await deleteSkill(skillName);
            await loadSkills();
        } catch {
            // Ignore
        }
    };

    return (
        <div className="flex h-full">
            {/* Icon Navigation Rail */}
            <div className="w-14 flex flex-col items-center py-4 gap-2 border-r border-border/30">
                {NAV_ITEMS.map((item) => (
                    <Tooltip key={item.id}>
                        <TooltipTrigger asChild>
                            <Button
                                variant={currentView === item.id ? "default" : "ghost"}
                                size="icon"
                                className={`w-10 h-10 rounded-xl transition-all duration-200 ${currentView === item.id
                                    ? "bg-primary text-primary-foreground shadow-md"
                                    : "hover:bg-accent"
                                    }`}
                                onClick={() => onViewChange(item.id)}
                                id={`nav-${item.id}`}
                            >
                                <item.icon className="w-5 h-5" />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent side="right">{item.label}</TooltipContent>
                    </Tooltip>
                ))}
            </div>

            {/* Content Panel */}
            <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
                {/* Header */}
                <div className="px-4 py-3 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-foreground/80">
                        {currentView === "chat"
                            ? "会话"
                            : currentView === "memory"
                                ? "记忆"
                                : currentView === "skills"
                                    ? "技能"
                                    : currentView === "mcp"
                                        ? "MCP"
                                        : "缓存"}
                    </h3>
                    {currentView === "chat" && (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="w-7 h-7 rounded-lg"
                                    onClick={handleNewSession}
                                    disabled={isLoading}
                                    id="new-session-button"
                                >
                                    <Plus className="w-4 h-4" />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>新建会话</TooltipContent>
                        </Tooltip>
                    )}
                    {currentView === "skills" && (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="w-7 h-7 rounded-lg"
                                    onClick={() => setStoreOpen(true)}
                                    id="skills-store-button"
                                >
                                    <Store className="w-4 h-4" />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>技能商店</TooltipContent>
                        </Tooltip>
                    )}
                </div>

                <Separator className="opacity-50" />

                {/* List */}
                <ScrollArea className="flex-1 overflow-hidden">
                    <div className="p-2 space-y-1 w-full overflow-hidden">
                        {/* Chat Sessions */}
                        {currentView === "chat" && (
                            <>
                                {sessions.length === 0 && (
                                    <div className="px-3 py-8 text-center">
                                        <p className="text-xs text-muted-foreground">暂无会话</p>
                                        <p className="text-xs text-muted-foreground/60 mt-1">
                                            开始对话后会自动创建
                                        </p>
                                    </div>
                                )}
                                {sessions.length > 0 && (
                                    <SessionList
                                        sessions={sessions}
                                        currentSessionId={currentSessionId}
                                        onSessionSelect={onSessionSelect}
                                        onDeleteSession={handleDeleteSession}
                                    />
                                )}
                            </>
                        )}

                        {/* Memory Panel */}
                        {currentView === "memory" && (
                            <MemoryPanel
                                onFileOpen={onFileOpen}
                                onMemoryEntryOpen={onMemoryEntryOpen}
                                onDailyLogEntryOpen={onDailyLogEntryOpen}
                                refreshKey={memoryRefreshKey}
                            />
                        )}

                        {/* Skills List */}
                        {currentView === "skills" && (
                            <div className="space-y-1">
                                {skills.length === 0 && (
                                    <div className="px-3 py-8 text-center">
                                        <p className="text-xs text-muted-foreground">暂无技能</p>
                                        <p className="text-xs text-muted-foreground/60 mt-1">
                                            将 SKILL.md 放入 skills/ 目录
                                        </p>
                                    </div>
                                )}
                                {skills.map((skill) => (
                                    <button
                                        key={skill.name}
                                        className="w-full text-left px-3 py-2.5 rounded-xl text-sm hover:bg-accent transition-all duration-150 flex items-start gap-2 group"
                                        onClick={() => onFileOpen?.(skill.location)}
                                    >
                                        <Puzzle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-primary/60" />
                                        <div className="flex-1 min-w-0">
                                            <div className="font-medium break-words flex items-center gap-2">
                                                {skill.name}
                                                {skill.source === "claude_code" && (
                                                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-accent text-muted-foreground shrink-0 border border-border/50">
                                                        Claude Code
                                                    </span>
                                                )}
                                            </div>
                                            <div className="text-xs text-muted-foreground/60 break-words line-clamp-2">
                                                {skill.description}
                                            </div>
                                        </div>
                                        {skill.source !== "claude_code" && (
                                            <Trash2
                                                className="w-3.5 h-3.5 mt-0.5 opacity-0 group-hover:opacity-40 hover:!opacity-100 hover:text-destructive shrink-0 transition-opacity cursor-pointer"
                                                onClick={(e) => handleDeleteSkill(e, skill.name)}
                                            />
                                        )}
                                    </button>
                                ))}
                            </div>
                        )}

                        {/* MCP Panel */}
                        {currentView === "mcp" && <McpPanel onFileOpen={onFileOpen} />}

                        {/* Cache Panel */}
                        {currentView === "cache" && <CachePanel onFileOpen={onFileOpen} />}
                    </div>
                </ScrollArea>
            </div>

            {/* Skills Store Dialog */}
            <SkillsStoreDialog
                open={storeOpen}
                onOpenChange={setStoreOpen}
                onSkillInstalled={loadSkills}
            />
        </div>
    );
}
