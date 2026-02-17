import { useSyncExternalStore, useEffect, useCallback } from "react";
import { streamChat, fetchSessionMessages, sendApproval, type ChatMessage, type ToolCall, type Plan, type PlanStep, type PlanRevision, type DebugLLMCall, type DebugToolCall } from "./api";

// Helper to check if a debug call is an LLM call
function isLLMCall(call: DebugLLMCall | DebugToolCall): call is DebugLLMCall {
  // Check for call_id which is unique to DebugLLMCall
  return "call_id" in call;
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

export interface SessionState {
  messages: ChatMessage[];
  isStreaming: boolean;
  streamingContent: string;
  thinkingSteps: ThinkingStep[];
  approvalRequest: ApprovalRequestData | null;
  currentPlan: Plan | null;
  messagesLoaded: boolean;
  messagesLoading: boolean;
  debugCalls: (DebugLLMCall | DebugToolCall)[];
}

type Listener = () => void;

function defaultState(): SessionState {
  return {
    messages: [],
    isStreaming: false,
    streamingContent: "",
    thinkingSteps: [],
    approvalRequest: null,
    currentPlan: null,
    messagesLoaded: false,
    messagesLoading: false,
    debugCalls: [],
  };
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
      thinkingSteps: [],
      approvalRequest: null,
      debugCalls: debugEnabled ? [] : this.getState(sessionId).debugCalls,
    });

    let fullContent = "";
    const toolCalls: ToolCall[] = [];

    try {
      for await (const event of streamChat(message, sessionId, controller.signal, debugEnabled)) {
        switch (event.type) {
          case "token":
            fullContent += event.content || "";
            this.updateSession(sessionId, { streamingContent: fullContent });
            break;

          case "tool_start": {
            const currentSteps = this.getState(sessionId).thinkingSteps;
            this.updateSession(sessionId, {
              thinkingSteps: [
                ...currentSteps,
                {
                  type: "tool_start",
                  tool: event.tool || "",
                  input: event.input,
                },
              ],
            });
            toolCalls.push({
              tool: event.tool || "",
              input: event.input || "",
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

            // Update the in-progress debug call with final data
            if (debugEnabled) {
              const calls = this.getState(sessionId).debugCalls.slice();
              // Find the last in-progress call for this tool
              for (let i = calls.length - 1; i >= 0; i--) {
                const call = calls[i];
                if (!isLLMCall(call) && call.tool === event.tool && call._inProgress) {
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

            // Auto-advance plan steps when non-plan tools complete
            const toolName = event.tool || "";
            if (toolName !== "plan_create" && toolName !== "plan_update") {
              const plan = this.getState(sessionId).currentPlan;
              if (plan) {
                const runningStep = plan.steps.find((s) => s.status === "running");
                if (runningStep) {
                  // Mark running step as completed, and next pending step as running
                  const nextStep = plan.steps.find((s) => s.id > runningStep.id && s.status === "pending");
                  const updatedPlan: Plan = {
                    ...plan,
                    steps: plan.steps.map((s) => {
                      if (s.id === runningStep.id) return { ...s, status: "completed" as const };
                      if (nextStep && s.id === nextStep.id) return { ...s, status: "running" as const };
                      return s;
                    }),
                  };
                  this.updateSession(sessionId, { currentPlan: updatedPlan });
                }
              }
            }
            break;
          }

          case "llm_start": {
            // Add LLM call to debugCalls immediately when it starts (for real-time display)
            if (debugEnabled) {
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
              const calls = this.getState(sessionId).debugCalls.slice();
              // Find the last in-progress call for this call_id
              for (let i = calls.length - 1; i >= 0; i--) {
                const call = calls[i];
                if (isLLMCall(call) && call.call_id === event.call_id && call._inProgress) {
                  calls[i] = {
                    ...call,
                    duration_ms: event.duration_ms ?? null,
                    input_tokens: event.input_tokens ?? null,
                    output_tokens: event.output_tokens ?? null,
                    total_tokens: event.total_tokens ?? null,
                    output: event.output || "",
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
              // Auto-mark first step as running
              const newPlan: Plan = {
                ...event.plan,
                steps: event.plan.steps.map((s, idx) =>
                  idx === 0 ? { ...s, status: "running" as const } : s
                ),
              };
              this.updateSession(sessionId, { currentPlan: newPlan });
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
              this.updateSession(sessionId, { currentPlan: updatedPlan });
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
        // Normal cancellation — do nothing
      } else {
        fullContent += `\n\n❌ Connection error: ${err}`;
      }
    }

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
    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: fullContent,
      timestamp: new Date().toISOString(),
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      plan: finalPlan || undefined,
    };

    const currentMessages = finalState.messages;
    this.updateSession(sessionId, {
      messages: [...currentMessages, assistantMsg],
      isStreaming: false,
      streamingContent: "",
      thinkingSteps: [],
      currentPlan: null,
    });

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
  };
}

export function useIsSessionStreaming(sessionId: string): boolean {
  return useSyncExternalStore(
    sessionStore.subscribe,
    () => sessionStore.getState(sessionId).isStreaming,
    () => false,
  );
}
