"use client";

import React, { useState, useEffect, useRef } from "react";
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
import { fetchSessions, createSession, deleteSession, fetchSkills, deleteSkill, type Session, type Skill } from "@/lib/api";
import { useIsSessionStreaming, sessionStore } from "@/lib/sessionStore";
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
}

const NAV_ITEMS: { id: ViewMode; icon: React.ElementType; label: string }[] = [
    { id: "chat", icon: MessageSquare, label: "对话" },
    { id: "memory", icon: Brain, label: "记忆" },
    { id: "skills", icon: Puzzle, label: "技能" },
    { id: "mcp", icon: Plug, label: "MCP" },
    { id: "cache", icon: Database, label: "缓存" },
];

/** Session list item — extracted as a component to use hooks per-item */
function SessionItem({ session, isSelected, onSelect, onDelete }: {
    session: Session;
    isSelected: boolean;
    onSelect: () => void;
    onDelete: (e: React.MouseEvent) => void;
}) {
    const isStreaming = useIsSessionStreaming(session.session_id);
    return (
        <button
            className={`w-full text-left px-3 py-2.5 rounded-xl text-sm transition-all duration-150 group flex items-start gap-2 overflow-hidden ${isSelected
                ? "bg-primary/10 text-primary font-medium"
                : "hover:bg-accent text-foreground/70"
                }`}
            onClick={onSelect}
        >
            <MessageSquare className="w-3.5 h-3.5 shrink-0 opacity-50 mt-0.5" />
            <span className="flex-1 min-w-0 line-clamp-2 break-words">
                {session.title || session.preview || "新会话"}
            </span>
            {isStreaming && (
                <span className="relative flex h-2 w-2 shrink-0 mt-1.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
                </span>
            )}
            <span className="text-[10px] text-muted-foreground/40 shrink-0">
                {session.message_count}
            </span>
            <Trash2
                className="w-3.5 h-3.5 opacity-0 group-hover:opacity-40 hover:!opacity-100 hover:text-destructive shrink-0 transition-opacity"
                onClick={onDelete}
            />
        </button>
    );
}

export default function Sidebar({
    currentSessionId,
    onSessionSelect,
    onViewChange,
    currentView,
    onFileOpen,
    onRefreshReady,
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
                                {sessions.map((session) => (
                                    <SessionItem
                                        key={session.session_id}
                                        session={session}
                                        isSelected={session.session_id === currentSessionId}
                                        onSelect={() => onSessionSelect(session.session_id)}
                                        onDelete={(e) => handleDeleteSession(e, session.session_id)}
                                    />
                                ))}
                            </>
                        )}

                        {/* Memory Panel */}
                        {currentView === "memory" && (
                            <MemoryPanel onFileOpen={onFileOpen} />
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
                                            <div className="font-medium break-words">{skill.name}</div>
                                            <div className="text-xs text-muted-foreground/60 break-words line-clamp-2">
                                                {skill.description}
                                            </div>
                                        </div>
                                        <Trash2
                                            className="w-3.5 h-3.5 mt-0.5 opacity-0 group-hover:opacity-40 hover:!opacity-100 hover:text-destructive shrink-0 transition-opacity cursor-pointer"
                                            onClick={(e) => handleDeleteSkill(e, skill.name)}
                                        />
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
