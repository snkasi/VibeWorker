/**
 * VibeWorker API Client
 * Communicates with FastAPI backend at port 8088
 */

const API_BASE = "http://localhost:8088";

// ============================================
// Types
// ============================================
export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp?: string;
  tool_calls?: ToolCall[];
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

// Debug types
export interface DebugLLMCall {
  call_id: string;
  node: string;
  model: string;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  input: string;
  output: string;
  timestamp: string;
  _inProgress?: boolean;  // Internal flag for in-progress state
}

export interface DebugToolCall {
  tool: string;
  input: string;
  output: string;
  duration_ms: number | null;
  cached: boolean;
  timestamp: string;
  _inProgress?: boolean;  // Internal flag for in-progress state
}

// Divider card for separating multiple conversations in the same session
export interface DebugDivider {
  _type: "divider";
  userMessage: string;
  timestamp: string;
}

export type DebugCall = DebugLLMCall | DebugToolCall | DebugDivider;

export interface SSEEvent {
  type: "token" | "tool_start" | "tool_end" | "llm_start" | "llm_end" | "done" | "error" | "approval_request" | "plan_created" | "plan_updated" | "plan_revised" | "debug_llm_call";
  content?: string;
  tool?: string;
  input?: string;
  output?: string;
  cached?: boolean;  // Cache indicator
  duration_ms?: number;  // Tool/LLM duration
  // Approval request fields
  request_id?: string;
  risk_level?: "safe" | "warn" | "dangerous" | "blocked";
  // Plan fields
  plan?: Plan;        // plan_created event
  plan_id?: string;   // plan_updated event
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
  debug_calls: (DebugLLMCall | DebugToolCall)[];
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
  memory_auto_extract: boolean;
  memory_daily_log_days: number;
  memory_max_prompt_tokens: number;
  memory_index_enabled: boolean;
  // Cache configuration
  enable_url_cache: boolean;
  enable_llm_cache: boolean;
  enable_prompt_cache: boolean;
  enable_translate_cache: boolean;
  mcp_enabled: boolean;
  // Agent mode configuration
  agent_mode: "simple" | "task";
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
// Security / Approval API
// ============================================
export async function sendApproval(
  requestId: string,
  approved: boolean
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request_id: requestId, approved }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Failed to send approval");
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
  auto_extract_enabled: boolean;
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
  category: string = "general"
): Promise<MemoryEntry> {
  const res = await fetch(`${API_BASE}/api/memory/entries`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, category }),
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
  topK: number = 5
): Promise<string> {
  const res = await fetch(`${API_BASE}/api/memory/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, top_k: topK }),
  });
  if (!res.ok) throw new Error("Memory search failed");
  const data = await res.json();
  return data.result;
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
