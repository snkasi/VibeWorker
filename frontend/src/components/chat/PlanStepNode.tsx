"use client";

import React from "react";
import type { PlanStep } from "@/lib/api";

interface PlanStepNodeProps {
  step: PlanStep;
  isLast: boolean;
  isLive?: boolean;
  /** 步骤耗时（秒），仅 completed 步骤可用 */
  duration?: number;
  /** 是否被 replanner 调整过 */
  isRevised?: boolean;
  /** running 步骤的实时活动描述（如 "🌐 获取网页 sina.com..."） */
  activity?: string;
}

/** 步骤圆点 — 4 种状态对应不同样式 */
function StepCircle({ status, isLive }: { status: string; isLive?: boolean }) {
  switch (status) {
    case "completed":
      return (
        <div className="relative w-5 h-5 rounded-full bg-green-500 flex items-center justify-center shrink-0">
          <svg className="w-3 h-3 text-white animate-check" viewBox="0 0 12 12" fill="none">
            <path d="M2.5 6L5 8.5L9.5 3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      );
    case "running":
      return (
        <div className="relative w-5 h-5 flex items-center justify-center shrink-0">
          {isLive && (
            <span className="absolute inset-0 rounded-full bg-blue-500/30 animate-ping" />
          )}
          <div className="w-3.5 h-3.5 rounded-full bg-blue-500" />
        </div>
      );
    case "failed":
      return (
        <div className="relative w-5 h-5 rounded-full bg-red-500 flex items-center justify-center shrink-0">
          <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none">
            <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </div>
      );
    default: // pending
      return (
        <div className="w-5 h-5 flex items-center justify-center shrink-0">
          <div className="w-3.5 h-3.5 rounded-full border-2 border-muted-foreground/30" />
        </div>
      );
  }
}

/** 连接线 — 连接相邻步骤 */
function ConnectorLine({ status }: { status: string }) {
  const color = status === "completed"
    ? "bg-green-500/40"
    : "bg-muted-foreground/15";
  return <div className={`w-0.5 flex-1 min-h-3 ${color} transition-colors duration-300`} />;
}

export default function PlanStepNode({
  step,
  isLast,
  isLive,
  duration,
  isRevised,
  activity,
}: PlanStepNodeProps) {
  return (
    <div className="flex gap-3">
      {/* 左侧：圆点 + 连接线 */}
      <div className="flex flex-col items-center">
        <StepCircle status={step.status} isLive={isLive} />
        {!isLast && <ConnectorLine status={step.status} />}
      </div>

      {/* 右侧：标题 + 活动描述（填充中间） + 状态图标 */}
      <div className={`pb-3 flex-1 min-w-0 flex items-start gap-2 ${isLast ? "pb-0" : ""}`}>
        <span className={`text-sm leading-5 shrink-0 ${
          step.status === "completed"
            ? "text-muted-foreground"
            : step.status === "running"
            ? "text-foreground font-medium"
            : "text-muted-foreground/60"
        }`}>
          {step.title}
        </span>
        {/* 活动描述：自适应填充标题和右侧图标之间的空间 */}
        {step.status === "running" && isLive && activity && (
          <span className="flex-1 min-w-0 text-xs leading-5 text-blue-500/70 truncate animate-pulse-soft">
            {activity}
          </span>
        )}
        <span className="shrink-0 text-xs leading-5 tabular-nums ml-auto">
          {step.status === "completed" && duration != null && (
            <span className="text-green-600 dark:text-green-400">
              &#x2713; {duration < 1 ? `${(duration * 1000).toFixed(0)}ms` : `${duration.toFixed(1)}s`}
            </span>
          )}
          {step.status === "running" && isLive && (
            <span className="text-blue-500 animate-pulse-soft">&#x23F3;</span>
          )}
          {step.status === "failed" && (
            <span className="text-red-500">&#x274C; 失败</span>
          )}
        </span>
        {isRevised && (
          <span className="text-[10px] px-1 py-0.5 rounded bg-orange-100 dark:bg-orange-950 text-orange-600 dark:text-orange-400 shrink-0">
            &#x1F504; 已调整
          </span>
        )}
      </div>
    </div>
  );
}
