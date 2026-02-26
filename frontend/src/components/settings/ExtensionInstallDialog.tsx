import React, { useState, useEffect } from "react";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Puzzle, Settings, CheckCircle2, RefreshCw } from "lucide-react";
import { fetchHealthStatus } from "@/lib/api";

interface ExtensionInstallDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    isUpgrade?: boolean;
}

export default function ExtensionInstallDialog({
    open,
    onOpenChange,
    isUpgrade = false
}: ExtensionInstallDialogProps) {
    const [extensionPath, setExtensionPath] = useState<string>("正在获取插件路径...");

    useEffect(() => {
        if (open) {
            fetchHealthStatus().then(status => {
                if (status?.extension_path) {
                    setExtensionPath(status.extension_path);
                } else {
                    setExtensionPath("无法获取路径，请确认后端已启动或手动选择 extension 文件夹");
                }
            });
        }
    }, [open]);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[500px]">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Puzzle className="w-5 h-5 text-primary" />
                        {isUpgrade ? "升级 VibeWorker 浏览器插件" : "安装 VibeWorker 浏览器插件"}
                    </DialogTitle>
                    <DialogDescription>
                        {isUpgrade
                            ? "发现新版本的插件。为了体验完整的最新功能，请按照以下步骤完成升级："
                            : "安装插件后，VibeWorker Agent 才能体验完整的功能（例如：填写表单、提取网页内容等）。请按照以下步骤完成安装："
                        }
                    </DialogDescription>
                </DialogHeader>

                {isUpgrade ? (
                    <div className="space-y-6 py-4">
                        <div className="flex gap-4 items-start">
                            <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary/10 text-primary font-semibold shrink-0">
                                1
                            </div>
                            <div className="space-y-2 flex-1">
                                <h4 className="text-sm font-medium">打开扩展程序管理页面</h4>
                                <p className="text-xs text-muted-foreground leading-relaxed">
                                    在 Chrome/Edge 浏览器地址栏输入 <code className="bg-muted px-1 py-0.5 rounded select-all">chrome://extensions/</code> （或 <code className="bg-muted px-1 py-0.5 rounded select-all">edge://extensions/</code>）并回车。
                                </p>
                            </div>
                        </div>

                        <div className="flex gap-4 items-start">
                            <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary/10 text-primary font-semibold shrink-0">
                                2
                            </div>
                            <div className="space-y-2 flex-1">
                                <h4 className="text-sm font-medium flex items-center gap-2">
                                    重新加载扩展程序 <RefreshCw className="w-4 h-4 text-muted-foreground" />
                                </h4>
                                <p className="text-xs text-muted-foreground leading-relaxed">
                                    在页面中找到 <strong>VibeWorker Extension</strong> 插件，点击其卡片右下角的 <strong>刷新 / 重新加载 (Reload)</strong> 图标（一个环形箭头按钮）。
                                </p>
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="space-y-6 py-4">
                        <div className="flex gap-4 items-start">
                            <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary/10 text-primary font-semibold shrink-0">
                                1
                            </div>
                            <div className="space-y-2 flex-1">
                                <h4 className="text-sm font-medium">打开扩展程序管理页面</h4>
                                <p className="text-xs text-muted-foreground leading-relaxed">
                                    在 Chrome/Edge 浏览器地址栏输入 <code className="bg-muted px-1 py-0.5 rounded select-all">chrome://extensions/</code> （或 <code className="bg-muted px-1 py-0.5 rounded select-all">edge://extensions/</code>）并回车。
                                </p>
                            </div>
                        </div>

                        <div className="flex gap-4 items-start">
                            <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary/10 text-primary font-semibold shrink-0">
                                2
                            </div>
                            <div className="space-y-2 flex-1">
                                <h4 className="text-sm font-medium flex items-center gap-2">
                                    启用“开发者模式” <Settings className="w-4 h-4 text-muted-foreground" />
                                </h4>
                                <p className="text-xs text-muted-foreground leading-relaxed">
                                    在扩展程序页面右上角（或左侧），找到并开启 <strong>开发者模式 (Developer mode)</strong> 开关。
                                </p>
                            </div>
                        </div>

                        <div className="flex gap-4 items-start">
                            <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary/10 text-primary font-semibold shrink-0">
                                3
                            </div>
                            <div className="space-y-2 flex-1">
                                <h4 className="text-sm font-medium flex items-center gap-2">
                                    加载已解压的扩展程序 <CheckCircle2 className="w-4 h-4 text-muted-foreground" />
                                </h4>
                                <p className="text-xs text-muted-foreground leading-relaxed">
                                    点击左上角的 <strong>加载已解压的扩展程序 (Load unpacked)</strong> 按钮，然后选择项目中的以下文件夹完成安装：<br />
                                    <code className="bg-muted px-1 py-0.5 rounded mt-1 inline-block select-all" title={extensionPath}>{extensionPath}</code>
                                </p>
                            </div>
                        </div>
                    </div>
                )}

                <div className="flex justify-end gap-2 pt-2 border-t border-border/50">
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        稍后{isUpgrade ? "升级" : "安装"}
                    </Button>
                    <Button onClick={() => onOpenChange(false)}>
                        我已{isUpgrade ? "升级" : "安装"}完成
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
