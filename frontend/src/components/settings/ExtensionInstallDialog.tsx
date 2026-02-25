import React from "react";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Download, Puzzle, Settings, CheckCircle2 } from "lucide-react";

interface ExtensionInstallDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export default function ExtensionInstallDialog({
    open,
    onOpenChange,
}: ExtensionInstallDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[500px]">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Puzzle className="w-5 h-5 text-primary" />
                        安装 VibeWorker 浏览器插件
                    </DialogTitle>
                    <DialogDescription>
                        安装插件后，VibeWorker Agent 才能够自主操作浏览器（例如：打开新标签页、填写表单、提取网页内容等）。请按照以下步骤完成安装：
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-6 py-4">
                    <div className="flex gap-4 items-start">
                        <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary/10 text-primary font-semibold shrink-0">
                            1
                        </div>
                        <div className="space-y-2 flex-1">
                            <h4 className="text-sm font-medium">下载插件源码</h4>
                            <p className="text-xs text-muted-foreground leading-relaxed">
                                插件代码位于项目的 <code className="bg-muted px-1 py-0.5 rounded">extension</code> 目录中。如果您尚未克隆代码，可以点击下方按钮下载（如适用），或者直接在您的本地代码库中找到该目录。
                            </p>
                        </div>
                    </div>

                    <div className="flex gap-4 items-start">
                        <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary/10 text-primary font-semibold shrink-0">
                            2
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
                            3
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
                            4
                        </div>
                        <div className="space-y-2 flex-1">
                            <h4 className="text-sm font-medium flex items-center gap-2">
                                加载已解压的扩展程序 <CheckCircle2 className="w-4 h-4 text-muted-foreground" />
                            </h4>
                            <p className="text-xs text-muted-foreground leading-relaxed">
                                点击左上角的 <strong>加载已解压的扩展程序 (Load unpacked)</strong> 按钮，然后选择项目中的 <code className="bg-muted px-1 py-0.5 rounded">extension</code> 文件夹完成安装即可。
                            </p>
                        </div>
                    </div>
                </div>

                <div className="flex justify-end gap-2 pt-2 border-t border-border/50">
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        稍后安装
                    </Button>
                    <Button onClick={() => onOpenChange(false)}>
                        我已安装完成
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
