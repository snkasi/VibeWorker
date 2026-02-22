import { useSyncExternalStore, useEffect, useCallback } from "react";
import { streamChat, fetchSessionMessages, sendApproval, sendPlanApproval, type ChatMessage, type ToolCall, type MessageSegment, type Plan, type PlanStep, type PlanRevision, type DebugLLMCall, type DebugToolCall, type DebugDivider, type DebugCall, type SSEEvent } from "./api";

// Helper to check if a debug call is an LLM call
export function isLLMCall(call: DebugCall): call is DebugLLMCall {
  // Check for call_id which is unique to DebugLLMCall
  return "call_id" in call;
}

// Helper to check if a debug call is a divider
export function isDivider(call: DebugCall): call is DebugDivider {
  return "_type" in call && call._type === "divider";
}

// ============================================
// Types
// ============================================

export interface ThinkingStep {
  type: "tool_start" | "tool_end";
  tool: string;
  input?: string;
  output?: string;
  cached?: boolean;
}

export interface ApprovalRequestData {
  request_id: string;
  tool: string;
  input: string;
  risk_level: string;
}

export interface PlanApprovalRequestData {
  plan_id: string;
  plan: Plan;
  timestamp: string;
}

export interface SessionState {
  messages: ChatMessage[];
  isStreaming: boolean;
  streamingContent: string;
  // 流式过程中按时间顺序积累的消息片段
  streamingSegments: MessageSegment[];
  thinkingSteps: ThinkingStep[];
  approvalRequest: ApprovalRequestData | null;
  planApprovalRequest: PlanApprovalRequestData | null;
  currentPlan: Plan | null;
  // PlanCard 淡出状态：流结束时先设为 true 播放过渡动画，延迟后再清除 currentPlan
  planFadeOut: boolean;
  // 步骤开始时间戳，用于计算耗时（key: step_id, value: timestamp ms）
  planStepTimestamps: Record<number, number>;
  // 当前 running 步骤的实时活动描述（如 "🌐 获取网页 sina.com..."）
  planStepActivity: string;
  messagesLoaded: boolean;
  messagesLoading: boolean;
  debugCalls: DebugCall[];
}

type Listener = () => void;

function defaultState(): SessionState {
  return {
    messages: [],
    isStreaming: false,
    streamingContent: "",
    streamingSegments: [],
    thinkingSteps: [],
    approvalRequest: null,
    planApprovalRequest: null,
    currentPlan: null,
    planFadeOut: false,
    planStepTimestamps: {},
    planStepActivity: "",
    messagesLoaded: false,
    messagesLoading: false,
    debugCalls: [],
  };
}

// ============================================
// Plan 步骤活动描述辅助函数
// ============================================

/** 从工具名+输入 JSON 生成执行中的活动描述（如 "🌐 正在获取网页 sina.com..."） */
function buildToolActivity(tool: string, input?: string): string {
  const LABELS: Record<string, string> = {
    read_file: "📄 正在读取文件",
    fetch_url: "🌐 正在获取网页",
    python_repl: "🐍 正在执行代码",
    terminal: "💻 正在执行命令",
    search_knowledge_base: "🔍 正在检索知识库",
    memory_write: "💾 正在存储记忆",
    memory_search: "🧠 正在搜索记忆",
  };
  let label = LABELS[tool]
    || (tool.startsWith("mcp_") ? `🔌 正在调用 ${tool.split("_").slice(2).join("_")}` : `🔧 正在使用 ${tool}`);
  // 从 JSON input 提取关键参数作为详情
  if (input) {
    try {
      const p = JSON.parse(input);
      let detail: string = p.url || p.file_path || p.path || p.command || p.query || "";
      if (detail.length > 40) detail = detail.slice(0, 40) + "...";
      if (detail) label += ` ${detail}`;
    } catch { /* input 非 JSON，忽略 */ }
  }
  return label;
}

/** 工具执行完毕后，根据工具类型生成针对性的"分析中"描述 */
function buildThinkingActivity(tool: string): string {
  const MESSAGES: Record<string, string> = {
    read_file: "💭 正在分析文件内容...",
    fetch_url: "💭 正在分析获取的网页内容...",
    python_repl: "💭 正在分析代码执行结果...",
    terminal: "💭 正在分析命令执行结果...",
    search_knowledge_base: "💭 正在分析检索结果...",
    memory_write: "💭 记忆已保存，正在规划下一步...",
    memory_search: "💭 正在分析搜索到的记忆...",
  };
  return MESSAGES[tool]
    || (tool.startsWith("mcp_") ? "💭 正在分析工具返回的结果..." : "💭 正在规划下一步操作...");
}

/**
 * 从文本中提取最后一个有意义的行（截取前 maxLen 个字符）。
 * 支持 LLM 输入格式 "[Role]\n内容\n---\n[Role]\n内容" 和普通文本。
 */
function extractLastLine(text: string, maxLen: number = 35): string {
  if (!text) return "";
  // 按行分割，过滤空行和角色标记行（如 [SystemMessage]、[HumanMessage]）
  const lines = text.split("\n").filter(
    l => l.trim() && !l.trim().startsWith("[") && l.trim() !== "---"
  );
  let line = lines[lines.length - 1]?.trim() || "";
  if (line.length < 8 && lines.length >= 2) {
    line = lines[lines.length - 2]?.trim() || "";
  } 
  return line.length > maxLen ? line.slice(0, maxLen) + "..." : line + ".." ;
}

// ============================================
// SessionStore
// ============================================

class SessionStore {
  private sessions = new Map<string, SessionState>();
  private abortControllers = new Map<string, AbortController>();
  private listeners = new Set<Listener>();
  private onFirstMessageCallback: ((sessionId: string) => void) | null = null;
  // Session-level auto-approved tools (cleared when session ends or page refreshes)
  private sessionAllowedTools = new Map<string, Set<string>>();
  // Plan 活动描述节流：记录每个 session 上次因 token 事件更新活动描述的时间戳
  private lastTokenActivityTs = new Map<string, number>();

  // ---- State access ----

  getState(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = defaultState();
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  // ---- Subscription (useSyncExternalStore) ----

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private notify() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private updateSession(sessionId: string, patch: Partial<SessionState>) {
    const current = this.getState(sessionId);
    const updated = { ...current, ...patch };
    this.sessions.set(sessionId, updated);
    this.notify();
  }

  // ---- Message loading ----

  async loadMessages(sessionId: string): Promise<void> {
    const state = this.getState(sessionId);
    if (state.messagesLoaded || state.messagesLoading) return;

    // If currently streaming, don't overwrite — just mark loaded
    if (state.isStreaming) {
      this.updateSession(sessionId, { messagesLoaded: true });
      return;
    }

    this.updateSession(sessionId, { messagesLoading: true });

    try {
      const sessionData = await fetchSessionMessages(sessionId);
      // Re-check streaming state (may have started while we were fetching)
      const current = this.getState(sessionId);
      if (current.isStreaming) {
        this.updateSession(sessionId, { messagesLoaded: true, messagesLoading: false });
      } else {
        this.updateSession(sessionId, {
          messages: sessionData.messages,
          debugCalls: sessionData.debug_calls,
          currentPlan: sessionData.plan || null,
          messagesLoaded: true,
          messagesLoading: false,
        });
      }
    } catch {
      this.updateSession(sessionId, {
        messages: [],
        messagesLoaded: true,
        messagesLoading: false,
      });
    }
  }

  // ---- Streaming ----

  async startStream(sessionId: string, message: string): Promise<void> {
    const state = this.getState(sessionId);
    if (state.isStreaming) return;

    const controller = new AbortController();
    this.abortControllers.set(sessionId, controller);

    // Add user message
    const userMsg: ChatMessage = {
      role: "user",
      content: message,
      timestamp: new Date().toISOString(),
    };
    const prevMessages = state.messages;
    const isFirstMessage = prevMessages.length === 0;

    const debugEnabled = typeof window !== "undefined"
      && localStorage.getItem("vibeworker_debug") === "true";

    this.updateSession(sessionId, {
      messages: [...prevMessages, userMsg],
      isStreaming: true,
      streamingContent: "",
      streamingSegments: [],
      thinkingSteps: [],
      approvalRequest: null,
      // 累积显示 debug 记录，不清空，但添加分隔卡片
      debugCalls: debugEnabled ? [
        ...this.getState(sessionId).debugCalls,
        {
          _type: "divider" as const,
          userMessage: message,
          timestamp: new Date().toISOString(),
        },
      ] : this.getState(sessionId).debugCalls,
    });

    let fullContent = "";
    const toolCalls: ToolCall[] = [];
    // 按时间顺序积累的消息片段
    const segments: MessageSegment[] = [];

    try {
      for await (const event of streamChat(message, sessionId, controller.signal, debugEnabled)) {
        switch (event.type) {
          case "token": {
            fullContent += event.content || "";
            // 追加到 segments 的最后一个文本片段，如果没有则新建
            const lastSeg = segments[segments.length - 1];
            if (lastSeg && lastSeg.type === "text") {
              lastSeg.content += event.content || "";
            } else {
              segments.push({ type: "text", content: event.content || "" });
            }
            // 节流更新 plan 步骤活动描述（每 618ms 刷新，显示 LLM 最新输出片段）
            const tokenActivityPatch: Partial<SessionState> = {};
            if (this.getState(sessionId).currentPlan) {
              const now = Date.now();
              const lastTs = this.lastTokenActivityTs.get(sessionId) || 0;
              if (now - lastTs >= 618) {
                this.lastTokenActivityTs.set(sessionId, now);
                const line = extractLastLine(fullContent, 35);
                if (line) {
                  tokenActivityPatch.planStepActivity = `✍️ ${line}`;
                }
              }
            }
            this.updateSession(sessionId, {
              streamingContent: fullContent,
              streamingSegments: [...segments],
              ...tokenActivityPatch,
            });
            break;
          }

          case "tool_start": {
            const currentSteps = this.getState(sessionId).thinkingSteps;
            // 更新 plan 步骤活动描述（仅当有 plan 时）
            const planActivityPatch: Partial<SessionState> = this.getState(sessionId).currentPlan
              ? { planStepActivity: buildToolActivity(event.tool || "", event.input) }
              : {};
            this.updateSession(sessionId, {
              thinkingSteps: [
                ...currentSteps,
                {
                  type: "tool_start",
                  tool: event.tool || "",
                  input: event.input,
                },
              ],
              ...planActivityPatch,
            });
            toolCalls.push({
              tool: event.tool || "",
              input: event.input || "",
            });
            // 在 segments 中按时间顺序插入工具调用片段
            segments.push({
              type: "tool",
              tool: event.tool || "",
              input: event.input || "",
            });
            this.updateSession(sessionId, {
              streamingSegments: [...segments],
            });
            // Add to debugCalls immediately when tool starts (for real-time display)
            if (debugEnabled) {
              const calls = this.getState(sessionId).debugCalls;
              this.updateSession(sessionId, {
                debugCalls: [...calls, {
                  tool: event.tool || "",
                  input: event.input || "",
                  output: "",  // Empty means in-progress
                  duration_ms: null,
                  cached: false,
                  timestamp: new Date().toISOString(),
                  _inProgress: true,  // Flag for in-progress state
                  motivation: event.motivation || "",  // Agent's motivation
                } as DebugToolCall & { _inProgress?: boolean }],
              });
            }
            // Notify app to show debug panel when atomic actions start
            window.dispatchEvent(new CustomEvent("vibeworker-debug-activity", {
              detail: { sessionId, type: "tool_start" },
            }));
            break;
          }

          case "tool_end": {
            let output = event.output || "";
            let isCached = event.cached || false;
            if (output.startsWith("[CACHE_HIT]")) {
              output = output.substring(11);
              isCached = true;
            }

            const currentSteps2 = this.getState(sessionId).thinkingSteps;
            this.updateSession(sessionId, {
              thinkingSteps: [
                ...currentSteps2,
                {
                  type: "tool_end",
                  tool: event.tool || "",
                  output,
                  cached: isCached,
                },
              ],
            });

            // Update matching tool call
            for (const tc of toolCalls) {
              if (tc.tool === event.tool && !tc.output) {
                tc.output = output;
                if (isCached) tc.cached = true;
                break;
              }
            }

            // 更新 segments 中对应工具调用的 output
            for (let si = segments.length - 1; si >= 0; si--) {
              const seg = segments[si];
              if (seg.type === "tool" && seg.tool === (event.tool || "") && !seg.output) {
                seg.output = output;
                if (isCached) seg.cached = true;
                break;
              }
            }
            this.updateSession(sessionId, {
              streamingSegments: [...segments],
            });

            // Update the in-progress debug call with final data
            if (debugEnabled) {
              const calls = this.getState(sessionId).debugCalls.slice();
              // Find the last in-progress call for this tool (skip dividers)
              for (let i = calls.length - 1; i >= 0; i--) {
                const call = calls[i];
                if (!isLLMCall(call) && !isDivider(call) && call.tool === event.tool && call._inProgress) {
                  calls[i] = {
                    ...call,
                    output: output,
                    duration_ms: event.duration_ms ?? null,
                    cached: isCached,
                    _inProgress: false,
                  };
                  break;
                }
              }
              this.updateSession(sessionId, { debugCalls: calls });
            }

            // 更新 plan 步骤活动描述：根据刚完成的工具类型生成针对性描述
            if (this.getState(sessionId).currentPlan) {
              this.updateSession(sessionId, {
                planStepActivity: buildThinkingActivity(event.tool || ""),
              });
            }
            // 步骤状态完全由后端 plan_updated 事件驱动，不再在前端 auto-advance
            break;
          }

          case "llm_start": {
            // 新一轮 LLM 调用开始时，截断当前 text segment，
            // 使后续 token 写入新 segment。这样 summarizer → agent 的总结
            // 会成为独立 segment，前端折叠逻辑才能正确识别最终回答。
            const prevSeg = segments[segments.length - 1];
            if (prevSeg && prevSeg.type === "text" && prevSeg.content?.trim()) {
              // 插入一个空占位，下次 token 事件会新建 text segment
              segments.push({ type: "text", content: "" });
            }
            // 更新 plan 步骤活动描述：显示 LLM 正在思考 + 提示词末尾片段
            if (this.getState(sessionId).currentPlan) {
              // 重置节流计时，让 llm_start 描述至少显示 1s 再被 token 覆盖
              this.lastTokenActivityTs.set(sessionId, Date.now());
              const hint = extractLastLine(event.input || "", 35);
              this.updateSession(sessionId, {
                planStepActivity: hint ? `💭 思考中：${hint}` : "💭 思考中...",
              });
            }
            // Add LLM call to debugCalls immediately when it starts (for real-time display)
            if (debugEnabled) {
              console.log("[llm_start] node:", event.node, "call_id:", event.call_id, "input.length:", event.input?.length);
              const calls = this.getState(sessionId).debugCalls;
              this.updateSession(sessionId, {
                debugCalls: [...calls, {
                  call_id: event.call_id || "",
                  node: event.node || "",
                  model: event.model || "",
                  duration_ms: null,
                  input_tokens: null,
                  output_tokens: null,
                  total_tokens: null,
                  input: event.input || "",
                  output: "",  // Empty means in-progress
                  timestamp: new Date().toISOString(),
                  _inProgress: true,
                  motivation: event.motivation || "",  // Agent's motivation
                } as DebugLLMCall],
              });
            }
            // Notify app to show debug panel when LLM calls start
            window.dispatchEvent(new CustomEvent("vibeworker-debug-activity", {
              detail: { sessionId, type: "llm_start" },
            }));
            break;
          }

          case "llm_end": {
            // Update the in-progress LLM call with final data
            if (debugEnabled) {
              console.log("[llm_end] node:", event.node, "call_id:", event.call_id, "input.length:", event.input?.length);
              const calls = this.getState(sessionId).debugCalls.slice();
              // Find the last in-progress call for this call_id
              for (let i = calls.length - 1; i >= 0; i--) {
                const call = calls[i];
                if (isLLMCall(call) && call.call_id === event.call_id && call._inProgress) {
                  console.log("[llm_end] Found match! Old input.length:", call.input?.length, "New input.length:", (event.input || call.input)?.length);
                  // 提取扩展字段（SSEEvent 类型中未定义的字段）
                  const rawEvent = event as SSEEvent & {
                    tokens_estimated?: boolean;
                    input_cost?: number;
                    output_cost?: number;
                    total_cost?: number;
                    cost_estimated?: boolean;
                    model_info?: {
                      name: string;
                      description: string;
                      context_length: number;
                      prompt_price: number;
                      completion_price: number;
                    };
                  };
                  calls[i] = {
                    ...call,
                    duration_ms: event.duration_ms ?? null,
                    input_tokens: event.input_tokens ?? null,
                    output_tokens: event.output_tokens ?? null,
                    total_tokens: event.total_tokens ?? null,
                    tokens_estimated: rawEvent.tokens_estimated,  // token 是否为估算值
                    input: event.input || call.input,  // Update input from llm_end event
                    output: event.output || "",
                    reasoning: event.reasoning || undefined,
                    // 成本相关字段（从 OpenRouter 定价计算）
                    input_cost: rawEvent.input_cost,
                    output_cost: rawEvent.output_cost,
                    total_cost: rawEvent.total_cost,
                    cost_estimated: rawEvent.cost_estimated,
                    model_info: rawEvent.model_info,  // 模型详情（用于悬停显示）
                    _inProgress: false,
                  };
                  break;
                }
              }
              this.updateSession(sessionId, { debugCalls: calls });
            }
            break;
          }

          case "debug_llm_call": {
            // Legacy event format - handle for backward compatibility
            const calls = this.getState(sessionId).debugCalls;
            this.updateSession(sessionId, {
              debugCalls: [...calls, {
                call_id: event.call_id || "",
                node: event.node || "",
                model: event.model || "",
                duration_ms: event.duration_ms || 0,
                input_tokens: event.input_tokens ?? null,
                output_tokens: event.output_tokens ?? null,
                total_tokens: event.total_tokens ?? null,
                input: event.input || "",
                output: event.output || "",
                timestamp: new Date().toISOString(),
              } as DebugLLMCall],
            });
            break;
          }

          case "plan_created":
            if (event.plan) {
              // 不再预设第一步为 running，由后端 executor_pre 节点发送 running 事件
              this.updateSession(sessionId, {
                currentPlan: event.plan,
                planStepTimestamps: {},
                planStepActivity: "",
              });
            }
            break;

          case "plan_updated": {
            const plan = this.getState(sessionId).currentPlan;
            if (plan && plan.plan_id === event.plan_id) {
              const updatedPlan: Plan = {
                ...plan,
                steps: plan.steps.map((s) =>
                  s.id === event.step_id
                    ? { ...s, status: (event.status as PlanStep["status"]) || s.status }
                    : s
                ),
              };
              // 记录步骤开始/结束时间戳，用于计算耗时
              const timestamps = { ...this.getState(sessionId).planStepTimestamps };
              const stepId = event.step_id as number;
              if (event.status === "running") {
                timestamps[stepId] = Date.now();
              }
              // 步骤状态变化时重置活动描述
              const activityReset = (event.status === "running" || event.status === "completed" || event.status === "failed")
                ? "" : this.getState(sessionId).planStepActivity;
              this.updateSession(sessionId, {
                currentPlan: updatedPlan,
                planStepTimestamps: timestamps,
                planStepActivity: activityReset,
              });
            }
            break;
          }

          case "plan_revised": {
            const planForRevise = this.getState(sessionId).currentPlan;
            if (planForRevise && planForRevise.plan_id === event.plan_id) {
              const keepCompleted = event.keep_completed || 0;
              const revisedSteps = event.revised_steps || [];
              const completedSteps = planForRevise.steps.slice(0, keepCompleted);
              const revisedPlan: Plan = {
                ...planForRevise,
                steps: [
                  ...completedSteps,
                  ...revisedSteps.map((s) => ({
                    ...s,
                    _revised: true,  // Mark as revised for UI
                  })),
                ] as PlanStep[],
              };
              this.updateSession(sessionId, { currentPlan: revisedPlan });
            }
            break;
          }

          case "plan_approval_request": {
            if (event.plan) {
              this.updateSession(sessionId, {
                planApprovalRequest: {
                  plan_id: event.plan_id || "",
                  plan: event.plan,
                  timestamp: new Date().toISOString(),
                },
              });
            }
            break;
          }

          case "approval_request": {
            const requestedTool = event.tool || "";
            const requestId = event.request_id || "";

            // Check if this tool is session-allowed, auto-approve if so
            if (this.isToolSessionAllowed(sessionId, requestedTool)) {
              sendApproval(requestId, true).catch((err) => {
                console.error("Failed to auto-approve:", err);
              });
            } else {
              this.updateSession(sessionId, {
                approvalRequest: {
                  request_id: requestId,
                  tool: requestedTool,
                  input: event.input || "",
                  risk_level: event.risk_level || "warn",
                },
              });
            }
            break;
          }

          case "done":
            break;

          case "error":
            fullContent += `\n\n❌ Error: ${event.content}`;
            this.updateSession(sessionId, { streamingContent: fullContent });
            break;
        }
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // 用户主动中断，标记内容被截断（与后端保存的标记一致）
        if (fullContent) {
          fullContent += "\n\n⚠️ [回复被中断]";
        }
      } else {
        fullContent += `\n\n❌ Connection error: ${err}`;
      }
    }

    // 清理节流计时器
    this.lastTokenActivityTs.delete(sessionId);

    // Finalize — auto-complete any remaining plan steps
    const finalState = this.getState(sessionId);
    let finalPlan = finalState.currentPlan;
    if (finalPlan) {
      const hasIncomplete = finalPlan.steps.some(
        (s) => s.status === "running" || s.status === "pending"
      );
      if (hasIncomplete) {
        finalPlan = {
          ...finalPlan,
          steps: finalPlan.steps.map((s) =>
            s.status === "running" || s.status === "pending"
              ? { ...s, status: "completed" as const }
              : s
          ),
        };
      }
    }

    // 只在有实际内容或工具调用时追加 assistant 消息，避免空消息
    const currentMessages = finalState.messages;

    if (finalPlan) {
      // 有计划时：先更新计划 + 设置 planFadeOut 播放过渡动画
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: fullContent,
        timestamp: new Date().toISOString(),
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        segments: segments.length > 0 ? segments : undefined,
        plan: finalPlan,
      };
      this.updateSession(sessionId, {
        messages: [...currentMessages, assistantMsg],
        isStreaming: false,
        streamingContent: "",
        streamingSegments: [],
        thinkingSteps: [],
        currentPlan: finalPlan,
        planFadeOut: true,
        planStepActivity: "",
      });
      // 延迟 500ms 后清除 currentPlan，让 PlanCard 有时间播放淡出动画
      setTimeout(() => {
        this.updateSession(sessionId, {
          currentPlan: null,
          planFadeOut: false,
          planStepTimestamps: {},
        });
      }, 500);
    } else if (fullContent || toolCalls.length > 0) {
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: fullContent,
        timestamp: new Date().toISOString(),
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        segments: segments.length > 0 ? segments : undefined,
      };
      this.updateSession(sessionId, {
        messages: [...currentMessages, assistantMsg],
        isStreaming: false,
        streamingContent: "",
        streamingSegments: [],
        thinkingSteps: [],
        currentPlan: null,
        planFadeOut: false,
        planStepTimestamps: {},
        planStepActivity: "",
      });
    } else {
      this.updateSession(sessionId, {
        isStreaming: false,
        streamingContent: "",
        streamingSegments: [],
        thinkingSteps: [],
        currentPlan: null,
        planFadeOut: false,
        planStepTimestamps: {},
        planStepActivity: "",
      });
    }

    this.abortControllers.delete(sessionId);

    // First-message callback (title generation, etc.)
    if (isFirstMessage && this.onFirstMessageCallback) {
      this.onFirstMessageCallback(sessionId);
    }
  }

  stopStream(sessionId: string): void {
    const controller = this.abortControllers.get(sessionId);
    if (controller) {
      controller.abort();
    }
  }

  // ---- Approval ----

  clearApproval(sessionId: string): void {
    this.updateSession(sessionId, { approvalRequest: null });
  }

  clearPlanApproval(sessionId: string): void {
    this.updateSession(sessionId, { planApprovalRequest: null });
  }

  async approvePlan(sessionId: string, planId: string, approved: boolean): Promise<void> {
    try {
      await sendPlanApproval(planId, approved);
    } catch (err) {
      console.error("Failed to send plan approval:", err);
    }
    this.clearPlanApproval(sessionId);
  }

  clearDebugCalls(sessionId: string): void {
    this.updateSession(sessionId, { debugCalls: [] });
  }

  addSessionAllowedTool(sessionId: string, tool: string): void {
    let allowedSet = this.sessionAllowedTools.get(sessionId);
    if (!allowedSet) {
      allowedSet = new Set();
      this.sessionAllowedTools.set(sessionId, allowedSet);
    }
    allowedSet.add(tool);
  }

  isToolSessionAllowed(sessionId: string, tool: string): boolean {
    const allowedSet = this.sessionAllowedTools.get(sessionId);
    return allowedSet?.has(tool) ?? false;
  }

  clearSessionAllowedTools(sessionId: string): void {
    this.sessionAllowedTools.delete(sessionId);
  }

  // ---- Lifecycle ----

  setOnFirstMessage(callback: ((sessionId: string) => void) | null): void {
    this.onFirstMessageCallback = callback;
  }

  removeSession(sessionId: string): void {
    this.stopStream(sessionId);
    this.abortControllers.delete(sessionId);
    this.sessions.delete(sessionId);
    this.sessionAllowedTools.delete(sessionId);
    this.lastTokenActivityTs.delete(sessionId);
    this.notify();
  }

  invalidateMessages(sessionId: string): void {
    const state = this.getState(sessionId);
    if (!state.isStreaming) {
      this.updateSession(sessionId, { messagesLoaded: false, messagesLoading: false });
    }
  }
}

export const sessionStore = new SessionStore();

// ============================================
// React Hooks
// ============================================

export function useSessionState(sessionId: string): SessionState {
  const state = useSyncExternalStore(
    sessionStore.subscribe,
    () => sessionStore.getState(sessionId),
    () => sessionStore.getState(sessionId),
  );

  useEffect(() => {
    if (!state.messagesLoaded && !state.messagesLoading) {
      sessionStore.loadMessages(sessionId);
    }
  }, [sessionId, state.messagesLoaded, state.messagesLoading]);

  return state;
}

export function useSessionActions(sessionId: string) {
  return {
    sendMessage: useCallback(
      (msg: string) => sessionStore.startStream(sessionId, msg),
      [sessionId],
    ),
    stopStream: useCallback(
      () => sessionStore.stopStream(sessionId),
      [sessionId],
    ),
    clearApproval: useCallback(
      () => sessionStore.clearApproval(sessionId),
      [sessionId],
    ),
    addSessionAllowedTool: useCallback(
      (tool: string) => sessionStore.addSessionAllowedTool(sessionId, tool),
      [sessionId],
    ),
    approvePlan: useCallback(
      (planId: string, approved: boolean) => sessionStore.approvePlan(sessionId, planId, approved),
      [sessionId],
    ),
  };
}

export function useIsSessionStreaming(sessionId: string): boolean {
  return useSyncExternalStore(
    sessionStore.subscribe,
    () => sessionStore.getState(sessionId).isStreaming,
    () => false,
  );
}
