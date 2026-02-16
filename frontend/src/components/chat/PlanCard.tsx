"use client";

import React, { useState } from "react";
import type { Plan } from "@/lib/api";

interface PlanCardProps {
  plan: Plan;
  isLive?: boolean;
  defaultCollapsed?: boolean;
}

function StepIcon({ status, isLive }: { status: string; isLive?: boolean }) {
  switch (status) {
    case "completed":
      return <span className="text-green-500 text-sm leading-none">&#x2705;</span>;
    case "running":
      return (
        <span className={`text-amber-500 text-sm leading-none ${isLive ? "animate-pulse-soft" : ""}`}>
          &#x23F3;
        </span>
      );
    case "failed":
      return <span className="text-red-500 text-sm leading-none">&#x274C;</span>;
    default:
      return (
        <span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-muted-foreground/30 flex-shrink-0" />
      );
  }
}

export default function PlanCard({ plan, isLive = false, defaultCollapsed = false }: PlanCardProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const completedCount = plan.steps.filter((s) => s.status === "completed").length;
  const failedCount = plan.steps.filter((s) => s.status === "failed").length;
  const totalCount = plan.steps.length;
  const progress = totalCount > 0 ? (completedCount / totalCount) * 100 : 0;
  const allDone = completedCount === totalCount && totalCount > 0;

  return (
    <div className="plan-card mb-3 rounded-xl border border-border/60 bg-card/80 backdrop-blur-sm shadow-sm overflow-hidden">
      {/* Header — always visible, clickable to toggle */}
      <div
        className={`flex items-center gap-2 px-4 py-2.5 ${collapsed ? "" : "border-b border-border/40"} bg-muted/30 cursor-pointer select-none hover:bg-muted/50 transition-colors`}
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className="text-base leading-none">&#x1F4CB;</span>
        <span className="text-sm font-semibold text-foreground truncate">
          {plan.title}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {allDone ? (
            <span className="text-xs text-green-600 font-medium">&#x2705; 已完成</span>
          ) : failedCount > 0 ? (
            <span className="text-xs text-red-500 font-medium">{completedCount}/{totalCount}</span>
          ) : (
            <span className="text-xs text-muted-foreground/60 tabular-nums">{completedCount}/{totalCount}</span>
          )}
          <span className="text-xs text-muted-foreground/40">
            {collapsed ? "▶" : "▼"}
          </span>
        </span>
      </div>

      {/* Collapsible body */}
      {!collapsed && (
        <>
          {/* Steps */}
          <div className="px-4 py-2.5 space-y-1.5">
            {plan.steps.map((step) => (
              <div
                key={step.id}
                className={`flex items-center gap-2.5 py-1 text-sm transition-opacity ${
                  step.status === "completed"
                    ? "text-muted-foreground"
                    : step.status === "running"
                    ? "text-foreground font-medium"
                    : "text-muted-foreground/70"
                }`}
              >
                <StepIcon status={step.status} isLive={isLive} />
                <span className="truncate">
                  {step.id}. {step.title}
                </span>
              </div>
            ))}
          </div>

          {/* Progress Bar */}
          <div className="px-4 pb-3 pt-1">
            <div className="flex items-center gap-2">
              <div className="flex-1 h-1.5 rounded-full bg-muted/60 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ease-out ${
                    allDone ? "bg-green-500" : "bg-[var(--vw-blue)]"
                  }`}
                  style={{ width: `${progress}%` }}
                />
              </div>
              <span className="text-xs text-muted-foreground/60 tabular-nums whitespace-nowrap">
                {completedCount}/{totalCount}
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
