"use client";

import { useState, useEffect, useRef } from "react";

interface TypewriterProps {
  /** 目标文本（可能持续增长） */
  text: string;
  /** 每个字符的显示间隔（毫秒），默认 20ms */
  speed?: number;
  /** 是否正在流式输入中（用于判断是否继续动画） */
  isStreaming?: boolean;
  /** 渲染函数，接收当前应显示的文本 */
  children: (displayText: string) => React.ReactNode;
}

/**
 * 打字机效果组件
 *
 * 即使后端一次性返回多个字符，前端也会逐字显示，营造流畅的打字效果。
 *
 * 原理：
 * 1. 维护当前显示的字符位置 (displayIndex)
 * 2. 当目标文本增长时，用定时器逐步追赶
 * 3. 通过 render prop 模式将当前显示文本传递给子组件
 */
export function Typewriter({
  text,
  speed = 20,
  isStreaming = true,
  children,
}: TypewriterProps) {
  // 当前显示到的字符索引
  const [displayIndex, setDisplayIndex] = useState(0);
  // 记录上一次的文本长度，用于检测文本增长
  const prevLengthRef = useRef(0);
  // 定时器引用
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // 清理之前的定时器
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    // 如果当前显示位置已经追上目标文本，无需动画
    if (displayIndex >= text.length) {
      return;
    }

    // 启动定时器，逐字追赶目标文本
    timerRef.current = setInterval(() => {
      setDisplayIndex((prev) => {
        const next = prev + 1;
        // 如果已经显示完毕，停止定时器
        if (next >= text.length) {
          if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
          }
        }
        return next;
      });
    }, speed);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [text.length, speed]); // 当文本长度变化时重新启动追赶

  // 当不再流式输入时，立即显示全部内容
  useEffect(() => {
    if (!isStreaming && displayIndex < text.length) {
      setDisplayIndex(text.length);
    }
  }, [isStreaming, text.length, displayIndex]);

  // 更新上一次文本长度记录
  useEffect(() => {
    prevLengthRef.current = text.length;
  }, [text.length]);

  // 计算当前应显示的文本
  const displayText = text.slice(0, displayIndex);

  return <>{children(displayText)}</>;
}

export default Typewriter;
