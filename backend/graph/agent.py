"""Agent Graph - LangChain Agent orchestration with LangGraph runtime."""
import logging
from typing import Optional

from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage, AIMessage, SystemMessage
from langgraph.prebuilt import create_react_agent

from config import settings
from prompt_builder import build_system_prompt
from tools import get_all_tools

logger = logging.getLogger(__name__)


def create_llm() -> ChatOpenAI:
    """Create and configure the LLM instance."""
    return ChatOpenAI(
        model=settings.llm_model,
        api_key=settings.llm_api_key,
        base_url=settings.llm_api_base,
        temperature=settings.llm_temperature,
        max_tokens=settings.llm_max_tokens,
        streaming=True,
    )


def create_agent_graph():
    """
    Create the Agent using LangGraph's create_react_agent.

    This uses the modern LangGraph prebuilt agent which provides:
    - ReAct-style reasoning loop
    - Automatic tool calling
    - Streaming support
    """
    llm = create_llm()
    tools = get_all_tools()
    system_prompt = build_system_prompt()

    # Create agent using LangGraph prebuilt
    agent = create_react_agent(
        model=llm,
        tools=tools,
        prompt=system_prompt,
    )

    return agent


async def run_agent(
    message: str,
    session_history: list[dict],
    stream: bool = True,
):
    """
    Run the agent with a user message.

    Args:
        message: User's input message.
        session_history: Previous conversation history.
        stream: Whether to stream the response.

    Yields:
        Event dicts with type and content for SSE streaming.
    """
    # If LLM cache is disabled, use original logic
    if not settings.enable_llm_cache:
        async for event in _run_agent_no_cache(message, session_history, stream):
            yield event
        return

    # LLM cache is enabled - prepare cache key parameters
    system_prompt = build_system_prompt()

    # Convert session history to simplified format for cache key
    recent_history = []
    for msg in session_history[-3:]:  # Last 3 messages
        recent_history.append({
            "role": msg.get("role", ""),
            "content": msg.get("content", "")[:500],  # Truncate to 500 chars
        })

    cache_key_params = {
        "system_prompt": system_prompt,
        "recent_history": recent_history,
        "current_message": message,
        "model": settings.llm_model,
        "temperature": settings.llm_temperature,
    }

    # Use LLM cache with streaming
    from cache import llm_cache

    async def generator():
        async for event in _run_agent_no_cache(message, session_history, stream):
            yield event

    async for event in llm_cache.get_or_generate(
        key_params=cache_key_params,
        generator_func=generator,
        stream=stream,
    ):
        yield event


async def _run_agent_no_cache(
    message: str,
    session_history: list[dict],
    stream: bool = True,
):
    """
    Run the agent without caching (internal implementation).

    Args:
        message: User's input message.
        session_history: Previous conversation history.
        stream: Whether to stream the response.

    Yields:
        Event dicts with type and content for SSE streaming.
    """
    agent = create_agent_graph()

    # Build messages from session history
    messages = []
    for msg in session_history:
        role = msg.get("role", "")
        content = msg.get("content", "")
        if role == "user":
            messages.append(HumanMessage(content=content))
        elif role == "assistant":
            messages.append(AIMessage(content=content))

    # Add current user message
    messages.append(HumanMessage(content=message))

    input_state = {"messages": messages}

    # Config with increased recursion limit (default is 25)
    config = {"recursion_limit": settings.agent_recursion_limit}

    if stream:
        async for event in agent.astream_events(input_state, version="v2", config=config):
            kind = event.get("event", "")

            if kind == "on_chat_model_stream":
                # Token-level streaming
                chunk = event.get("data", {}).get("chunk", None)
                if chunk and hasattr(chunk, "content") and chunk.content:
                    yield {
                        "type": "token",
                        "content": chunk.content,
                    }

            elif kind == "on_tool_start":
                # Tool call started
                tool_name = event.get("name", "")
                tool_input = event.get("data", {}).get("input", {})
                yield {
                    "type": "tool_start",
                    "tool": tool_name,
                    "input": str(tool_input),
                }

            elif kind == "on_tool_end":
                # Tool call finished
                tool_name = event.get("name", "")
                tool_output = event.get("data", {}).get("output", "")

                # Extract actual content from tool output
                # LangGraph may wrap the output in an object with a 'content' attribute
                if hasattr(tool_output, 'content'):
                    output_str = str(tool_output.content)
                else:
                    output_str = str(tool_output)

                # Limit output size
                output_str = output_str[:2000]

                # Check for cache marker
                is_cached = output_str.startswith('[CACHE_HIT]')
                if is_cached:
                    logger.info(f"✓ Cache hit for tool: {tool_name}")

                yield {
                    "type": "tool_end",
                    "tool": tool_name,
                    "output": output_str,
                    "cached": is_cached,  # Add cached flag
                }

        yield {"type": "done"}

    else:
        # Non-streaming mode
        result = await agent.ainvoke(input_state, config=config)
        final_messages = result.get("messages", [])
        if final_messages:
            last_msg = final_messages[-1]
            yield {
                "type": "message",
                "content": last_msg.content if hasattr(last_msg, "content") else str(last_msg),
            }
        yield {"type": "done"}
