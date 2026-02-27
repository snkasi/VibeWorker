"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { Settings, Eye, EyeOff, Loader2, Save, Sun, Moon, Shield, FolderOpen, Zap, Plus, Pencil, Trash2, Bug, Upload, ImageIcon, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
    fetchSettings, updateSettings, type SettingsData,
    fetchModelPool, addPoolModel, updatePoolModel, deletePoolModel,
    updateAssignments, testPoolModel,
    type PoolModel, type ModelPoolData, type TestModelResult,
    checkDockerAvailable,
    fetchBranding, updateBranding, uploadLogo, deleteLogo, getLogoUrl,
    type BrandingData,
} from "@/lib/api";

function SettingsField({
    label,
    value,
    onChange,
    placeholder,
    type = "text",
    secret = false,
}: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
    type?: string;
    secret?: boolean;
}) {
    const [visible, setVisible] = useState(false);

    return (
        <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{label}</label>
            <div className="relative">
                <input
                    type={secret && !visible ? "password" : type}
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder={placeholder}
                    className="w-full h-8 px-3 text-xs rounded-lg border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all font-mono"
                />
                {secret && (
                    <button
                        type="button"
                        onClick={() => setVisible(!visible)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                    >
                        {visible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                )}
            </div>
        </div>
    );
}

function ToggleField({
    label,
    checked,
    onChange,
    hint,
}: {
    label: string;
    checked: boolean;
    onChange: (v: boolean) => void;
    hint?: string;
}) {
    return (
        <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{label}</label>
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={() => onChange(!checked)}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${checked ? "bg-primary" : "bg-border"}`}
                >
                    <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${checked ? "translate-x-4.5" : "translate-x-0.5"}`} />
                </button>
                <span className="text-xs text-muted-foreground">
                    {checked ? "开启" : "关闭"}
                    {hint && (
                        <span className="text-[10px] text-muted-foreground/50 ml-1">
                            {hint}
                        </span>
                    )}
                </span>
            </div>
        </div>
    );
}

function applyTheme(theme: "light" | "dark") {
    if (theme === "dark") {
        document.documentElement.classList.add("dark");
    } else {
        document.documentElement.classList.remove("dark");
    }
    localStorage.setItem("vw-theme", theme);
}

export function initTheme() {
    const saved = localStorage.getItem("vw-theme") as "light" | "dark" | null;
    if (saved) {
        applyTheme(saved);
    }
}

// ============================================
// Helpers
// ============================================
function safeHost(url: string): string {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

// ============================================
// Model Add/Edit Dialog
// ============================================
function ModelFormDialog({
    open,
    onOpenChange,
    editingModel,
    onSaved,
}: {
    open: boolean;
    onOpenChange: (v: boolean) => void;
    editingModel: PoolModel | null;
    onSaved: () => void;
}) {
    const [formData, setFormData] = useState({ name: "", api_key: "", api_base: "", model: "" });
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (open) {
            if (editingModel) {
                setFormData({
                    name: editingModel.name,
                    api_key: editingModel.api_key,
                    api_base: editingModel.api_base,
                    model: editingModel.model,
                });
            } else {
                setFormData({ name: "", api_key: "", api_base: "", model: "" });
            }
        }
    }, [open, editingModel]);

    const handleSubmit = async () => {
        if (!formData.name || !formData.api_key) return;
        setSaving(true);
        try {
            if (editingModel) {
                await updatePoolModel(editingModel.id, formData);
            } else {
                await addPoolModel(formData);
            }
            onOpenChange(false);
            onSaved();
        } catch {
            // ignore
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[400px]">
                <DialogHeader>
                    <DialogTitle className="text-sm">
                        {editingModel ? "编辑模型" : "添加模型"}
                    </DialogTitle>
                    <DialogDescription className="text-xs">
                        {editingModel ? "修改模型配置信息" : "添加一个新的模型配置到模型池"}
                    </DialogDescription>
                </DialogHeader>
                <div className="space-y-3 py-2">
                    <SettingsField
                        label="名称"
                        value={formData.name}
                        onChange={(v) => setFormData(prev => ({ ...prev, name: v }))}
                        placeholder="例如: GPT-4o"
                    />
                    <SettingsField
                        label="API Key"
                        value={formData.api_key}
                        onChange={(v) => setFormData(prev => ({ ...prev, api_key: v }))}
                        placeholder="sk-..."
                        secret
                    />
                    <SettingsField
                        label="API Base URL"
                        value={formData.api_base}
                        onChange={(v) => setFormData(prev => ({ ...prev, api_base: v }))}
                        placeholder="https://api.openai.com/v1"
                    />
                    <SettingsField
                        label="模型名称"
                        value={formData.model}
                        onChange={(v) => setFormData(prev => ({ ...prev, model: v }))}
                        placeholder="gpt-4o"
                    />
                </div>
                <DialogFooter>
                    <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                        取消
                    </Button>
                    <Button
                        size="sm"
                        onClick={handleSubmit}
                        disabled={saving || !formData.name || !formData.api_key}
                        className="gap-1.5"
                    >
                        {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                        {editingModel ? "保存修改" : "添加"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// ============================================
// Model Pool Tab Component
// ============================================
function ModelPoolTab() {
    const [pool, setPool] = useState<ModelPoolData>({ models: [], assignments: {} });
    const [loading, setLoading] = useState(true);
    const [testingId, setTestingId] = useState<string | null>(null);
    const [testResult, setTestResult] = useState<{ id: string; result: TestModelResult } | null>(null);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [editingModel, setEditingModel] = useState<PoolModel | null>(null);
    const [savingAssignment, setSavingAssignment] = useState(false);

    const loadPool = useCallback(async () => {
        try {
            const data = await fetchModelPool();
            setPool(data);
        } catch {
            // ignore
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { loadPool(); }, [loadPool]);

    const handleTest = async (modelId: string) => {
        setTestingId(modelId);
        setTestResult(null);
        try {
            const result = await testPoolModel(modelId);
            setTestResult({ id: modelId, result });
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : "Unknown error";
            setTestResult({ id: modelId, result: { status: "error", message: msg } });
        } finally {
            setTestingId(null);
        }
    };

    const handleDelete = async (modelId: string) => {
        try {
            await deletePoolModel(modelId);
            await loadPool();
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : "Failed to delete";
            alert(msg);
        }
    };

    const handleAssignmentChange = async (scenario: string, modelId: string) => {
        setSavingAssignment(true);
        try {
            await updateAssignments({ [scenario]: modelId });
            setPool(prev => ({
                ...prev,
                assignments: { ...prev.assignments, [scenario]: modelId },
            }));
        } catch {
            // ignore
        } finally {
            setSavingAssignment(false);
        }
    };

    const openAdd = () => {
        setEditingModel(null);
        setDialogOpen(true);
    };

    const openEdit = (m: PoolModel) => {
        setEditingModel(m);
        setDialogOpen(true);
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center py-6">
                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {/* Model Form Dialog */}
            <ModelFormDialog
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                editingModel={editingModel}
                onSaved={loadPool}
            />

            {/* Model Pool List */}
            <div className="space-y-2">
                <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-muted-foreground">模型池</label>
                    <button
                        type="button"
                        onClick={openAdd}
                        className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors"
                    >
                        <Plus className="w-3.5 h-3.5" />
                        添加
                    </button>
                </div>

                <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
                    {pool.models.map((m) => (
                        <div
                            key={m.id}
                            className="flex items-center justify-between p-2 rounded-lg border border-border bg-muted/20 hover:bg-muted/40 transition-colors"
                        >
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5">
                                    <span className="text-xs font-medium truncate">{m.name}</span>
                                </div>
                                <div className="flex items-center gap-2 mt-0.5">
                                    <span className="text-[10px] text-muted-foreground/60 font-mono truncate">
                                        {m.model || "未设置"}
                                    </span>
                                    <span className="text-[10px] text-muted-foreground/40 truncate">
                                        {m.api_base ? safeHost(m.api_base) : ""}
                                    </span>
                                </div>
                                {/* Test result inline */}
                                {testResult && testResult.id === m.id && (
                                    <div className={`mt-1 text-[10px] ${testResult.result.status === "ok"
                                        ? "text-green-600 dark:text-green-400"
                                        : "text-red-600 dark:text-red-400"
                                        }`}>
                                        {testResult.result.status === "ok" ? (testResult.result.reply || `${testResult.result.model} 连接成功`) : testResult.result.message}
                                    </div>
                                )}
                            </div>
                            <div className="flex items-center gap-1 shrink-0 ml-2">
                                <button
                                    type="button"
                                    onClick={() => handleTest(m.id)}
                                    disabled={testingId === m.id}
                                    className="p-1 rounded text-muted-foreground/50 hover:text-primary transition-colors"
                                    title="测试连接"
                                >
                                    {testingId === m.id ? (
                                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    ) : (
                                        <Zap className="w-3.5 h-3.5" />
                                    )}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => openEdit(m)}
                                    className="p-1 rounded text-muted-foreground/50 hover:text-primary transition-colors"
                                    title="编辑"
                                >
                                    <Pencil className="w-3.5 h-3.5" />
                                </button>
                                <button
                                    type="button"
                                    onClick={() => handleDelete(m.id)}
                                    className="p-1 rounded text-muted-foreground/50 hover:text-red-500 transition-colors"
                                    title="删除"
                                >
                                    <Trash2 className="w-3.5 h-3.5" />
                                </button>
                            </div>
                        </div>
                    ))}
                    {pool.models.length === 0 && (
                        <p className="text-xs text-muted-foreground/50 text-center py-3">
                            暂无模型配置，点击「添加」开始
                        </p>
                    )}
                </div>
            </div>

            {/* Scenario Assignments */}
            <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground">场景分配</label>
                {[
                    { key: "llm", label: "主模型" },
                    { key: "embedding", label: "Embedding" },
                    { key: "translate", label: "翻译" },
                ].map(({ key, label }) => (
                    <div key={key} className="flex items-center gap-3">
                        <span className="text-xs text-muted-foreground w-16 shrink-0">{label}</span>
                        <select
                            value={pool.assignments[key as keyof typeof pool.assignments] || ""}
                            onChange={(e) => handleAssignmentChange(key, e.target.value)}
                            disabled={savingAssignment}
                            className="flex-1 h-7 px-2 text-xs rounded-lg border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all"
                        >
                            <option value="">-- 未分配 (使用 .env 回退) --</option>
                            {pool.models.map((m) => (
                                <option key={m.id} value={m.id}>
                                    {m.name} ({m.model})
                                </option>
                            ))}
                        </select>
                    </div>
                ))}
            </div>
        </div>
    );
}

// ============================================
// Docker Sandbox Field (含可用性检测)
// ============================================
function DockerSandboxField({
    checked,
    onChange,
    network,
    onNetworkChange,
}: {
    checked: boolean;
    onChange: (v: boolean) => void;
    network: string;
    onNetworkChange: (v: string) => void;
}) {
    const [dockerStatus, setDockerStatus] = useState<"idle" | "checking" | "available" | "unavailable">("idle");
    const [dockerMessage, setDockerMessage] = useState("");

    // 打开设置时，如果 Docker 已开启，自动检测一次
    useEffect(() => {
        if (checked) {
            checkStatus();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const checkStatus = async () => {
        setDockerStatus("checking");
        try {
            const result = await checkDockerAvailable();
            setDockerStatus(result.available ? "available" : "unavailable");
            setDockerMessage(result.message);
        } catch {
            setDockerStatus("unavailable");
            setDockerMessage("Docker 检测请求失败");
        }
    };

    const handleToggle = async (v: boolean) => {
        if (!v) {
            // 关闭时直接关
            onChange(false);
            setDockerStatus("idle");
            return;
        }
        // 开启时先检测
        setDockerStatus("checking");
        try {
            const result = await checkDockerAvailable();
            if (result.available) {
                setDockerStatus("available");
                setDockerMessage(result.message);
                onChange(true);
            } else {
                setDockerStatus("unavailable");
                setDockerMessage(result.message);
                // 不打开开关
            }
        } catch {
            setDockerStatus("unavailable");
            setDockerMessage("Docker 检测请求失败");
        }
    };

    return (
        <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Docker 沙箱</label>
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={() => handleToggle(!checked)}
                    disabled={dockerStatus === "checking"}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${checked ? "bg-primary" : "bg-border"} ${dockerStatus === "checking" ? "opacity-50" : ""}`}
                >
                    <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${checked ? "translate-x-4.5" : "translate-x-0.5"}`} />
                </button>
                <span className="text-xs text-muted-foreground">
                    {dockerStatus === "checking" ? (
                        <span className="flex items-center gap-1">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            检测中...
                        </span>
                    ) : checked ? "开启" : "关闭"}
                </span>
            </div>
            {/* Docker 状态提示 */}
            {dockerStatus === "available" && (
                <div className="flex items-center gap-1.5 text-[11px] text-green-600 dark:text-green-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                    {dockerMessage}
                </div>
            )}
            {dockerStatus === "unavailable" && (
                <div className="space-y-1">
                    <div className="flex items-center gap-1.5 text-[11px] text-red-600 dark:text-red-400">
                        <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                        {dockerMessage}
                    </div>
                    <p className="text-[10px] text-muted-foreground/60">
                        请先安装 Docker Desktop：
                        <a
                            href="https://docs.docker.com/get-docker/"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary hover:underline ml-1"
                        >
                            安装指南
                        </a>
                    </p>
                </div>
            )}
            {/* Docker 网络选择（仅在开启时显示） */}
            {checked && (
                <div className="space-y-1.5 ml-4">
                    <label className="text-xs font-medium text-muted-foreground">Docker 网络</label>
                    <div className="grid grid-cols-2 gap-2">
                        {[
                            { value: "none", label: "无网络", desc: "完全隔离" },
                            { value: "bridge", label: "桥接", desc: "允许网络" },
                        ].map((net) => (
                            <button
                                key={net.value}
                                type="button"
                                onClick={() => onNetworkChange(net.value)}
                                className={`flex flex-col items-center gap-0.5 py-1.5 rounded-lg border text-xs transition-all ${network === net.value
                                    ? "border-primary bg-primary/10 text-primary"
                                    : "border-border bg-background text-muted-foreground hover:border-primary/30"
                                    }`}
                            >
                                <span className="font-medium">{net.label}</span>
                                <span className="text-[10px] text-muted-foreground/60">{net.desc}</span>
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

export default function SettingsDialog() {
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [debugMode, setDebugMode] = useState(false);
    const [browserMode, setBrowserMode] = useState<"OPEN_TAB" | "OPEN_POPUP">("OPEN_TAB");
    // 品牌设置状态
    const [branding, setBranding] = useState<BrandingData>({ name: "VibeWorker", logo_url: null });
    const [brandingName, setBrandingName] = useState("VibeWorker");
    const [logoPreview, setLogoPreview] = useState<string | null>(null);
    const [uploadingLogo, setUploadingLogo] = useState(false);
    const logoInputRef = useRef<HTMLInputElement>(null);
    const [form, setForm] = useState<SettingsData>({
        openai_api_key: "",
        openai_api_base: "",
        llm_model: "",
        llm_temperature: 0.7,
        llm_max_tokens: 4096,
        embedding_api_key: "",
        embedding_api_base: "",
        embedding_model: "",
        translate_api_key: "",
        translate_api_base: "",
        translate_model: "",
        memory_session_reflect_enabled: true,
        memory_daily_log_days: 2,
        memory_max_prompt_tokens: 4000,
        memory_index_enabled: true,
        memory_implicit_recall_mode: "keyword",
        enable_url_cache: true,
        enable_llm_cache: false,
        enable_prompt_cache: true,
        enable_translate_cache: true,
        mcp_enabled: true,
        plan_enabled: true,
        plan_revision_enabled: true,
        plan_require_approval: false,
        plan_max_steps: 8,
        security_enabled: true,
        security_level: "standard",
        security_approval_timeout: 60,
        security_audit_enabled: true,
        security_ssrf_protection: true,
        security_sensitive_file_protection: true,
        security_python_sandbox: true,
        security_rate_limit_enabled: true,
        security_docker_enabled: false,
        security_docker_network: "none",
        data_dir: "~/.vibeworker/",
        theme: "light",
    });

    useEffect(() => {
        if (open) {
            const savedDebug = localStorage.getItem("vibeworker_debug") === "true";
            setDebugMode(savedDebug);
            const savedBrowserMode = (localStorage.getItem("vibeworker_browser_mode") as "OPEN_TAB" | "OPEN_POPUP") || "OPEN_TAB";
            setBrowserMode(savedBrowserMode);
            setLoading(true);
            // 并行加载设置和品牌数据
            Promise.all([
                fetchSettings(),
                fetchBranding().catch(() => ({ name: "VibeWorker", logo_url: null })),
            ])
                .then(([settingsData, brandingData]) => {
                    const saved = localStorage.getItem("vw-theme") as "light" | "dark" | null;
                    setForm((prev) => ({ ...prev, ...settingsData, theme: saved || settingsData.theme || "light" }));
                    setBranding(brandingData);
                    setBrandingName(brandingData.name);
                    setLogoPreview(brandingData.logo_url ? getLogoUrl(brandingData.logo_url) : null);
                })
                .catch(() => { })
                .finally(() => setLoading(false));
        }
    }, [open]);

    const handleSave = async () => {
        setSaving(true);
        try {
            applyTheme(form.theme || "light");
            // Exclude theme from backend payload (theme is frontend-only, stored in localStorage)
            const { theme: _, ...backendSettings } = form;
            // 并行保存设置和品牌
            await Promise.all([
                updateSettings(backendSettings as SettingsData),
                // 仅当名称有变化时更新品牌
                brandingName !== branding.name ? updateBranding(brandingName) : Promise.resolve(branding),
            ]);
            // 更新本地品牌缓存并触发全局刷新
            if (brandingName !== branding.name) {
                const newBranding = { ...branding, name: brandingName };
                setBranding(newBranding);
                localStorage.setItem("vibeworker_branding", JSON.stringify(newBranding));
                window.dispatchEvent(new CustomEvent("vibeworker-branding-updated"));
            }
            setOpen(false);
        } catch {
            // ignore
        } finally {
            setSaving(false);
        }
    };

    const updateField = useCallback((key: keyof SettingsData, value: string | number | boolean) => {
        setForm((prev) => ({ ...prev, [key]: value }));
    }, []);

    const handleThemeChange = (theme: "light" | "dark") => {
        updateField("theme", theme);
        applyTheme(theme);
    };

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon"
                    className="w-8 h-8 rounded-lg"
                    id="settings-button"
                >
                    <Settings className="w-4 h-4" />
                </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[520px]">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Settings className="w-4 h-4" />
                        设置
                    </DialogTitle>
                    <DialogDescription>
                        通用配置、模型参数和记忆系统。保存后立即生效。
                    </DialogDescription>
                </DialogHeader>

                {loading ? (
                    <div className="flex items-center justify-center py-8">
                        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                    </div>
                ) : (
                    <Tabs defaultValue="general" className="w-full">
                        <TabsList className="grid w-full grid-cols-5 mb-4">
                            <TabsTrigger value="general" className="text-xs">
                                <span className="w-1.5 h-1.5 rounded-full bg-slate-500 mr-1.5" />
                                通用
                            </TabsTrigger>
                            <TabsTrigger value="model" className="text-xs">
                                <span className="w-1.5 h-1.5 rounded-full bg-blue-500 mr-1.5" />
                                模型
                            </TabsTrigger>
                            <TabsTrigger value="memory" className="text-xs">
                                <span className="w-1.5 h-1.5 rounded-full bg-purple-500 mr-1.5" />
                                记忆
                            </TabsTrigger>
                            <TabsTrigger value="cache" className="text-xs">
                                <span className="w-1.5 h-1.5 rounded-full bg-amber-500 mr-1.5" />
                                缓存
                            </TabsTrigger>
                            <TabsTrigger value="security" className="text-xs">
                                <span className="w-1.5 h-1.5 rounded-full bg-red-500 mr-1.5" />
                                安全
                            </TabsTrigger>
                        </TabsList>

                        {/* General Tab */}
                        <TabsContent value="general" className="space-y-4 mt-0 max-h-[60vh] overflow-y-auto pr-1">
                            <div className="space-y-1.5">
                                <label className="text-xs font-medium text-muted-foreground">主题</label>
                                <div className="grid grid-cols-2 gap-2">
                                    <button
                                        type="button"
                                        onClick={() => handleThemeChange("light")}
                                        className={`flex items-center justify-center gap-2 h-9 rounded-lg border text-xs font-medium transition-all ${form.theme === "light"
                                            ? "border-primary bg-primary/10 text-primary"
                                            : "border-border bg-background text-muted-foreground hover:border-primary/30"
                                            }`}
                                    >
                                        <Sun className="w-3.5 h-3.5" />
                                        明亮模式
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => handleThemeChange("dark")}
                                        className={`flex items-center justify-center gap-2 h-9 rounded-lg border text-xs font-medium transition-all ${form.theme === "dark"
                                            ? "border-primary bg-primary/10 text-primary"
                                            : "border-border bg-background text-muted-foreground hover:border-primary/30"
                                            }`}
                                    >
                                        <Moon className="w-3.5 h-3.5" />
                                        暗黑模式
                                    </button>
                                </div>
                            </div>

                            {/* 品牌设置 */}
                            <div className="space-y-3 mt-4 pt-3 border-t border-border/50">
                                <div className="space-y-1.5">
                                    <label className="text-xs font-medium text-muted-foreground">自定义名称</label>
                                    <input
                                        type="text"
                                        value={brandingName}
                                        onChange={(e) => setBrandingName(e.target.value)}
                                        placeholder="VibeWorker"
                                        className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                                    />
                                </div>

                                <div className="space-y-1.5">
                                    <label className="text-xs font-medium text-muted-foreground">自定义 LOGO</label>
                                    <div className="flex items-start gap-3">
                                        {/* LOGO 预览 */}
                                        <div className="w-14 h-14 rounded-lg border border-border bg-muted/30 flex items-center justify-center overflow-hidden shrink-0">
                                            {logoPreview ? (
                                                <img
                                                    src={logoPreview}
                                                    alt="Logo preview"
                                                    className="w-full h-full object-contain"
                                                />
                                            ) : (
                                                <ImageIcon className="w-6 h-6 text-muted-foreground/40" />
                                            )}
                                        </div>

                                        {/* 上传控制 */}
                                        <div className="flex-1 space-y-1.5">
                                            <input
                                                ref={logoInputRef}
                                                type="file"
                                                accept="image/png,image/jpeg,image/svg+xml,image/webp"
                                                className="hidden"
                                                onChange={async (e) => {
                                                    const file = e.target.files?.[0];
                                                    if (!file) return;
                                                    setUploadingLogo(true);
                                                    try {
                                                        const url = await uploadLogo(file);
                                                        const fullUrl = getLogoUrl(url);
                                                        setLogoPreview(fullUrl + "?t=" + Date.now());
                                                        const newBranding = { ...branding, logo_url: url };
                                                        setBranding(newBranding);
                                                        // 更新缓存并触发刷新
                                                        localStorage.setItem("vibeworker_branding", JSON.stringify(newBranding));
                                                        window.dispatchEvent(new CustomEvent("vibeworker-branding-updated"));
                                                    } catch (err) {
                                                        alert(err instanceof Error ? err.message : "上传失败");
                                                    } finally {
                                                        setUploadingLogo(false);
                                                        if (logoInputRef.current) logoInputRef.current.value = "";
                                                    }
                                                }}
                                            />
                                            <div className="flex gap-2">
                                                <Button
                                                    type="button"
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={() => logoInputRef.current?.click()}
                                                    disabled={uploadingLogo}
                                                    className="flex-1 h-8"
                                                >
                                                    {uploadingLogo ? (
                                                        <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                                                    ) : (
                                                        <Upload className="w-3.5 h-3.5 mr-1.5" />
                                                    )}
                                                    上传
                                                </Button>
                                                {logoPreview && (
                                                    <Button
                                                        type="button"
                                                        variant="ghost"
                                                        size="sm"
                                                        onClick={async () => {
                                                            try {
                                                                await deleteLogo();
                                                                setLogoPreview(null);
                                                                const newBranding = { ...branding, logo_url: null };
                                                                setBranding(newBranding);
                                                                localStorage.setItem("vibeworker_branding", JSON.stringify(newBranding));
                                                                window.dispatchEvent(new CustomEvent("vibeworker-branding-updated"));
                                                            } catch (err) {
                                                                alert(err instanceof Error ? err.message : "删除失败");
                                                            }
                                                        }}
                                                        className="h-8 text-destructive hover:text-destructive"
                                                    >
                                                        <X className="w-3.5 h-3.5" />
                                                    </Button>
                                                )}
                                            </div>
                                            <p className="text-[10px] text-muted-foreground">
                                                支持 PNG、JPG、SVG、WebP，最大 2MB
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div className="space-y-1.5 mt-4">
                                <label className="text-xs font-medium text-muted-foreground">浏览器接管模式</label>
                                <div className="grid grid-cols-2 gap-2">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setBrowserMode("OPEN_TAB");
                                            localStorage.setItem("vibeworker_browser_mode", "OPEN_TAB");
                                        }}
                                        className={`flex items-center justify-center gap-2 h-9 rounded-lg border text-xs font-medium transition-all ${browserMode === "OPEN_TAB"
                                            ? "border-primary bg-primary/10 text-primary"
                                            : "border-border bg-background text-muted-foreground hover:border-primary/30"
                                            }`}
                                    >
                                        新标签页 (Tab)
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setBrowserMode("OPEN_POPUP");
                                            localStorage.setItem("vibeworker_browser_mode", "OPEN_POPUP");
                                        }}
                                        className={`flex items-center justify-center gap-2 h-9 rounded-lg border text-xs font-medium transition-all ${browserMode === "OPEN_POPUP"
                                            ? "border-primary bg-primary/10 text-primary"
                                            : "border-border bg-background text-muted-foreground hover:border-primary/30"
                                            }`}
                                    >
                                        独立小窗 (Popup)
                                    </button>
                                </div>
                                <p className="text-[10px] text-muted-foreground/60 mt-1">
                                    大模型在调用浏览器打开网页时，使用的窗口形态。独立小窗更沉浸，新标签页兼容性更好。
                                </p>
                            </div>
                            <div className="space-y-1 mt-4">
                                <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                                    <FolderOpen className="w-3.5 h-3.5" />
                                    数据目录
                                </label>
                                <input
                                    type="text"
                                    value={form.data_dir}
                                    readOnly
                                    placeholder="~/.vibeworker/"
                                    className="w-full h-8 px-3 text-xs rounded-lg border border-border bg-muted text-muted-foreground cursor-not-allowed font-mono"
                                />
                                <p className="text-[10px] text-muted-foreground/60">
                                    所有用户数据（会话、记忆、技能、文件）存储于此，通过环境变量 DATA_DIR 修改
                                </p>
                            </div>
                            <div className="space-y-1">
                                <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                                    <Bug className="w-3.5 h-3.5" />
                                    调试模式
                                </label>
                                <div className="flex items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            const next = !debugMode;
                                            setDebugMode(next);
                                            localStorage.setItem("vibeworker_debug", next ? "true" : "false");
                                            window.dispatchEvent(new CustomEvent("vibeworker-debug-toggle", { detail: next }));
                                        }}
                                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${debugMode ? "bg-primary" : "bg-border"}`}
                                    >
                                        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${debugMode ? "translate-x-4.5" : "translate-x-0.5"}`} />
                                    </button>
                                    <span className="text-xs text-muted-foreground">
                                        {debugMode ? "开启" : "关闭"}
                                        <span className="text-[10px] text-muted-foreground/50 ml-1">
                                            开启后右侧面板显示 LLM/工具调用详情
                                        </span>
                                    </span>
                                </div>
                            </div>
                        </TabsContent>

                        {/* Model Tab — Model Pool */}
                        <TabsContent value="model" className="mt-0 max-h-[60vh] overflow-y-auto pr-1">
                            <ModelPoolTab />
                            {/* Global Parameters */}
                            <div className="space-y-2 mt-4 pt-3 border-t border-border">
                                <label className="text-xs font-medium text-muted-foreground">全局参数</label>
                                <div className="grid grid-cols-2 gap-3">
                                    <SettingsField
                                        label="Temperature"
                                        value={String(form.llm_temperature)}
                                        onChange={(v) => updateField("llm_temperature", parseFloat(v) || 0)}
                                        type="number"
                                    />
                                    <SettingsField
                                        label="Max Tokens"
                                        value={String(form.llm_max_tokens)}
                                        onChange={(v) => updateField("llm_max_tokens", parseInt(v) || 4096)}
                                        type="number"
                                    />
                                </div>
                            </div>
                        </TabsContent>

                        {/* Memory Tab */}
                        <TabsContent value="memory" className="space-y-3 mt-0 max-h-[60vh] overflow-y-auto pr-1">
                            <p className="text-xs text-muted-foreground mb-3">
                                配置记忆系统行为
                            </p>
                            <ToggleField
                                label="会话反省总结"
                                checked={form.memory_session_reflect_enabled}
                                onChange={(v) => updateField("memory_session_reflect_enabled", v)}
                                hint="会话结束后会进行反省和总结（产生额外的 LLM 调用）"
                            />
                            <SettingsField
                                label="短期记忆天数"
                                value={String(form.memory_daily_log_days)}
                                onChange={(v) => updateField("memory_daily_log_days", parseInt(v) || 2)}
                                type="number"
                                placeholder="2"
                            />
                            <p className="text-[10px] text-muted-foreground/60">
                                加载最近几天的工作事项概要
                            </p>
                            <SettingsField
                                label="记忆占用最大 Token 量"
                                value={String(form.memory_max_prompt_tokens)}
                                onChange={(v) => updateField("memory_max_prompt_tokens", parseInt(v) || 4000)}
                                type="number"
                                placeholder="4000"
                            />
                            <div className="space-y-1">
                                <label className="text-xs font-medium text-muted-foreground">隐式召回模式</label>
                                <select
                                    value={form.memory_implicit_recall_mode || "keyword"}
                                    onChange={(e) => updateField("memory_implicit_recall_mode", e.target.value)}
                                    className="w-full h-8 px-3 text-xs rounded-lg border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all"
                                >
                                    <option value="keyword">关键词搜索（轻量，无需 Embedding 模型）</option>
                                    <option value="embedding">向量搜索（更精准，需配置 Embedding 模型）</option>
                                </select>
                                <p className="text-[10px] text-muted-foreground/60">
                                    对话开始时自动召回相关记忆的搜索方式。选择向量搜索时，若 Embedding 模型不可用会自动降级为关键词搜索。
                                </p>
                            </div>
                        </TabsContent>

                        {/* Cache Tab */}
                        <TabsContent value="cache" className="space-y-3 mt-0 max-h-[60vh] overflow-y-auto pr-1">
                            <p className="text-xs text-muted-foreground mb-3">
                                控制各类缓存的开关，关闭后该类型不再写入新缓存
                            </p>
                            <ToggleField
                                label="URL 缓存"
                                checked={form.enable_url_cache}
                                onChange={(v) => updateField("enable_url_cache", v)}
                                hint="(网页请求结果)"
                            />
                            <ToggleField
                                label="LLM 缓存"
                                checked={form.enable_llm_cache}
                                onChange={(v) => updateField("enable_llm_cache", v)}
                                hint="(Agent 响应，默认关闭)"
                            />
                            <ToggleField
                                label="Prompt 缓存"
                                checked={form.enable_prompt_cache}
                                onChange={(v) => updateField("enable_prompt_cache", v)}
                                hint="(System Prompt 拼接)"
                            />
                            <ToggleField
                                label="翻译缓存"
                                checked={form.enable_translate_cache}
                                onChange={(v) => updateField("enable_translate_cache", v)}
                                hint="(翻译 API 结果)"
                            />
                            <ToggleField
                                label="MCP 工具缓存"
                                checked={form.mcp_enabled}
                                onChange={(v) => updateField("mcp_enabled", v)}
                                hint="(MCP Server 连接与工具缓存)"
                            />
                        </TabsContent>

                        {/* Security Tab */}
                        <TabsContent value="security" className="space-y-3 mt-0 max-h-[60vh] overflow-y-auto pr-1">
                            {/* Master Switch */}
                            <div className="flex items-center justify-between p-2.5 rounded-lg border border-border bg-muted/30">
                                <div className="flex items-center gap-2">
                                    <Shield className={`w-4 h-4 ${form.security_enabled ? "text-green-500" : "text-muted-foreground/40"}`} />
                                    <div>
                                        <div className="text-xs font-medium">安全系统总开关</div>
                                        <div className="text-[10px] text-muted-foreground/60">关闭后所有安全功能停用，工具直接执行</div>
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => updateField("security_enabled", !form.security_enabled)}
                                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${form.security_enabled ? "bg-primary" : "bg-border"}`}
                                >
                                    <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${form.security_enabled ? "translate-x-4.5" : "translate-x-0.5"}`} />
                                </button>
                            </div>

                            <div className={`space-y-3 ${!form.security_enabled ? "opacity-40 pointer-events-none" : ""}`}>
                                {/* Security Level */}
                                <div className="space-y-1.5">
                                    <label className="text-xs font-medium text-muted-foreground">安全等级</label>
                                    <div className="grid grid-cols-3 gap-2">
                                        {[
                                            { value: "relaxed", label: "宽松", desc: "全部自动执行" },
                                            { value: "standard", label: "标准", desc: "危险操作需审批" },
                                            { value: "strict", label: "严格", desc: "大部分需审批" },
                                        ].map((level) => (
                                            <button
                                                key={level.value}
                                                type="button"
                                                onClick={() => updateField("security_level", level.value)}
                                                className={`flex flex-col items-center gap-0.5 py-2 rounded-lg border text-xs font-medium transition-all ${form.security_level === level.value
                                                    ? "border-primary bg-primary/10 text-primary"
                                                    : "border-border bg-background text-muted-foreground hover:border-primary/30"
                                                    }`}
                                            >
                                                <Shield className={`w-3.5 h-3.5 ${level.value === "relaxed" ? "text-green-500" :
                                                    level.value === "standard" ? "text-amber-500" : "text-red-500"
                                                    }`} />
                                                <span>{level.label}</span>
                                                <span className="text-[10px] text-muted-foreground/60">{level.desc}</span>
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                {/* Approval Timeout */}
                                <SettingsField
                                    label="审批超时 (秒)"
                                    value={String(form.security_approval_timeout)}
                                    onChange={(v) => updateField("security_approval_timeout", parseFloat(v) || 60)}
                                    type="number"
                                    placeholder="60"
                                />

                                {/* Sub-feature Toggles */}
                                <div className="space-y-1.5">
                                    <label className="text-xs font-medium text-muted-foreground">安全子功能</label>
                                    <div className="space-y-1">
                                        {[
                                            { key: "security_python_sandbox" as const, label: "Python 沙箱", hint: "限制危险 import 和 builtins" },
                                            { key: "security_ssrf_protection" as const, label: "SSRF 防护", hint: "阻止访问内网地址" },
                                            { key: "security_sensitive_file_protection" as const, label: "敏感文件保护", hint: "阻止读取 .env / .key 等" },
                                            { key: "security_rate_limit_enabled" as const, label: "工具调用限速", hint: "滑动窗口限制频率" },
                                            { key: "security_audit_enabled" as const, label: "审计日志", hint: "记录所有工具执行" },
                                        ].map((item) => (
                                            <div key={item.key} className="flex items-center justify-between py-1.5 px-2 rounded-md hover:bg-muted/30 transition-colors">
                                                <div>
                                                    <span className="text-xs">{item.label}</span>
                                                    <span className="text-[10px] text-muted-foreground/50 ml-1.5">{item.hint}</span>
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={() => updateField(item.key, !form[item.key])}
                                                    className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${form[item.key] ? "bg-primary" : "bg-border"}`}
                                                >
                                                    <span className={`inline-block h-2.5 w-2.5 transform rounded-full bg-white transition-transform ${form[item.key] ? "translate-x-3.5" : "translate-x-0.5"}`} />
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                {/* Docker Sandbox */}
                                <DockerSandboxField
                                    checked={form.security_docker_enabled}
                                    onChange={(v) => updateField("security_docker_enabled", v)}
                                    network={form.security_docker_network}
                                    onNetworkChange={(v) => updateField("security_docker_network", v)}
                                />
                            </div>
                        </TabsContent>
                    </Tabs>
                )}

                <DialogFooter>
                    <Button
                        onClick={handleSave}
                        disabled={saving || loading}
                        size="sm"
                        className="gap-1.5"
                    >
                        {saving ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                            <Save className="w-3.5 h-3.5" />
                        )}
                        保存配置
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
