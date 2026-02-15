# VibeWorker 缓存系统

## 概述

VibeWorker 的缓存系统提供了一个透明、可配置的双层缓存架构（L1 内存 + L2 磁盘），用于优化以下组件的性能：

- **URL 缓存**：网页请求结果（`fetch_url` 工具）
- **LLM 缓存**：Agent 响应（含流式输出模拟）
- **Prompt 缓存**：System Prompt 拼接结果
- **翻译缓存**：翻译 API 结果

## 设计原则

- ✅ **无外部依赖**：纯 Python 实现，无需 Redis/Memcached
- ✅ **文件即缓存**：所有缓存以 JSON 文件存储（透明可审计）
- ✅ **可配置性**：通过 `.env` 灵活控制
- ✅ **向后兼容**：默认配置不影响现有功能

## 架构

```
┌─────────────────────────────────────────┐
│  Application Layer (Tools / Agent)      │
├─────────────────────────────────────────┤
│  L1 Cache (Memory)                      │
│  - Python dict + TTL                    │
│  - LRU eviction (maxsize=100)           │
│  - 毫秒级访问                            │
├─────────────────────────────────────────┤
│  L2 Cache (Disk)                        │
│  - JSON files in .cache/                │
│  - 2-level directory structure          │
│  - 持久化，进程重启后可复用               │
└─────────────────────────────────────────┘
```

## 模块结构

```
cache/
├── __init__.py         # 全局缓存实例
├── base.py             # 抽象接口 (BaseCache, CacheStats)
├── memory_cache.py     # L1 内存缓存实现
├── disk_cache.py       # L2 磁盘缓存实现
├── url_cache.py        # URL 缓存
├── llm_cache.py        # LLM 缓存（含流式模拟）
├── prompt_cache.py     # Prompt 缓存
└── translate_cache.py  # 翻译缓存
```

## 使用方法

### 1. 导入缓存实例

```python
from cache import url_cache, llm_cache, prompt_cache, translate_cache
```

### 2. URL 缓存

```python
# 获取缓存
cached = url_cache.get_cached_url("https://example.com")
if cached:
    return cached

# 缓存结果
url_cache.cache_url("https://example.com", content)
```

### 3. LLM 缓存

```python
async def run_agent(message, session_history, stream=True):
    # 准备缓存键参数
    cache_key_params = {
        "system_prompt": build_system_prompt(),
        "recent_history": session_history[-3:],
        "current_message": message,
        "model": settings.llm_model,
        "temperature": settings.llm_temperature,
    }

    # 使用缓存（自动处理流式/非流式）
    async for event in llm_cache.get_or_generate(
        key_params=cache_key_params,
        generator_func=lambda: _run_agent_impl(...),
        stream=stream,
    ):
        yield event
```

### 4. Prompt 缓存

```python
# 检查缓存
cached = prompt_cache.get_cached_prompt()
if cached:
    return cached

# 缓存结果
prompt_cache.cache_prompt(full_prompt)
```

### 5. 翻译缓存

```python
# 获取缓存
cached = translate_cache.get_translation(content, "zh-CN")
if cached:
    return cached

# 缓存结果
translate_cache.cache_translation(content, "zh-CN", result)
```

## 配置

在 `.env` 文件中配置：

```bash
# 启用/禁用缓存
ENABLE_URL_CACHE=true
ENABLE_LLM_CACHE=false          # 默认关闭
ENABLE_PROMPT_CACHE=true
ENABLE_TRANSLATE_CACHE=true

# TTL（秒）
URL_CACHE_TTL=3600              # 1 小时
LLM_CACHE_TTL=86400             # 24 小时
PROMPT_CACHE_TTL=600            # 10 分钟
TRANSLATE_CACHE_TTL=604800      # 7 天

# 大小限制
CACHE_MAX_MEMORY_ITEMS=100
CACHE_MAX_DISK_SIZE_MB=5120     # 5GB
```

## 缓存管理

### 查看统计信息

```python
stats = url_cache.get_stats()
# {
#   "enabled": True,
#   "ttl": 3600,
#   "l1": {"hits": 10, "misses": 5, "hit_rate": 66.67, ...},
#   "l2": {"size_mb": 1.2, "file_count": 15, ...}
# }
```

### 清空缓存

```python
# 清空特定类型
result = url_cache.clear()

# 清空所有类型
from cache import url_cache, llm_cache, prompt_cache, translate_cache
for cache in [url_cache, llm_cache, prompt_cache, translate_cache]:
    cache.clear()
```

### 清理过期缓存

```python
# L1 内存缓存
expired_count = url_cache.l1.cleanup_expired()

# L2 磁盘缓存
expired_count = url_cache.l2.cleanup_expired()
lru_count = url_cache.l2.cleanup_lru()  # LRU 淘汰
```

## API 接口

### 获取统计信息

```bash
GET /api/cache/stats
```

响应：
```json
{
  "status": "ok",
  "cache_stats": {
    "url": { ... },
    "llm": { ... },
    "prompt": { ... },
    "translate": { ... }
  }
}
```

### 清空缓存

```bash
POST /api/cache/clear?type=url      # 清空 URL 缓存
POST /api/cache/clear?type=all      # 清空所有缓存
```

### 清理缓存

```bash
POST /api/cache/cleanup              # 清理过期 + LRU
```

## 测试

运行测试脚本：

```bash
cd backend
python test_cache.py
```

测试内容：
- ✓ URL 缓存读写
- ✓ Prompt 缓存读写
- ✓ 翻译缓存读写
- ✓ TTL 过期机制
- ✓ LRU 淘汰策略

## 性能提升

| 操作 | 优化前 | 优化后（缓存命中） | 提升 |
|------|--------|------------------|------|
| 网页请求 | ~500-2000ms | ~10-50ms | **10-100x** |
| LLM 调用 | ~2000-5000ms | ~100-300ms | **10-20x** |
| Prompt 拼接 | ~50-100ms | ~1-5ms | **10-50x** |
| 翻译 API | ~1000-2000ms | ~5-20ms | **50-200x** |

## 注意事项

1. **LLM 缓存默认关闭**
   - 避免影响 Agent 的探索性和多样性
   - 适用于生产环境或重复性任务
   - 需要时可手动开启

2. **缓存目录不上传 git**
   - `.cache/` 已添加到 `.gitignore`
   - 每个开发者独立维护本地缓存

3. **定时清理**
   - 后端启动时会自动启动定时清理任务（每小时）
   - 清理过期缓存 + LRU 淘汰（超过大小限制时）

4. **流式输出模拟**
   - LLM 缓存命中时会模拟流式输出
   - 通过短暂延迟（10ms/chunk）保持用户体验
   - 事件中包含 `"cached": true` 标记

## 故障排查

### 缓存未生效

1. 检查配置：`ENABLE_*_CACHE` 是否为 `true`
2. 检查日志：搜索 "cache hit" 或 "cache miss"
3. 查看统计：调用 `/api/cache/stats` 检查命中率

### 磁盘空间占用过大

1. 调整 `CACHE_MAX_DISK_SIZE_MB` 限制
2. 手动清理：`POST /api/cache/clear?type=all`
3. 定期清理：确保后端定时任务正常运行

### 缓存文件损坏

- 缓存系统会自动降级：遇到损坏文件会删除并重新请求
- 检查日志中的 "corrupted file" 警告
- 必要时手动删除 `.cache/` 目录

## 扩展

要添加新的缓存类型：

1. 创建新的缓存类（继承自 `BaseCache` 或使用 L1+L2 组合）
2. 在 `cache/__init__.py` 中注册
3. 在 `config.py` 中添加配置项
4. 在需要的地方集成缓存逻辑
