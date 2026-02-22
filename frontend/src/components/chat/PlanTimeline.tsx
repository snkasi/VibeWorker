"use client";

import React from "react";
import type { PlanStep } from "@/lib/api";
import PlanStepNode from "./PlanStepNode";

interface PlanTimelineProps {
  steps: PlanStep[];
  isLive?: boolean;
  /** 步骤开始时间戳（key: step_id, value: timestamp ms） */
  stepTimestamps?: Record<number, number>;
  /** 当前 running 步骤的实时活动描述 */
  stepActivity?: string;
}

/** 计算步骤耗时（秒） */
function getStepDuration(
  step: PlanStep,
  steps: PlanStep[],
  timestamps: Record<number, number>
): number | undefined {
  if (step.status !== "completed") return undefined;
  const startTs = timestamps[step.id];
  if (!startTs) return undefined;

  // 结束时间 = 下一步的开始时间，或当前时间
  const currentIdx = steps.findIndex((s) => s.id === step.id);
  const nextStep = steps[currentIdx + 1];
  const endTs = nextStep && timestamps[nextStep.id]
    ? timestamps[nextStep.id]
    : Date.now();

  return (endTs - startTs) / 1000;
}

export default function PlanTimeline({
  steps,
  isLive,
  stepTimestamps = {},
  stepActivity,
}: PlanTimelineProps) {
  return (
    <div className="py-1">
      {steps.map((step, idx) => (
        <PlanStepNode
          key={step.id}
          step={step}
          isLast={idx === steps.length - 1}
          isLive={isLive}
          duration={getStepDuration(step, steps, stepTimestamps)}
          isRevised={!!(step as PlanStep & { _revised?: boolean })._revised}
          activity={step.status === "running" ? stepActivity : undefined}
        />
      ))}
    </div>
  );
}
