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

export interface SSEEvent {
  type: "token" | "tool_start" | "tool_end" | "done" | "error";
  content?: string;
  tool?: string;
  input?: string;
  output?: string;
  cached?: boolean;  // Cache indicator
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
  sessionId: string = "main_session"
): AsyncGenerator<SSEEvent> {
  const response = await fetch(`${API_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      session_id: sessionId,
      stream: true,
    }),
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

export async function fetchSessionMessages(
  sessionId: string
): Promise<ChatMessage[]> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}`);
  const data = await res.json();
  return data.messages || [];
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
