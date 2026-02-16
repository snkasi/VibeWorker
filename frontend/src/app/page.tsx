"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  PanelRightClose,
  PanelRightOpen,
  Wifi,
  WifiOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import Sidebar from "@/components/sidebar/Sidebar";
import ChatPanel from "@/components/chat/ChatPanel";
import InspectorPanel from "@/components/editor/InspectorPanel";
import SettingsDialog, { initTheme } from "@/components/settings/SettingsDialog";
import { checkHealth, generateSessionTitle } from "@/lib/api";
import { sessionStore } from "@/lib/sessionStore";

type ViewMode = "chat" | "memory" | "skills" | "mcp" | "cache";

// Panel width constraints
const LEFT_MIN = 200;
const LEFT_MAX = 400;
const LEFT_DEFAULT = 256;
const RIGHT_MIN = 280;
const RIGHT_MAX = 600;
const RIGHT_DEFAULT = 384;

export default function HomePage() {
  const [currentView, setCurrentView] = useState<ViewMode>("chat");
  const [currentSessionId, setCurrentSessionId] = useState("main_session");
  const [inspectorFile, setInspectorFile] = useState<string | null>(null);
  const [showInspector, setShowInspector] = useState(false);
  const [isBackendOnline, setIsBackendOnline] = useState(false);

  // Resizable panel widths
  const [leftWidth, setLeftWidth] = useState(LEFT_DEFAULT);
  const [rightWidth, setRightWidth] = useState(RIGHT_DEFAULT);
  const draggingRef = useRef<"left" | "right" | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const sidebarRefreshRef = useRef<() => void>(() => {});

  // Initialize theme from localStorage on mount
  useEffect(() => {
    initTheme();
  }, []);

  // Health check
  useEffect(() => {
    const check = async () => {
      const online = await checkHealth();
      setIsBackendOnline(online);
    };
    check();
    const interval = setInterval(check, 10000);
    return () => clearInterval(interval);
  }, []);

  // Register first-message callback for title generation
  useEffect(() => {
    sessionStore.setOnFirstMessage(async (sessionId: string) => {
      try {
        await generateSessionTitle(sessionId);
        sidebarRefreshRef.current();
      } catch (err) {
        console.error("Failed to generate session title:", err);
      }
    });
    return () => sessionStore.setOnFirstMessage(null);
  }, []);

  const handleFileOpen = useCallback((path: string) => {
    setInspectorFile(path);
    setShowInspector(true);
  }, []);

  const handleInspectorClose = useCallback(() => {
    setShowInspector(false);
  }, []);

  const handleSessionSelect = useCallback((sessionId: string) => {
    setCurrentSessionId(sessionId);
    setCurrentView("chat");
  }, []);

  // ---- Drag resize logic ----
  const handleMouseDown = useCallback((side: "left" | "right") => {
    draggingRef.current = side;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();

      if (draggingRef.current === "left") {
        const newWidth = Math.min(LEFT_MAX, Math.max(LEFT_MIN, e.clientX - rect.left));
        setLeftWidth(newWidth);
      } else if (draggingRef.current === "right") {
        const newWidth = Math.min(RIGHT_MAX, Math.max(RIGHT_MIN, rect.right - e.clientX));
        setRightWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      if (draggingRef.current) {
        draggingRef.current = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-background">
      {/* ============================================
          Top Navigation Bar
          ============================================ */}
      <header className="h-12 flex items-center justify-between px-4 border-b border-border/40 glass-subtle shrink-0 z-50">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-[var(--vw-blue)] to-[#0958d9] flex items-center justify-center shadow-sm">
              <span className="text-white text-xs font-bold">V</span>
            </div>
            <h1 className="text-sm font-semibold tracking-tight">
              VibeWorker
            </h1>
          </div>
          <span className="text-[10px] text-muted-foreground/50 font-mono bg-muted/50 px-1.5 py-0.5 rounded-md">
            v0.1.0
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* Backend Status Indicator */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px] font-medium transition-colors ${isBackendOnline
                  ? "text-green-600 bg-green-50"
                  : "text-muted-foreground bg-muted/50"
                  }`}
              >
                {isBackendOnline ? (
                  <Wifi className="w-3 h-3" />
                ) : (
                  <WifiOff className="w-3 h-3" />
                )}
                {isBackendOnline ? "在线" : "离线"}
              </div>
            </TooltipTrigger>
            <TooltipContent>
              {isBackendOnline
                ? "后端服务运行中 (localhost:8088)"
                : "后端服务未连接"}
            </TooltipContent>
          </Tooltip>

          {/* Settings Dialog */}
          <SettingsDialog />

          {/* Inspector Toggle */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="w-8 h-8 rounded-lg"
                onClick={() => setShowInspector(!showInspector)}
                id="toggle-inspector"
              >
                {showInspector ? (
                  <PanelRightClose className="w-4 h-4" />
                ) : (
                  <PanelRightOpen className="w-4 h-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {showInspector ? "关闭编辑器" : "打开编辑器"}
            </TooltipContent>
          </Tooltip>
        </div>
      </header>

      {/* ============================================
          Main Content (Resizable Three-Column Layout)
          ============================================ */}
      <div ref={containerRef} className="flex-1 flex overflow-hidden">
        {/* Left Sidebar */}
        <aside
          className="border-r border-border/40 shrink-0 overflow-hidden bg-sidebar/50"
          style={{ width: leftWidth }}
        >
          <Sidebar
            currentSessionId={currentSessionId}
            onSessionSelect={handleSessionSelect}
            onViewChange={setCurrentView}
            currentView={currentView}
            onFileOpen={handleFileOpen}
            onRefreshReady={(refreshFn) => {
              sidebarRefreshRef.current = refreshFn;
            }}
          />
        </aside>

        {/* Left Resize Handle */}
        <div
          className="resize-handle"
          onMouseDown={() => handleMouseDown("left")}
        />

        {/* Center Stage */}
        <main className="flex-1 min-w-0">
          <ChatPanel
            sessionId={currentSessionId}
            onFileOpen={handleFileOpen}
          />
        </main>

        {/* Right Resize Handle + Inspector */}
        {showInspector && (
          <>
            <div
              className="resize-handle"
              onMouseDown={() => handleMouseDown("right")}
            />
            <aside
              className="border-l border-border/40 shrink-0 bg-card/50 overflow-hidden"
              style={{ width: rightWidth }}
            >
              <InspectorPanel
                filePath={inspectorFile}
                onClose={handleInspectorClose}
              />
            </aside>
          </>
        )}
      </div>
    </div>
  );
}
