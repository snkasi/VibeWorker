/**
 * VibeWorker API Client
 * Communicates with FastAPI backend at port 8088
 */

const API_BASE = "http://localhost:8088";

// ============================================
// Types
// ============================================
// 消息片段：文本或工具调用，按时间顺序排列
export type MessageSegment =
  | { type: "text"; content: string }
  | { type: "tool"; tool: string; input: string; output?: string; cached?: boolean; sandbox?: "local" | "docker" };

export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp?: string;
  tool_calls?: ToolCall[];
  // 按时间顺序排列的消息片段（文本+工具交替）
  segments?: MessageSegment[];
  plan?: Plan;
}

export interface ToolCall {
  tool: string;
  input: string;
  output?: string;
  cached?: boolean;  // Cache indicator
}

export interface Session {
  session_id: string;
  message_count: number;
  title: string | null;  // New: auto-generated title
  preview: string;
  updated_at: string;
}

export interface Skill {
  name: string;
  description: string;
  location: string;
  source?: string;
}

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  children?: FileNode[];
}

// Plan types
export interface PlanStep {
  id: number;
  title: string;
  status: "pending" | "running" | "completed" | "failed";
}

export interface Plan {
  plan_id: string;
  title: string;
  steps: PlanStep[];
}

export interface PlanRevision {
  reason: string;
  revised_steps: PlanStep[];
  keep_completed: number;
}

// 模型详情（来自 OpenRouter 定价数据）
export interface ModelInfo {
  name: string;              // 模型显示名称
  description: string;       // 模型描述
  context_length: number;    // 上下文长度
  prompt_price: number;      // 输入价格（$/token）
  completion_price: number;  // 输出价格（$/token）
}

// Debug types
export interface DebugLLMCall {
  call_id: string;
  node: string;
  model: string;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  tokens_estimated?: boolean;  // 标记 token 是否为估算值（流式输出时 API 通常不返回 token 信息）
  input: string;
  output: string;
  reasoning?: string;     // 推理模型的 <think> 内容
  timestamp: string;
  _inProgress?: boolean;  // Internal flag for in-progress state
  motivation?: string;    // Agent's motivation/explanation for this call
  // 成本相关字段（基于 OpenRouter 定价）
  input_cost?: number;       // 输入成本（美元）
  output_cost?: number;      // 输出成本（美元）
  total_cost?: number;       // 总成本（美元）
  cost_estimated?: boolean;  // 成本是否基于估算的 token
  model_info?: ModelInfo;    // 模型详情（用于悬停显示）
}

export interface DebugToolCall {
  tool: string;
  input: string;
  output: string;
  duration_ms: number | null;
  cached: boolean;
  timestamp: string;
  _inProgress?: boolean;  // Internal flag for in-progress state
  motivation?: string;    // Agent's motivation/explanation for this tool call
}

// Divider card for separating multiple conversations in the same session
export interface DebugDivider {
  _type: "divider";
  userMessage: string;
  timestamp: string;
}

// 召回的记忆条目（memory_recall_done 阶段携带）
export interface RecallItem {
  content: string;
  category: string;
  salience: number;
}

// 预处理阶段事件（前端 debug 面板展示）
export interface DebugPhase {
  _type: "phase";
  phase: string;
  description: string;
  timestamp: string;
  items?: RecallItem[];  // memory_recall_done 阶段携带的召回结果
  mode?: string;         // memory_recall_done: "keyword" | "embedding"
}

export type DebugCall = DebugLLMCall | DebugToolCall | DebugDivider | DebugPhase;

export interface SSEEvent {
  type: "token" | "tool_start" | "tool_end" | "llm_start" | "llm_end" | "done" | "error" | "approval_request" | "plan_created" | "plan_updated" | "plan_revised" | "plan_approval_request" | "debug_llm_call" | "phase" | "browser_action_required";
  content?: string;
  tool?: string;
  input?: string;
  output?: string;
  cached?: boolean;  // Cache indicator
  duration_ms?: number;  // Tool/LLM duration
  motivation?: string;  // Agent's motivation/explanation
  sandbox?: "local" | "docker";  // 执行环境标记
  // Phase fields (预处理阶段)
  phase?: string;
  description?: string;
  items?: RecallItem[];  // memory_recall_done 阶段携带
  mode?: string;         // memory_recall_done: 搜索模式
  // Approval request fields
  request_id?: string;
  risk_level?: "safe" | "warn" | "dangerous" | "blocked";
  // Browser Action fields
  action?: string;
  payload?: any;
  // Plan fields
  plan?: Plan;        // plan_created event
  plan_id?: string;   // plan_updated / plan_revised / plan_approval_request event
  step_id?: number;   // plan_updated event
  status?: string;    // plan_updated event (step status)
  // Plan revision fields
  reason?: string;            // plan_revised: why the plan was revised
  revised_steps?: PlanStep[]; // plan_revised: new/updated steps
  keep_completed?: number;    // plan_revised: number of completed steps kept
  // Debug LLM call fields
  call_id?: string;
  node?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  reasoning?: string;     // 推理模型的 <think> 内容
  // 成本相关字段（从 OpenRouter 定价计算）
  input_cost?: number;
  output_cost?: number;
  total_cost?: number;
  cost_estimated?: boolean;
}

// ============================================
// Chat API
// ============================================

/**
 * Send a chat message with SSE streaming support.
 * Returns an async generator that yields SSE events.
 */
export async function* streamChat(
  message: string,
  sessionId: string = "main_session",
  signal?: AbortSignal,
  debug: boolean = false,
): AsyncGenerator<SSEEvent> {
  const response = await fetch(`${API_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      session_id: sessionId,
      stream: true,
      debug,
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Chat request failed: ${response.statusText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          const data = JSON.parse(line.slice(6));
          yield data as SSEEvent;
        } catch {
          // Skip malformed SSE data
        }
      }
    }
  }
}

// ============================================
// Session API
// ============================================
export async function fetchSessions(): Promise<Session[]> {
  const res = await fetch(`${API_BASE}/api/sessions`);
  const data = await res.json();
  return data.sessions || [];
}

export interface SessionData {
  messages: ChatMessage[];
  debug_calls: DebugCall[];
  plan?: Plan;
}

export async function fetchSessionMessages(
  sessionId: string
): Promise<SessionData> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}`);
  const data = await res.json();
  return {
    messages: data.messages || [],
    debug_calls: data.debug_calls || [],
    plan: data.plan,
  };
}

export async function createSession(
  sessionId?: string
): Promise<string> {
  const res = await fetch(`${API_BASE}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId }),
  });
  const data = await res.json();
  return data.session_id;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await fetch(`${API_BASE}/api/sessions/${sessionId}`, {
    method: "DELETE",
  });
}

export async function generateSessionTitle(sessionId: string): Promise<string> {
  const res = await fetch(
    `${API_BASE}/api/sessions/${sessionId}/generate-title`,
    { method: "POST" }
  );
  if (!res.ok) {
    throw new Error("Failed to generate title");
  }
  const data = await res.json();
  return data.title;
}

// ============================================
// File API
// ============================================
export async function fetchFile(path: string): Promise<string> {
  const res = await fetch(
    `${API_BASE}/api/files?path=${encodeURIComponent(path)}`
  );
  if (!res.ok) throw new Error(`File not found: ${path}`);
  const data = await res.json();
  return data.content;
}

export async function saveFile(
  path: string,
  content: string
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/files`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, content }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Failed to save file");
  }
}

export async function fetchFileTree(
  root: string = ""
): Promise<FileNode[]> {
  const res = await fetch(
    `${API_BASE}/api/files/tree?root=${encodeURIComponent(root)}`
  );
  return await res.json();
}

// ============================================
// Skills API
// ============================================
export async function fetchSkills(): Promise<Skill[]> {
  const res = await fetch(`${API_BASE}/api/skills`);
  const data = await res.json();
  return data.skills || [];
}

export async function deleteSkill(skillName: string): Promise<void> {
  const res = await fetch(
    `${API_BASE}/api/skills/${encodeURIComponent(skillName)}`,
    { method: "DELETE" }
  );
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Failed to delete skill");
  }
}

// ============================================
// Health Check
// ============================================
export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}

export interface HealthStatus {
  status: string;
  version: string;
  model: string;
  extension_path: string;
}

export async function fetchHealthStatus(): Promise<HealthStatus | null> {
  try {
    const res = await fetch(`${API_BASE}/api/health`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ============================================
// Settings API
// ============================================
export interface SettingsData {
  openai_api_key: string;
  openai_api_base: string;
  llm_model: string;
  llm_temperature: number;
  llm_max_tokens: number;
  embedding_api_key: string;
  embedding_api_base: string;
  embedding_model: string;
  // Translation model (optional, falls back to main LLM if not set)
  translate_api_key: string;
  translate_api_base: string;
  translate_model: string;
  // Memory configuration
  memory_session_reflect_enabled: boolean;
  memory_daily_log_days: number;
  memory_max_prompt_tokens: number;
  memory_index_enabled: boolean;
  memory_implicit_recall_mode: string;
  // Cache configuration
  enable_url_cache: boolean;
  enable_llm_cache: boolean;
  enable_prompt_cache: boolean;
  enable_translate_cache: boolean;
  mcp_enabled: boolean;
  // Plan configuration
  plan_enabled: boolean;
  plan_revision_enabled: boolean;
  plan_require_approval: boolean;
  plan_max_steps: number;
  // Security configuration
  security_enabled: boolean;
  security_level: string;
  security_approval_timeout: number;
  security_audit_enabled: boolean;
  security_ssrf_protection: boolean;
  security_sensitive_file_protection: boolean;
  security_python_sandbox: boolean;
  security_rate_limit_enabled: boolean;
  security_docker_enabled: boolean;
  security_docker_network: string;
  // Data directory
  data_dir: string;
  // Theme (light/dark) - frontend-only, stored in localStorage
  theme?: "light" | "dark";
}

export async function fetchSettings(): Promise<SettingsData> {
  const res = await fetch(`${API_BASE}/api/settings`);
  return await res.json();
}

export async function updateSettings(data: SettingsData): Promise<void> {
  const res = await fetch(`${API_BASE}/api/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Failed to save settings");
  }
}

export interface TestModelResult {
  status: "ok" | "error";
  reply?: string;
  model?: string;
  message?: string;
}

export async function testModelConnection(params: {
  api_key?: string;
  api_base?: string;
  model?: string;
  model_type?: "llm" | "embedding" | "translate";
}): Promise<TestModelResult> {
  const res = await fetch(`${API_BASE}/api/settings/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Model connection test failed");
  }
  return await res.json();
}

// ============================================
// Docker Check API
// ============================================
export async function checkDockerAvailable(): Promise<{ available: boolean; message: string }> {
  const res = await fetch(`${API_BASE}/api/docker/check`);
  if (!res.ok) {
    return { available: false, message: "Docker 检测请求失败" };
  }
  return await res.json();
}

// ============================================
// Security / Approval API
// ============================================
export async function sendApproval(
  requestId: string,
  approved: boolean,
  feedback?: string,
  action?: "approve" | "deny" | "instruct"
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      request_id: requestId,
      approved,
      feedback: feedback || null,
      action: action || (approved ? "approve" : "deny"),
    }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Failed to send approval");
  }
}

export async function sendPlanApproval(
  planId: string,
  approved: boolean
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/plan/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plan_id: planId, approved }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Failed to send plan approval");
  }
}

export async function sendBrowserCallback(
  requestId: string,
  result: any
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/browser/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request_id: requestId, result: result }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Failed to send browser callback");
  }
}

export interface SecurityStatus {
  security_level: string;
  pending_approvals: number;
  rate_limits: Record<string, { used: number; limit: number; window_seconds: number }>;
  docker_available: boolean | null;
}

export async function fetchSecurityStatus(): Promise<SecurityStatus> {
  const res = await fetch(`${API_BASE}/api/security/status`);
  if (!res.ok) throw new Error("Failed to fetch security status");
  return await res.json();
}

// ============================================
// Skills Store API
// ============================================
export interface RemoteSkill {
  name: string;
  version: string;
  description: string;
  author: string;
  category: string;
  tags: string[];
  downloads: number;
  rating: number;
  is_installed: boolean;
}

export interface SkillDetail extends RemoteSkill {
  readme?: string;
  required_tools: string[];
  examples: string[];
  changelog?: string;
}

export interface StoreSkillsResponse {
  version: string;
  total: number;
  skills: RemoteSkill[];
}

export interface StoreSearchResponse {
  query: string;
  results: RemoteSkill[];
}

export interface StoreListParams {
  category?: string;
  page?: number;
  page_size?: number;
}

export async function fetchStoreSkills(
  params: StoreListParams = {}
): Promise<StoreSkillsResponse> {
  const searchParams = new URLSearchParams();
  if (params.category) searchParams.set("category", params.category);
  if (params.page) searchParams.set("page", params.page.toString());
  if (params.page_size) searchParams.set("page_size", params.page_size.toString());

  const url = `${API_BASE}/api/store/skills?${searchParams.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error("Failed to fetch store skills");
  }
  return await res.json();
}

export async function searchStoreSkills(query: string): Promise<RemoteSkill[]> {
  const res = await fetch(
    `${API_BASE}/api/store/search?q=${encodeURIComponent(query)}`
  );
  if (!res.ok) {
    throw new Error("Failed to search skills");
  }
  const data: StoreSearchResponse = await res.json();
  return data.results;
}

export async function fetchSkillDetail(name: string): Promise<SkillDetail> {
  const res = await fetch(
    `${API_BASE}/api/store/skills/${encodeURIComponent(name)}`
  );
  if (!res.ok) {
    throw new Error(`Skill '${name}' not found`);
  }
  return await res.json();
}

export async function installSkill(
  name: string,
  version?: string
): Promise<{ status: string; skill_name: string; version: string; message: string }> {
  const res = await fetch(`${API_BASE}/api/store/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ skill_name: name, version }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Failed to install skill");
  }
  return await res.json();
}

export async function updateInstalledSkill(
  name: string
): Promise<{ status: string; skill_name: string; version: string; message: string }> {
  const res = await fetch(
    `${API_BASE}/api/skills/${encodeURIComponent(name)}/update`,
    { method: "POST" }
  );
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Failed to update skill");
  }
  return await res.json();
}

export async function fetchStoreCategories(): Promise<string[]> {
  const res = await fetch(`${API_BASE}/api/store/categories`);
  if (!res.ok) {
    throw new Error("Failed to fetch categories");
  }
  const data = await res.json();
  return data.categories || [];
}

// ============================================
// Memory API
// ============================================
export interface MemoryEntry {
  entry_id: string;
  content: string;
  category: string;
  timestamp: string;
  salience?: number;      // 重要性评分 (0.0-1.0)
  access_count?: number;  // 访问次数
  source?: string;        // 来源标识（user_explicit/auto_extract/api/migration 等）
}

export interface DailyLog {
  date: string;
  path: string;
  size: number;
}

export interface MemoryStats {
  total_entries: number;
  category_counts: Record<string, number>;
  daily_logs_count: number;
  memory_file_size: number;
  daily_log_days: number;
  session_reflect_enabled: boolean;
  avg_salience?: number;  // 平均重要性
  version?: number;       // 记忆系统版本
}

export interface MemorySearchResult {
  id?: string;
  content: string;
  category?: string;
  source: string;
  score: number;
  salience?: number;
}

export async function fetchMemoryEntries(
  category?: string,
  page: number = 1,
  pageSize: number = 50
): Promise<{ entries: MemoryEntry[]; total: number }> {
  const params = new URLSearchParams({ page: page.toString(), page_size: pageSize.toString() });
  if (category) params.set("category", category);
  const res = await fetch(`${API_BASE}/api/memory/entries?${params}`);
  if (!res.ok) throw new Error("Failed to fetch memory entries");
  return await res.json();
}

export async function addMemoryEntry(
  content: string,
  category: string = "general",
  salience: number = 0.5
): Promise<MemoryEntry> {
  const res = await fetch(`${API_BASE}/api/memory/entries`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, category, salience }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Failed to add memory entry");
  }
  const data = await res.json();
  return data.entry;
}

export async function deleteMemoryEntry(entryId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/memory/entries/${entryId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Failed to delete memory entry");
  }
}

// 每日日志结构化条目
export interface DailyLogEntry {
  index: number;
  time: string;
  type: string;
  content: string;
  category?: string;
}

export async function updateMemoryEntry(
  entryId: string,
  data: { content?: string; category?: string; salience?: number }
): Promise<MemoryEntry> {
  const res = await fetch(`${API_BASE}/api/memory/entries/${entryId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Failed to update memory entry");
  }
  const result = await res.json();
  return result.entry;
}

export async function fetchDailyLogEntries(date: string): Promise<DailyLogEntry[]> {
  const res = await fetch(`${API_BASE}/api/memory/daily-logs/${date}/entries`);
  if (!res.ok) throw new Error(`Failed to fetch daily log entries for ${date}`);
  const data = await res.json();
  return data.entries || [];
}

export async function updateDailyLogEntry(
  date: string,
  index: number,
  content: string,
  logType?: string
): Promise<DailyLogEntry> {
  const res = await fetch(`${API_BASE}/api/memory/daily-logs/${date}/entries/${index}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, log_type: logType }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Failed to update daily log entry");
  }
  const result = await res.json();
  return result.entry;
}

export async function deleteDailyLogEntry(date: string, index: number): Promise<void> {
  const res = await fetch(`${API_BASE}/api/memory/daily-logs/${date}/entries/${index}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Failed to delete daily log entry");
  }
}

export async function fetchDailyLogs(): Promise<DailyLog[]> {
  const res = await fetch(`${API_BASE}/api/memory/daily-logs`);
  if (!res.ok) throw new Error("Failed to fetch daily logs");
  const data = await res.json();
  return data.logs || [];
}

export async function fetchDailyLogContent(date: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/memory/daily-logs/${date}`);
  if (!res.ok) throw new Error(`No log found for ${date}`);
  const data = await res.json();
  return data.content;
}

export async function deleteDailyLog(date: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/memory/daily-logs/${date}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Failed to delete daily log for ${date}`);
}

export async function searchMemory(
  query: string,
  topK: number = 5,
  useDecay: boolean = true,
  category?: string,
  sourceType?: string
): Promise<{ results: MemorySearchResult[]; total: number }> {
  const res = await fetch(`${API_BASE}/api/memory/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, top_k: topK, use_decay: useDecay, category, source_type: sourceType }),
  });
  if (!res.ok) throw new Error("Memory search failed");
  const data = await res.json();
  return { results: data.results || [], total: data.total || 0 };
}

export async function fetchMemoryStats(): Promise<MemoryStats> {
  const res = await fetch(`${API_BASE}/api/memory/stats`);
  if (!res.ok) throw new Error("Failed to fetch memory stats");
  return await res.json();
}

export async function reindexMemory(): Promise<string> {
  const res = await fetch(`${API_BASE}/api/memory/reindex`, {
    method: "POST",
  });
  if (!res.ok) throw new Error("Failed to reindex memory");
  const data = await res.json();
  return data.message;
}

export interface MergeDetail {
  from: { id: string; content: string }[];
  to: { id: string; content: string };
  category: string;
}

export interface CompressMemoryResult {
  status: "ok" | "skip" | "embedding_unavailable";
  reason?: string;
  message?: string;  // 当 status="embedding_unavailable" 时的提示消息
  before: number;
  after: number;
  merged: number;
  kept: number;
  clusters: number;
  merge_details: MergeDetail[];
}

export interface CompressProgressEvent {
  type: "progress";
  message: string;
  step: "backup" | "load" | "cluster" | "merge" | "save";
  detail?: {
    category?: string;
    count?: number;
    current?: number;
    total?: number;
  };
}

/**
 * 压缩记忆（SSE 流式接口，支持实时进度）
 *
 * @param forceTextSimilarity 强制使用文本相似度
 * @param onProgress 进度回调
 * @returns 最终结果
 */
export async function compressMemory(
  forceTextSimilarity: boolean = false,
  onProgress?: (event: CompressProgressEvent) => void
): Promise<CompressMemoryResult> {
  const url = new URL(`${API_BASE}/api/memory/compress`);
  if (forceTextSimilarity) {
    url.searchParams.set("force_text_similarity", "true");
  }

  const res = await fetch(url.toString(), {
    method: "POST",
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "压缩记忆失败");
  }

  // 解析 SSE 事件流
  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error("无法读取响应流");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let result: CompressMemoryResult | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // 解析 SSE 事件（格式: event: xxx\ndata: {...}\n\n）
    const events = buffer.split("\n\n");
    buffer = events.pop() || ""; // 最后一个可能不完整，保留

    for (const eventBlock of events) {
      if (!eventBlock.trim()) continue;

      const lines = eventBlock.split("\n");
      let eventType = "progress";
      let eventData = "";

      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          eventData = line.slice(5).trim();
        }
      }

      if (!eventData) continue;

      try {
        const parsed = JSON.parse(eventData);

        if (eventType === "result") {
          result = parsed;
        } else if (eventType === "error") {
          throw new Error(parsed.message || "压缩失败");
        } else if (eventType === "progress" && onProgress) {
          onProgress(parsed as CompressProgressEvent);
        }
      } catch (e) {
        if (e instanceof SyntaxError) {
          console.warn("SSE 解析失败:", eventData);
        } else {
          throw e;
        }
      }
    }
  }

  if (!result) {
    throw new Error("未收到压缩结果");
  }

  return result;
}

export async function fetchRollingSummary(): Promise<string> {
  const res = await fetch(`${API_BASE}/api/memory/rolling-summary`);
  if (!res.ok) throw new Error("Failed to fetch rolling summary");
  const data = await res.json();
  return data.summary || "";
}

// ============================================
// Cache API
// ============================================
export type CacheType = string;  // "url" | "llm" | "prompt" | "translate" | "tool_*"

export interface CacheEntryPreview {
  key: string;
  created_at: number;
  expire_at: number;
  size_bytes: number;
  preview: string;
}

export interface CacheTypeStats {
  enabled: boolean;
  ttl: number;
  l1: { hits: number; misses: number; hit_rate: number; size: number; max_size: number };
  l2: { hits: number; misses: number; hit_rate: number; size_mb: number; file_count: number };
}

export type CacheStats = Record<string, CacheTypeStats>;

export interface CacheEntriesResponse {
  entries: CacheEntryPreview[];
  total: number;
  page: number;
  page_size: number;
}

export async function fetchCacheStats(): Promise<CacheStats> {
  const res = await fetch(`${API_BASE}/api/cache/stats`);
  if (!res.ok) throw new Error("Failed to fetch cache stats");
  const data = await res.json();
  return data.cache_stats;
}

export async function fetchCacheEntries(
  cacheType: CacheType,
  page: number = 1,
  pageSize: number = 50
): Promise<CacheEntriesResponse> {
  const params = new URLSearchParams({
    cache_type: cacheType,
    page: page.toString(),
    page_size: pageSize.toString(),
  });
  const res = await fetch(`${API_BASE}/api/cache/entries?${params}`);
  if (!res.ok) throw new Error("Failed to fetch cache entries");
  return await res.json();
}

export async function deleteCacheEntry(
  cacheType: CacheType,
  key: string
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/api/cache/entries/${cacheType}/${encodeURIComponent(key)}`,
    { method: "DELETE" }
  );
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Failed to delete cache entry");
  }
}

export async function clearCache(
  cacheType: CacheType | "all"
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/api/cache/clear?cache_type=${cacheType}`,
    { method: "POST" }
  );
  if (!res.ok) throw new Error("Failed to clear cache");
}

export async function cleanupCache(): Promise<void> {
  const res = await fetch(`${API_BASE}/api/cache/cleanup`, {
    method: "POST",
  });
  if (!res.ok) throw new Error("Failed to cleanup cache");
}

// ============================================
// MCP API
// ============================================
export interface McpServerConfig {
  transport: "stdio" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  description: string;
  source?: string;
}

export interface McpServerInfo extends McpServerConfig {
  status: "disconnected" | "connecting" | "connected" | "error";
  tools_count: number;
  error?: string | null;
}

export interface McpTool {
  name: string;
  description: string;
  server?: string;
}

export async function fetchMcpServers(): Promise<Record<string, McpServerInfo>> {
  const res = await fetch(`${API_BASE}/api/mcp/servers`);
  if (!res.ok) throw new Error("Failed to fetch MCP servers");
  const data = await res.json();
  return data.servers || {};
}

export async function addMcpServer(name: string, config: McpServerConfig): Promise<void> {
  const res = await fetch(`${API_BASE}/api/mcp/servers/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Failed to add MCP server");
  }
}

export async function updateMcpServer(name: string, config: McpServerConfig): Promise<void> {
  const res = await fetch(`${API_BASE}/api/mcp/servers/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Failed to update MCP server");
  }
}

export async function deleteMcpServer(name: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/mcp/servers/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Failed to delete MCP server");
  }
}

export async function connectMcpServer(name: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/mcp/servers/${encodeURIComponent(name)}/connect`, {
    method: "POST",
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Failed to connect MCP server");
  }
}

export async function disconnectMcpServer(name: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/mcp/servers/${encodeURIComponent(name)}/disconnect`, {
    method: "POST",
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Failed to disconnect MCP server");
  }
}

export async function fetchMcpTools(): Promise<McpTool[]> {
  const res = await fetch(`${API_BASE}/api/mcp/tools`);
  if (!res.ok) throw new Error("Failed to fetch MCP tools");
  const data = await res.json();
  return data.tools || [];
}

export async function fetchMcpServerTools(name: string): Promise<McpTool[]> {
  const res = await fetch(`${API_BASE}/api/mcp/servers/${encodeURIComponent(name)}/tools`);
  if (!res.ok) throw new Error("Failed to fetch server tools");
  const data = await res.json();
  return data.tools || [];
}

// ============================================
// Model Pool API
// ============================================
export interface PoolModel {
  id: string;
  name: string;
  api_key: string;     // masked
  api_base: string;
  model: string;
}

export interface ModelPoolData {
  models: PoolModel[];
  assignments: { llm?: string; embedding?: string; translate?: string };
}

export async function fetchModelPool(): Promise<ModelPoolData> {
  const res = await fetch(`${API_BASE}/api/model-pool`);
  if (!res.ok) throw new Error("Failed to fetch model pool");
  return await res.json();
}

export async function addPoolModel(data: {
  name: string;
  api_key: string;
  api_base: string;
  model: string;
}): Promise<void> {
  const res = await fetch(`${API_BASE}/api/model-pool`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Failed to add model");
  }
}

export async function updatePoolModel(
  modelId: string,
  data: { name?: string; api_key?: string; api_base?: string; model?: string }
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/model-pool/${encodeURIComponent(modelId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Failed to update model");
  }
}

export async function deletePoolModel(modelId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/model-pool/${encodeURIComponent(modelId)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Failed to delete model");
  }
}

export async function updateAssignments(
  assignments: { llm?: string; embedding?: string; translate?: string }
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/model-pool/assignments`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(assignments),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Failed to update assignments");
  }
}

export async function testPoolModel(
  modelId: string
): Promise<TestModelResult> {
  const res = await fetch(`${API_BASE}/api/model-pool/${encodeURIComponent(modelId)}/test`, {
    method: "POST",
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Model test failed");
  }
  return await res.json();
}

// ============================================
// Translation API
// ============================================
export interface TranslateResponse {
  status: string;
  translated: string;
  source_language: string;
  target_language: string;
  model: string;
}

export async function translateContent(
  content: string,
  targetLanguage: string = "zh-CN"
): Promise<TranslateResponse> {
  const res = await fetch(`${API_BASE}/api/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, target_language: targetLanguage }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Translation failed");
  }
  return await res.json();
}

// ============================================
// Graph Config API (Agent 引擎配置)
// ============================================
export interface GraphConfigData {
  // Agent 节点
  agent_max_iterations: number;
  // Planner 节点
  planner_enabled: boolean;
  // Approval 节点
  approval_enabled: boolean;
  // Executor 节点
  executor_max_iterations: number;
  executor_max_steps: number;
  // Replanner 节点
  replanner_enabled: boolean;
  replanner_skip_on_success: boolean;
  // Summarizer 节点
  summarizer_enabled: boolean;
  // 全局设置
  recursion_limit: number;
}

export async function fetchGraphConfig(): Promise<GraphConfigData> {
  const res = await fetch(`${API_BASE}/api/graph-config`);
  if (!res.ok) throw new Error("Failed to fetch graph config");
  return await res.json();
}

export async function updateGraphConfig(
  data: Partial<GraphConfigData>
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/graph-config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Failed to update graph config");
  }
}
