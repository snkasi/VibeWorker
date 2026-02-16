"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Settings, Eye, EyeOff, Loader2, Save, Sun, Moon, Shield, FolderOpen } from "lucide-react";
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
import { fetchSettings, updateSettings, type SettingsData } from "@/lib/api";

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

export default function SettingsDialog() {
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
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
        memory_auto_extract: false,
        memory_daily_log_days: 2,
        memory_max_prompt_tokens: 4000,
        memory_index_enabled: true,
        enable_url_cache: true,
        enable_llm_cache: false,
        enable_prompt_cache: true,
        enable_translate_cache: true,
        mcp_enabled: true,
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
            setLoading(true);
            fetchSettings()
                .then((data) => {
                    const saved = localStorage.getItem("vw-theme") as "light" | "dark" | null;
                    // Merge: keep form defaults as fallback for any missing fields from backend
                    setForm((prev) => ({ ...prev, ...data, theme: saved || data.theme || "light" }));
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
            await updateSettings(backendSettings as SettingsData);
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
                        通用配置、模型参数和记忆系统。保存后部分配置需重启后端生效。
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
                        <TabsContent value="general" className="space-y-4 mt-0">
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
                            <div className="space-y-1">
                                <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                                    <FolderOpen className="w-3.5 h-3.5" />
                                    数据目录
                                </label>
                                <input
                                    type="text"
                                    value={form.data_dir}
                                    onChange={(e) => updateField("data_dir", e.target.value)}
                                    placeholder="~/.vibeworker/"
                                    className="w-full h-8 px-3 text-xs rounded-lg border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all font-mono"
                                />
                                <p className="text-[10px] text-muted-foreground/60">
                                    所有用户数据（会话、记忆、技能、文件）存储于此，修改后需重启后端生效
                                </p>
                            </div>
                        </TabsContent>

                        {/* Model Tab */}
                        <TabsContent value="model" className="mt-0">
                            <Tabs defaultValue="llm" className="w-full">
                                <TabsList className="grid w-full grid-cols-3 mb-3 h-8">
                                    <TabsTrigger value="llm" className="text-[11px] h-6">
                                        <span className="w-1 h-1 rounded-full bg-blue-500 mr-1" />
                                        主模型
                                    </TabsTrigger>
                                    <TabsTrigger value="embedding" className="text-[11px] h-6">
                                        <span className="w-1 h-1 rounded-full bg-emerald-500 mr-1" />
                                        Embedding
                                    </TabsTrigger>
                                    <TabsTrigger value="translate" className="text-[11px] h-6">
                                        <span className="w-1 h-1 rounded-full bg-orange-500 mr-1" />
                                        翻译
                                    </TabsTrigger>
                                </TabsList>

                                {/* LLM Sub-tab */}
                                <TabsContent value="llm" className="space-y-3 mt-0">
                                    <SettingsField
                                        label="API Key"
                                        value={form.openai_api_key}
                                        onChange={(v) => updateField("openai_api_key", v)}
                                        placeholder="sk-..."
                                        secret
                                    />
                                    <SettingsField
                                        label="API Base URL"
                                        value={form.openai_api_base}
                                        onChange={(v) => updateField("openai_api_base", v)}
                                        placeholder="https://api.openai.com/v1"
                                    />
                                    <SettingsField
                                        label="模型名称"
                                        value={form.llm_model}
                                        onChange={(v) => updateField("llm_model", v)}
                                        placeholder="gpt-4o"
                                    />
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
                                </TabsContent>

                                {/* Embedding Sub-tab */}
                                <TabsContent value="embedding" className="space-y-3 mt-0">
                                    <p className="text-xs text-muted-foreground mb-3">
                                        留空则自动复用主模型的 API 配置
                                    </p>
                                    <SettingsField
                                        label="API Key"
                                        value={form.embedding_api_key}
                                        onChange={(v) => updateField("embedding_api_key", v)}
                                        placeholder="留空复用主模型"
                                        secret
                                    />
                                    <SettingsField
                                        label="API Base URL"
                                        value={form.embedding_api_base}
                                        onChange={(v) => updateField("embedding_api_base", v)}
                                        placeholder="留空复用主模型"
                                    />
                                    <SettingsField
                                        label="模型名称"
                                        value={form.embedding_model}
                                        onChange={(v) => updateField("embedding_model", v)}
                                        placeholder="text-embedding-3-small"
                                    />
                                </TabsContent>

                                {/* Translate Sub-tab */}
                                <TabsContent value="translate" className="space-y-3 mt-0">
                                    <p className="text-xs text-muted-foreground mb-3">
                                        留空则自动复用主模型，可配置更轻量的模型用于翻译
                                    </p>
                                    <SettingsField
                                        label="API Key"
                                        value={form.translate_api_key}
                                        onChange={(v) => updateField("translate_api_key", v)}
                                        placeholder="留空复用主模型"
                                        secret
                                    />
                                    <SettingsField
                                        label="API Base URL"
                                        value={form.translate_api_base}
                                        onChange={(v) => updateField("translate_api_base", v)}
                                        placeholder="留空复用主模型"
                                    />
                                    <SettingsField
                                        label="模型名称"
                                        value={form.translate_model}
                                        onChange={(v) => updateField("translate_model", v)}
                                        placeholder="gpt-4o-mini"
                                    />
                                </TabsContent>
                            </Tabs>
                        </TabsContent>

                        {/* Memory Tab */}
                        <TabsContent value="memory" className="space-y-3 mt-0">
                            <p className="text-xs text-muted-foreground mb-3">
                                配置记忆系统行为，包括自动提取和日志注入
                            </p>
                            <ToggleField
                                label="自动提取记忆"
                                checked={form.memory_auto_extract}
                                onChange={(v) => updateField("memory_auto_extract", v)}
                                hint="(会产生额外 LLM 调用)"
                            />
                            <ToggleField
                                label="语义搜索索引"
                                checked={form.memory_index_enabled}
                                onChange={(v) => updateField("memory_index_enabled", v)}
                            />
                            <SettingsField
                                label="日志加载天数"
                                value={String(form.memory_daily_log_days)}
                                onChange={(v) => updateField("memory_daily_log_days", parseInt(v) || 2)}
                                type="number"
                                placeholder="2"
                            />
                            <SettingsField
                                label="记忆 Token 预算"
                                value={String(form.memory_max_prompt_tokens)}
                                onChange={(v) => updateField("memory_max_prompt_tokens", parseInt(v) || 4000)}
                                type="number"
                                placeholder="4000"
                            />
                        </TabsContent>

                        {/* Cache Tab */}
                        <TabsContent value="cache" className="space-y-3 mt-0">
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
                        <TabsContent value="security" className="space-y-3 mt-0">
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
                                                className={`flex flex-col items-center gap-0.5 py-2 rounded-lg border text-xs font-medium transition-all ${
                                                    form.security_level === level.value
                                                        ? "border-primary bg-primary/10 text-primary"
                                                        : "border-border bg-background text-muted-foreground hover:border-primary/30"
                                                }`}
                                            >
                                                <Shield className={`w-3.5 h-3.5 ${
                                                    level.value === "relaxed" ? "text-green-500" :
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
                                <div className="space-y-1.5">
                                    <ToggleField
                                        label="Docker 沙箱"
                                        checked={form.security_docker_enabled}
                                        onChange={(v) => updateField("security_docker_enabled", v)}
                                        hint="(需安装 Docker，可选)"
                                    />
                                    {form.security_docker_enabled && (
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
                                                        onClick={() => updateField("security_docker_network", net.value)}
                                                        className={`flex flex-col items-center gap-0.5 py-1.5 rounded-lg border text-xs transition-all ${
                                                            form.security_docker_network === net.value
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
