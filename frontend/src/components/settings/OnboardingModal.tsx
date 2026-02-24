"use client";

import React, { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, Zap, Rocket, Key, Link2, Box } from "lucide-react";
import {
    testPoolModel,
    addPoolModel,
    fetchModelPool,
    updateAssignments,
} from "@/lib/api";

function SettingsField({
    label,
    value,
    onChange,
    placeholder,
    icon: Icon,
    type = "text",
    secret = false,
}: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
    icon?: React.ElementType;
    type?: string;
    secret?: boolean;
}) {
    const [visible, setVisible] = useState(false);

    return (
        <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                {Icon && <Icon className="w-3.5 h-3.5" />}
                {label}
            </label>
            <div className="relative">
                <input
                    type={secret && !visible ? "password" : type}
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder={placeholder}
                    className="w-full h-9 px-3 text-xs rounded-lg border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all font-mono"
                />
                {secret && (
                    <button
                        type="button"
                        onClick={() => setVisible(!visible)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground transition-colors text-[10px] font-medium px-1.5 py-0.5 rounded hover:bg-muted"
                    >
                        {visible ? "隐藏" : "显示"}
                    </button>
                )}
            </div>
        </div>
    );
}

interface OnboardingModalProps {
    open: boolean;
    onSuccess: (isConfigured: boolean) => void;
}

export default function OnboardingModal({ open, onSuccess }: OnboardingModalProps) {
    const [formData, setFormData] = useState({
        name: "My Model",
        api_key: "",
        api_base: "https://api.openai.com/v1",
        model: "gpt-4o",
    });
    const [testing, setTesting] = useState(false);
    const [errorMsg, setErrorMsg] = useState("");
    const [successMsg, setSuccessMsg] = useState("");

    const handleSubmit = async () => {
        if (!formData.api_key || !formData.model || !formData.api_base) {
            setErrorMsg("请填写完整配置");
            return;
        }

        setTesting(true);
        setErrorMsg("");
        setSuccessMsg("");

        try {
            // 1. 先进行接口测试，使用直接参数调用（这里需要调整 API 接口以支持直接传参）
            // 我们不能在此使用 testPoolModel，因为模型还没在池子里。我们需要调用底层的测试端点。
            const res = await fetch("http://localhost:8088/api/settings/test", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    api_key: formData.api_key,
                    api_base: formData.api_base,
                    model: formData.model,
                    model_type: "llm"
                }),
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.detail || "测试连接失败");
            }

            const testResult = await res.json();
            if (testResult.status !== "ok") {
                throw new Error(testResult.message || "模型连接测试失败");
            }

            setSuccessMsg("连接成功！正在保存配置...");

            // 2. 测试通过，加入模型池
            const newModelRes = await fetch("http://localhost:8088/api/model-pool", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: formData.name,
                    api_key: formData.api_key,
                    api_base: formData.api_base,
                    model: formData.model,
                }),
            });
            if (!newModelRes.ok) {
                throw new Error("保存模型失败");
            }

            // 为了获取生成的ID，我们需要拉取刚刚创建的 pool。
            // 最好是上面那个返回 ID，当前设计返回的是 ok 状态。
            const poolData = await fetchModelPool();
            // 找到刚加的模型（根据精确配置匹配）
            const createdModel = poolData.models.find(m =>
                m.api_base === formData.api_base && m.model === formData.model && m.name === formData.name
            );

            if (createdModel) {
                await updateAssignments({ llm: createdModel.id });
            }

            // 完成！通知父组件关闭 (并标识配置完成需要刷新)
            setSuccessMsg("配置完成！即将进入系统...");
            setTimeout(() => {
                onSuccess(true);
            }, 800);

        } catch (e: any) {
            setErrorMsg(e.message || "发生未知错误");
        } finally {
            setTesting(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={(isOpen) => {
            if (!isOpen) onSuccess(false); // 允许用户点击外部或 ESC 跳过
        }}>
            <DialogContent
                className="sm:max-w-[460px] p-0 overflow-hidden border-0 shadow-2xl [&>button]:hidden"
            >
                {/* 顶部科技灰背景替代渐变 */}
                <div className="h-28 w-full bg-slate-100 dark:bg-slate-900 border-b border-border/40 relative flex items-center justify-center">
                    <div className="absolute inset-0 bg-grid-slate-200/50 dark:bg-grid-white/[0.02] bg-[size:20px_20px]" />
                    <div className="w-14 h-14 bg-white dark:bg-slate-800 rounded-2xl flex items-center justify-center shadow-sm border border-border relative z-10">
                        <img src="/logo.png" alt="Logo" className="w-8 h-8 opacity-90 dark:invert" />
                    </div>
                </div>

                <div className="p-6 pt-5 bg-card">
                    <DialogHeader className="mb-5 text-center">
                        <DialogTitle className="text-lg font-semibold tracking-tight">
                            欢迎使用 VibeWorker
                        </DialogTitle>
                        <DialogDescription className="text-xs">
                            系统检测到您尚未配置主大语言模型。请填入您的配置信息以启动智能引擎。
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-4">
                        <div className="grid grid-cols-2 gap-3">
                            <SettingsField
                                label="模型名称"
                                value={formData.model}
                                onChange={(v) => setFormData(p => ({ ...p, model: v }))}
                                placeholder="如: gpt-4o, claude-3-5-sonnet"
                                icon={Box}
                            />
                            <SettingsField
                                label="配置备注"
                                value={formData.name}
                                onChange={(v) => setFormData(p => ({ ...p, name: v }))}
                                placeholder="如: 我的 OpenAI"
                            />
                        </div>

                        <SettingsField
                            label="API Base URL"
                            value={formData.api_base}
                            onChange={(v) => setFormData(p => ({ ...p, api_base: v }))}
                            placeholder="如: https://api.openai.com/v1"
                            icon={Link2}
                        />

                        <SettingsField
                            label="API Key"
                            value={formData.api_key}
                            onChange={(v) => setFormData(p => ({ ...p, api_key: v }))}
                            placeholder="sk-..."
                            secret
                            icon={Key}
                        />

                        {errorMsg && (
                            <div className="px-3 py-2 rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 text-xs text-red-600 dark:text-red-400 flex items-center gap-2">
                                <div className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
                                <span className="flex-1">{errorMsg}</span>
                            </div>
                        )}

                        {successMsg && (
                            <div className="px-3 py-2 rounded-lg bg-green-50 dark:bg-green-500/10 border border-green-200 dark:border-green-500/20 text-xs text-green-600 dark:text-green-400 flex items-center gap-2">
                                <span className="relative flex h-2 w-2 mr-1">
                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                                    <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                                </span>
                                <span>{successMsg}</span>
                            </div>
                        )}

                        <div className="pt-2 flex flex-col gap-2">
                            <Button
                                className="w-full h-10 gap-2 shadow-sm font-medium transition-all"
                                onClick={handleSubmit}
                                disabled={testing || !!successMsg}
                            >
                                {testing ? (
                                    <>
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        正在验证网络连通性...
                                    </>
                                ) : successMsg ? (
                                    <>
                                        <Zap className="w-4 h-4" />
                                        验证通过
                                    </>
                                ) : (
                                    <>
                                        <Zap className="w-4 h-4" />
                                        验证并启动应用
                                    </>
                                )}
                            </Button>

                            <Button
                                variant="ghost"
                                className="w-full h-9 text-xs text-muted-foreground hover:text-foreground"
                                onClick={() => onSuccess(false)}
                                disabled={testing || !!successMsg}
                            >
                                稍后配置
                            </Button>
                        </div>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
