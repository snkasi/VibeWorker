"use client";

import React, { useState, useEffect, useRef } from "react";
import type { Plan } from "@/lib/api";
import PlanTimeline from "./PlanTimeline";

interface PlanCardProps {
  plan: Plan;
  isLive?: boolean;
  defaultCollapsed?: boolean;
  /** PlanCard 正在淡出 */
  isFadingOut?: boolean;
  /** 淡出完成后的回调 */
  onFadeOutComplete?: () => void;
  /** 审批按钮 */
  awaitingApproval?: boolean;
  onApprove?: (planId: string, approved: boolean) => void;
  /** 步骤时间戳，用于计算耗时 */
  stepTimestamps?: Record<number, number>;
  /** 当前 running 步骤的实时活动描述 */
  stepActivity?: string;
}

export default function PlanCard({
  plan,
  isLive = false,
  defaultCollapsed = false,
  isFadingOut = false,
  onFadeOutComplete,
  awaitingApproval = false,
  onApprove,
  stepTimestamps = {},
  stepActivity,
}: PlanCardProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const autoCollapseRef = useRef(false);

  const completedCount = plan.steps.filter((s) => s.status === "completed").length;
  const failedCount = plan.steps.filter((s) => s.status === "failed").length;
  const totalCount = plan.steps.length;
  const progress = totalCount > 0 ? (completedCount / totalCount) * 100 : 0;
  const allDone = completedCount === totalCount && totalCount > 0;

  // 自动折叠：所有步骤完成后 1.5s 自动折叠（仅 isLive 模式）
  useEffect(() => {
    if (isLive && allDone && !autoCollapseRef.current) {
      autoCollapseRef.current = true;
      const timer = setTimeout(() => {
        setCollapsed(true);
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [isLive, allDone]);

  // 淡出动画完成后的回调
  useEffect(() => {
    if (isFadingOut && onFadeOutComplete) {
      const timer = setTimeout(onFadeOutComplete, 500);
      return () => clearTimeout(timer);
    }
  }, [isFadingOut, onFadeOutComplete]);

  return (
    <div
      className={`plan-card mb-3 rounded-xl border border-border/60 bg-card/80 backdrop-blur-sm shadow-sm overflow-hidden transition-all duration-500 ${
        isFadingOut ? "opacity-0 max-h-0 mb-0 border-transparent" : "opacity-100"
      }`}
    >
      {/* Header — 始终可见，可折叠 */}
      <div
        className={`flex items-center gap-2 px-4 py-2.5 ${
          collapsed ? "" : "border-b border-border/40"
        } bg-muted/30 cursor-pointer select-none hover:bg-muted/50 transition-colors`}
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className="text-base leading-none">&#x1F4CB;</span>
        <span className="text-sm font-semibold text-foreground truncate flex-1">
          {plan.title}
        </span>

        {awaitingApproval && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-300 font-medium animate-pulse">
            &#x23F3; 等待确认
          </span>
        )}

        {/* 迷你进度条 — 折叠时仍可见 */}
        <div className="flex items-center gap-2 ml-auto">
          <div className="w-16 h-1.5 rounded-full bg-muted/60 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ease-out ${
                allDone ? "bg-green-500" : failedCount > 0 ? "bg-red-400" : "bg-[var(--vw-blue)]"
              }`}
              style={{ width: `${progress}%` }}
            />
          </div>
          {allDone ? (
            <span className="text-xs text-green-600 dark:text-green-400 font-medium whitespace-nowrap">&#x2713; 完成</span>
          ) : failedCount > 0 ? (
            <span className="text-xs text-red-500 font-medium tabular-nums whitespace-nowrap">{completedCount}/{totalCount}</span>
          ) : (
            <span className="text-xs text-muted-foreground/60 tabular-nums whitespace-nowrap">{completedCount}/{totalCount}</span>
          )}
          <span className="text-xs text-muted-foreground/40">
            {collapsed ? "▶" : "▼"}
          </span>
        </div>
      </div>

      {/* 可折叠内容 */}
      {!collapsed && (
        <>
          {/* 时间线 */}
          <div className="px-4 py-2.5">
            <PlanTimeline
              steps={plan.steps}
              isLive={isLive}
              stepTimestamps={stepTimestamps}
              stepActivity={stepActivity}
            />
          </div>

          {/* 审批按钮 */}
          {awaitingApproval && onApprove && (
            <div className="px-4 py-2.5 border-t border-border/40 flex items-center gap-2">
              <button
                type="button"
                className="flex-1 py-1.5 px-3 rounded-md text-xs font-medium bg-[var(--vw-blue)] text-white hover:opacity-90 transition-opacity"
                onClick={(e) => {
                  e.stopPropagation();
                  onApprove(plan.plan_id, true);
                }}
              >
                &#x2705; 确认执行
              </button>
              <button
                type="button"
                className="flex-1 py-1.5 px-3 rounded-md text-xs font-medium bg-muted text-muted-foreground hover:bg-muted/80 transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  onApprove(plan.plan_id, false);
                }}
              >
                &#x274C; 取消
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
