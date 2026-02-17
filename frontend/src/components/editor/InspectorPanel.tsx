"use client";

import React, { useState, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";
import { X, Save, FileText, RotateCcw, Languages, Loader2, Bug } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { fetchFile, saveFile, translateContent, fetchSettings } from "@/lib/api";
import DebugPanel from "@/components/debug/DebugPanel";

// Lazy-load Monaco to avoid SSR issues
const MonacoEditor = dynamic(
    () => import("@monaco-editor/react"),
    { ssr: false }
);

interface InspectorPanelProps {
    filePath: string | null;
    onClose: () => void;
    onClearFile?: () => void;
    debugMode?: boolean;
    sessionId?: string;
}

export default function InspectorPanel({
    filePath,
    onClose,
    onClearFile,
    debugMode = false,
    sessionId,
}: InspectorPanelProps) {
    const [content, setContent] = useState("");
    const [originalContent, setOriginalContent] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [isTranslating, setIsTranslating] = useState(false);
    const [translateModel, setTranslateModel] = useState("");
    const [hasChanges, setHasChanges] = useState(false);
    const [saveStatus, setSaveStatus] = useState<
        "idle" | "saving" | "saved" | "error"
    >("idle");

    // Check if this is a skill file that can be translated
    const isSkillFile = filePath?.includes("skills/") && filePath?.endsWith("SKILL.md");

    useEffect(() => {
        if (filePath) {
            loadFile(filePath);
        }
    }, [filePath]);

    const loadFile = async (path: string) => {
        setIsLoading(true);
        setSaveStatus("idle");
        try {
            const fileContent = await fetchFile(path);
            setContent(fileContent);
            setOriginalContent(fileContent);
            setHasChanges(false);
        } catch (err) {
            setContent(`// Error loading file: ${err}`);
        }
        setIsLoading(false);
    };

    const handleSave = useCallback(async () => {
        if (!filePath || isSaving) return;
        setIsSaving(true);
        setSaveStatus("saving");
        try {
            await saveFile(filePath, content);
            setOriginalContent(content);
            setHasChanges(false);
            setSaveStatus("saved");
            setTimeout(() => setSaveStatus("idle"), 2000);
        } catch (err) {
            setSaveStatus("error");
        }
        setIsSaving(false);
    }, [filePath, content, isSaving]);

    const handleReset = () => {
        setContent(originalContent);
        setHasChanges(false);
    };

    const handleTranslate = async () => {
        if (isTranslating || !content.trim()) return;

        setIsTranslating(true);
        setTranslateModel("");
        try {
            // Get settings to show which model will be used
            const settings = await fetchSettings();
            const modelName = settings.translate_model || settings.llm_model || "unknown";
            setTranslateModel(modelName);

            const result = await translateContent(content, "zh-CN");
            setContent(result.translated);
            setHasChanges(result.translated !== originalContent);
        } catch (err) {
            console.error("Translation failed:", err);
            alert(`翻译失败: ${err instanceof Error ? err.message : "未知错误"}`);
        } finally {
            setIsTranslating(false);
        }
    };

    const handleEditorChange = (value: string | undefined) => {
        if (value !== undefined) {
            setContent(value);
            setHasChanges(value !== originalContent);
        }
    };

    // Keyboard shortcut
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "s") {
                e.preventDefault();
                handleSave();
            }
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [handleSave]);

    const getLanguage = (path: string) => {
        if (path.endsWith(".md")) return "markdown";
        if (path.endsWith(".json")) return "json";
        if (path.endsWith(".py")) return "python";
        if (path.endsWith(".ts") || path.endsWith(".tsx")) return "typescript";
        if (path.endsWith(".js") || path.endsWith(".jsx")) return "javascript";
        if (path.endsWith(".yaml") || path.endsWith(".yml")) return "yaml";
        return "plaintext";
    };

    if (!filePath) {
        if (debugMode && sessionId) {
            return <DebugPanel sessionId={sessionId} />;
        }
        return (
            <div className="h-full flex items-center justify-center text-center p-6">
                <div className="animate-fade-in-up">
                    <FileText className="w-10 h-10 mx-auto mb-3 text-muted-foreground/30" />
                    <p className="text-sm text-muted-foreground/50">
                        在左侧选择一个文件
                        <br />
                        进行查看或编辑
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-border/50">
                <div className="flex items-center gap-2 min-w-0">
                    <FileText className="w-3.5 h-3.5 text-primary/60 shrink-0" />
                    <span className="text-xs font-medium text-foreground/70 truncate">
                        {filePath}
                    </span>
                    {hasChanges && (
                        <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" />
                    )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                    {/* Translate button for skill files */}
                    {isSkillFile && (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="w-6 h-6 rounded-md text-blue-500 hover:bg-blue-500/10"
                                    onClick={handleTranslate}
                                    disabled={isTranslating}
                                    id="editor-translate-button"
                                >
                                    {isTranslating ? (
                                        <Loader2 className="w-3 h-3 animate-spin" />
                                    ) : (
                                        <Languages className="w-3 h-3" />
                                    )}
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>翻译为中文</TooltipContent>
                        </Tooltip>
                    )}
                    {hasChanges && (
                        <>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="w-6 h-6 rounded-md"
                                        onClick={handleReset}
                                        id="editor-reset-button"
                                    >
                                        <RotateCcw className="w-3 h-3" />
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent>撤销更改</TooltipContent>
                            </Tooltip>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="w-6 h-6 rounded-md text-primary hover:bg-primary/10"
                                        onClick={handleSave}
                                        disabled={isSaving}
                                        id="editor-save-button"
                                    >
                                        <Save className="w-3 h-3" />
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent>保存 (Ctrl+S)</TooltipContent>
                            </Tooltip>
                        </>
                    )}
                    {saveStatus === "saved" && (
                        <span className="text-[10px] text-green-600 font-medium px-1">
                            ✓ 已保存
                        </span>
                    )}
                    {saveStatus === "error" && (
                        <span className="text-[10px] text-destructive font-medium px-1">
                            保存失败
                        </span>
                    )}
                    {debugMode && onClearFile && (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="w-6 h-6 rounded-md text-orange-500 hover:bg-orange-500/10"
                                    onClick={onClearFile}
                                    id="editor-debug-button"
                                >
                                    <Bug className="w-3 h-3" />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>切换到调试面板</TooltipContent>
                        </Tooltip>
                    )}
                    <Button
                        variant="ghost"
                        size="icon"
                        className="w-6 h-6 rounded-md"
                        onClick={onClose}
                        id="editor-close-button"
                    >
                        <X className="w-3 h-3" />
                    </Button>
                </div>
            </div>

            {/* Editor */}
            <div className="flex-1 relative">
                {isLoading ? (
                    <div className="flex items-center justify-center h-full">
                        <div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                    </div>
                ) : (
                    <>
                    {/* Translation loading overlay */}
                    {isTranslating && (
                        <div className="absolute inset-0 bg-background/80 backdrop-blur-sm z-10 flex flex-col items-center justify-center gap-3">
                            <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
                            <span className="text-sm text-muted-foreground">正在翻译中，请稍候...</span>
                            {translateModel && (
                                <span className="text-xs text-muted-foreground/70">
                                    使用模型: <span className="font-mono text-blue-500">{translateModel}</span>
                                </span>
                            )}
                        </div>
                    )}
                    <MonacoEditor
                        height="100%"
                        language={getLanguage(filePath)}
                        value={content}
                        onChange={handleEditorChange}
                        theme="vs"
                        options={{
                            minimap: { enabled: false },
                            fontSize: 13,
                            lineHeight: 20,
                            padding: { top: 12 },
                            wordWrap: "on",
                            fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
                            fontLigatures: true,
                            scrollBeyondLastLine: false,
                            smoothScrolling: true,
                            cursorBlinking: "smooth",
                            cursorSmoothCaretAnimation: "on",
                            renderLineHighlight: "none",
                            overviewRulerLanes: 0,
                            hideCursorInOverviewRuler: true,
                            overviewRulerBorder: false,
                            scrollbar: {
                                vertical: "auto",
                                horizontal: "auto",
                                verticalScrollbarSize: 6,
                                horizontalScrollbarSize: 6,
                            },
                        }}
                    />
                    </>
                )}
            </div>
        </div>
    );
}
