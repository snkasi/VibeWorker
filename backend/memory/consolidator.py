"""记忆整合器 — 实现 ADD/UPDATE/DELETE/NOOP 决策

借鉴 Mem0 的三阶段管道架构：
1. 提取候选记忆
2. 与已有记忆比对
3. 决策：ADD（新增）/ UPDATE（更新）/ DELETE（删除）/ NOOP（无操作）
"""
import logging
from typing import Optional, Literal

from config import settings

logger = logging.getLogger(__name__)

# 决策类型
DecisionType = Literal["ADD", "UPDATE", "DELETE", "NOOP"]


async def decide_consolidation(
    candidate_content: str,
    candidate_category: str,
    candidate_salience: float = 0.5,
    similarity_threshold: float = 0.7,
) -> tuple[DecisionType, Optional[str], Optional[str]]:
    """决策记忆整合操作

    Args:
        candidate_content: 候选记忆内容
        candidate_category: 候选记忆分类
        candidate_salience: 候选记忆重要性
        similarity_threshold: 相似度阈值

    Returns:
        (decision, target_id, merged_content)
        - decision: ADD/UPDATE/DELETE/NOOP
        - target_id: 目标记忆 ID（UPDATE/DELETE 时使用）
        - merged_content: 合并后的内容（UPDATE 时使用）
    """
    from memory.manager import memory_manager
    from memory.search import search_memories

    # 搜索相似记忆
    similar = search_memories(
        query=candidate_content,
        top_k=5,
        use_decay=False,  # 不使用衰减，找最相似的
        category=candidate_category,
    )

    # 没有相似记忆，直接 ADD
    if not similar:
        return ("ADD", None, None)

    # 过滤低相似度结果
    high_similar = [s for s in similar if s.get("score", 0) >= similarity_threshold]
    if not high_similar:
        return ("ADD", None, None)

    # 使用 LLM 决策
    try:
        from engine.llm_factory import create_llm
        llm = create_llm(streaming=False)

        # 构建相似记忆列表
        similar_list = "\n".join([
            f"{i+1}. [id={s.get('id')}] {s.get('content')} (salience={s.get('salience', 0.5):.2f})"
            for i, s in enumerate(high_similar[:3])
        ])

        prompt = f"""你需要决定如何处理一条新记忆。

新记忆：{candidate_content}
分类：{candidate_category}
重要性：{candidate_salience:.2f}

已有相似记忆：
{similar_list}

请选择操作（只返回 JSON）：
- ADD：新记忆是全新信息，与已有记忆不重复
- UPDATE <id>：新记忆是对已有记忆的补充/更新，返回合并后的内容
- DELETE <id>：新记忆与已有记忆矛盾，应删除旧的
- NOOP：新记忆已存在或无需记录

返回格式：
{{"decision": "ADD/UPDATE/DELETE/NOOP", "target_id": "xxx或null", "merged_content": "合并内容或null"}}

返回："""

        response = await llm.ainvoke(prompt)
        result = response.content.strip()

        # 解析响应
        import json
        try:
            # 从可能的 markdown 代码块中提取 JSON
            from memory.session_reflector import _extract_json
            result = _extract_json(result)

            data = json.loads(result)
            decision = data.get("decision", "NOOP").upper()
            target_id = data.get("target_id")
            merged_content = data.get("merged_content")

            if decision not in ("ADD", "UPDATE", "DELETE", "NOOP"):
                decision = "NOOP"

            return (decision, target_id, merged_content)

        except json.JSONDecodeError:
            # 尝试简单解析
            if "ADD" in result.upper():
                return ("ADD", None, None)
            elif "NOOP" in result.upper():
                return ("NOOP", None, None)
            return ("NOOP", None, None)

    except Exception as e:
        logger.error(f"整合决策失败: {e}")
        # 默认 ADD
        return ("ADD", None, None)


async def consolidate_memory(
    content: str,
    category: str = "general",
    salience: float = 0.5,
    source: str = "user_explicit",
    context: Optional[dict] = None,
) -> dict:
    """整合记忆 — 自动决策 ADD/UPDATE/DELETE/NOOP

    Args:
        content: 记忆内容
        category: 分类
        salience: 重要性
        source: 来源
        context: 额外上下文

    Returns:
        操作结果 {decision, entry}
    """
    from memory.manager import memory_manager

    decision, target_id, merged_content = await decide_consolidation(
        candidate_content=content,
        candidate_category=category,
        candidate_salience=salience,
    )

    if decision == "ADD":
        # skip_dedup=True: LLM 已做过 ADD 决策，跳过 Jaccard 重复检测避免矛盾
        entry = memory_manager.add_entry(
            content=content,
            category=category,
            salience=salience,
            source=source,
            context=context,
            skip_dedup=True,
        )
        logger.info(f"整合决策: ADD - {content[:50]}...")
        return {"decision": "ADD", "entry": entry}

    elif decision == "UPDATE" and target_id:
        # 更新已有记忆
        final_content = merged_content if merged_content else content
        entry = memory_manager.update_entry(
            entry_id=target_id,
            content=final_content,
            salience=max(salience, 0.5),  # 更新时至少保持原有重要性
        )
        if entry:
            logger.info(f"整合决策: UPDATE [{target_id}] - {final_content[:50]}...")
            return {"decision": "UPDATE", "entry": entry, "target_id": target_id}
        else:
            # 更新失败，fallback 到 ADD
            entry = memory_manager.add_entry(
                content=content,
                category=category,
                salience=salience,
                source=source,
                context=context,
                skip_dedup=True,
            )
            return {"decision": "ADD", "entry": entry}

    elif decision == "DELETE" and target_id:
        # 删除旧记忆，添加新记忆
        memory_manager.delete_entry(target_id)
        entry = memory_manager.add_entry(
            content=content,
            category=category,
            salience=salience,
            source=source,
            context=context,
            skip_dedup=True,
        )
        logger.info(f"整合决策: DELETE [{target_id}] + ADD - {content[:50]}...")
        return {"decision": "DELETE", "entry": entry, "deleted_id": target_id}

    else:  # NOOP
        logger.info(f"整合决策: NOOP - {content[:50]}...")
        return {"decision": "NOOP", "entry": None}


async def batch_consolidate(
    candidates: list[dict],
    max_concurrency: int = 3,
) -> list[dict]:
    """批量整合记忆（并行执行，限制并发数）

    Args:
        candidates: 候选记忆列表，每项包含 {content, category, salience, source, context}
        max_concurrency: 最大并发数（避免 LLM API 过载）

    Returns:
        操作结果列表
    """
    import asyncio

    semaphore = asyncio.Semaphore(max_concurrency)

    async def _consolidate_one(candidate: dict) -> dict:
        async with semaphore:
            return await consolidate_memory(
                content=candidate.get("content", ""),
                category=candidate.get("category", "general"),
                salience=candidate.get("salience", 0.5),
                source=candidate.get("source", "batch"),
                context=candidate.get("context"),
            )

    tasks = [_consolidate_one(c) for c in candidates]
    return list(await asyncio.gather(*tasks))
