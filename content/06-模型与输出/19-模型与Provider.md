# 第19章 模型与Provider

上一章在处理“跨轮历史到底放在哪里”，那是运行循环的外围。这一章回到循环最内圈：每一轮都要向一个模型要响应，而“那个模型对象是谁、从哪来、能调哪些参数”这条链，恰恰是最容易被跳过的知识。链条不清，后面所有“模型不听话”的排查都会退化成猜谜。

本章既讲怎么选模型，也讲模型这一层的接缝在哪——因为你要接的往往不是 OpenAI 官方端点。

## 学习目标

- 能按「RunConfig.model → Agent.model → provider 默认」的顺序，说清一次运行实际用了哪个模型。
- 能判断什么时候传字符串、什么时候传 `Model` 实例，并说出两者在默认参数与传输上的差异。
- 能写出一个可运行的 `ModelProvider`，以及符合 0.25.0 接口的最小 `Model` 实现。
- 能用 `OpenAIProvider` 与 `MultiProvider` 完成 Responses、Chat Completions、WebSocket 与前缀路由的切换。
- 能对照 `ModelSettings` 的全部字段，为一次调用选出正确的参数组合。

## 19.1 解析顺序由四行源码决定

模型解析不在 `Agent` 里，而在 `repo/src/agents/run_internal/turn_preparation.py` 的 `get_model()`。它是整章的地基，值得逐行读：

```python
def get_model(agent: Agent[Any], run_config: RunConfig) -> Model:
    if isinstance(run_config.model, Model):
        return run_config.model
    elif isinstance(run_config.model, str):
        return run_config.model_provider.get_model(run_config.model)
    elif isinstance(agent.model, Model):
        return agent.model

    return run_config.model_provider.get_model(agent.model)
```

翻成中文就是一条严格的优先级：

| 优先级 | 条件 | 结果 |
| --- | --- | --- |
| 1 | `RunConfig(model=某个 Model 实例)` | 直接用它，provider 完全不参与 |
| 2 | `RunConfig(model="名字")` | 用 `run_config.model_provider.get_model("名字")` |
| 3 | `Agent(model=某个 Model 实例)` | 直接用它 |
| 4 | 其余（含 `Agent.model=None`） | 用 `run_config.model_provider.get_model(agent.model)` |

两个容易忽略的推论。第一，**RunConfig 的优先级高于 Agent**：想给某个 Agent 单独指定模型，就不要在 RunConfig 里再设 `model`。第二，第 4 行的 `agent.model` 可以是 `None`，此时 `provider.get_model(None)` 会返回该 provider 的默认模型；`OpenAIProvider.get_model()` 里的写法是 `model_name if model_name is not None else get_default_model()`。

默认模型来自 `repo/src/agents/models/default_models.py`：

```python
def get_default_model() -> str:
    return os.getenv(OPENAI_DEFAULT_MODEL_ENV_VARIABLE_NAME, "gpt-5.6-luna").lower()
```

也就是说：不写 `model` 时，0.25.0 用的是 **gpt-5.6-luna**；`OPENAI_DEFAULT_MODEL` 可以整体替换它，注意结果被 `.lower()` 处理过。最后这点在接 Azure 之类对部署名大小写敏感的端点时会咬你一口。

而 `RunConfig.model_provider` 的默认值不是 `OpenAIProvider`，是 `MultiProvider`（`run_config.py` 里 `field(default_factory=MultiProvider)`）。这解释了为什么 `openai/gpt-4.1` 这种写法开箱即用——路由能力默认就在。

> 提示：模型的**默认参数**也跟着模型名走。`Agent.model_settings` 的默认工厂会针对模型名套用 GPT-5 系列默认值（reasoning effort 与 verbosity）。如果你传的是 `Model` 实例而不是字符串，`_initial_model_settings_for_model()` 返回的是空 `ModelSettings()`——SDK 不敢替你猜。

## 19.2 字符串与 Model 实例：不只是写法差异

字符串是“名字”，实例是“通道”。

传字符串时，`provider.get_model(name)` 每次解析都可能造一个新模型对象（Responses 路径）或从缓存里取（WebSocket 路径按事件循环缓存）。这意味着字符串天然支持“改配置就生效”：换 `RunConfig(model=...)` 立刻换模型。

传 `Model` 实例时，对象构造完成的那一刻，它的**传输方式、端点、客户端**就固定了。文档在 WebSocket 一节写得很直接：`OpenAIResponsesWSModel` 走 WebSocket，`OpenAIResponsesModel` 走 HTTP，`OpenAIChatCompletionsModel` 固定走 Chat Completions；你传实例进去，`set_default_openai_responses_transport()` 这类全局开关不再影响它。

什么时候该传实例？三种场景：接一个没有名字路由体系的自定义模型、需要对同一个端点做多份不同配置（不同 key、不同超时）、以及在测试里塞入 `ScriptedModel`。

```python
from agents import Agent, OpenAIChatCompletionsModel, OpenAIResponsesModel

# 写法一：字符串，交给 provider 解析（推荐）
triage_agent = Agent(name="Triage agent", model="gpt-5.6-sol")

# 写法二：实例，通道在构造时锁定
cheap_agent = Agent(
    name="Cheap agent",
    model=OpenAIChatCompletionsModel(model="gpt-5-nano", openai_client=client),
)
```

两种写法可以混用，但文档给了一条明确的工程建议：**一个 workflow 内尽量只用一种模型形状**（Responses 或 Chat Completions）。原因是两者的工具与特性集合不同，混用会让“这个 Agent 能用的工具，换一个就不能用”变成随机故障。

## 19.3 Responses 与 Chat Completions 的能力边界

`OpenAIResponsesModel` 是推荐路径，`OpenAIChatCompletionsModel` 是兼容路径。差异不是“新旧”，而是“少了哪些字段”：

| 能力 | Responses | Chat Completions |
| --- | --- | --- |
| `prompt`（平台提示模板） | 支持 | 不支持，默认忽略并告警 |
| `previous_response_id` / `conversation_id` | 支持 | 静默丢弃 |
| `reasoning.mode` / `reasoning.context` | 支持 | 只保留 `reasoning.effort`，其余告警 |
| 托管工具、`tool_namespace`、延迟加载 | 支持 | 请求会被拒绝 |
| 音频输出 | 支持 | 适配器直接抛 `AgentsException("Audio is not currently supported")` |
| 结构化输出 | 支持 JSON Schema | 取决于供应商，常有 400 |

“静默丢弃”是这里最危险的默认值。它让代码能跑，但跑的不是你以为的那条路。想让不兼容立刻炸出来，就打开发校验：

```python
from agents import Agent, OpenAIProvider, RunConfig, Runner

provider = OpenAIProvider(use_responses=False, strict_feature_validation=True)
result = await Runner.run(
    agent, "Hello", run_config=RunConfig(model_provider=provider)
)
# 传了 previous_response_id 就会在这里抛 UserError，而不是悄悄忽略
```

反过来，某些 OpenAI 兼容供应商的流式工具调用分片不可靠，会出现在 SDK 里“参数拼到一半”的怪异现象。这时用 `buffer_streamed_tool_calls=True`，让适配器等供应商的流结束后再一次性吐工具调用。

## 19.4 OpenAIProvider：一个构造器，四个开关

`repo/src/agents/models/openai_provider.py` 的构造器参数可以分成四组：

| 组别 | 参数 | 说明 |
| --- | --- | --- |
| 凭据与端点 | `api_key`、`base_url`、`organization`、`project`、`openai_client` | 传了 `openai_client` 就不能再传其余五项，否则 `UserError` |
| API 形状 | `use_responses` | `None` 时跟随 `set_default_openai_api()` 的全局设置 |
| 传输 | `use_responses_websocket`、`websocket_base_url`、`responses_websocket_options` | 只对 Responses 生效 |
| 兼容 | `strict_feature_validation`、`buffer_streamed_tool_calls`、`agent_registration` | 前两个见上一节 |

`get_model()` 的三条分支正好对应三种模型类：`use_responses=False` → `OpenAIChatCompletionsModel`；`use_responses=True` 且传输为 websocket → `OpenAIResponsesWSModel`；否则 → `OpenAIResponsesModel`。WebSocket 模型会按事件循环缓存，目的是复用同一条长连接。

```python
from agents import Agent, OpenAIProvider, RunConfig, Runner

provider = OpenAIProvider(
    use_responses_websocket=True,
    websocket_base_url="wss://your-proxy.example/v1",
    responses_websocket_options={"ping_interval": 20.0, "ping_timeout": 60.0},
)
agent = Agent(name="Assistant")

result = await Runner.run(
    agent, "Hello", run_config=RunConfig(model_provider=provider)
)
```

如果只想全局开一次，不必构造 provider：

```python
from agents import set_default_openai_responses_transport

set_default_openai_responses_transport("websocket")
```

这条设置只在“provider 把模型名解析成模型实例”时生效——再次印证 19.2 的结论。WebSocket 不是银弹：官方服务每条连接同时只处理一个响应、单连接上限 60 分钟，并且失败的一轮会把 `previous_response_id` 指向的那份响应从连接内存里挤掉。可靠优先于延迟时，老实用 HTTP/SSE。

## 19.5 MultiProvider：用前缀做路由

`MultiProvider` 是 `RunConfig` 的默认 provider，规则集中在 `_resolve_prefixed_model()`：

| 模型名写法 | 路由结果 |
| --- | --- |
| `gpt-4.1`（无前缀） | 直接交给 `OpenAIProvider` |
| `openai/gpt-4.1` | 默认 `openai_prefix_mode="alias"`：剥掉前缀，按 `gpt-4.1` 走 |
| `litellm/anthropic/claude-sonnet-4` | 懒加载 `LitellmProvider` |
| `any-llm/openrouter/openai/gpt-4.1` | 懒加载 `AnyLLMProvider` |
| 其它前缀 | 默认 `unknown_prefix_mode="error"`，抛 `UserError` |

两类“模式”参数解决的是同一件事：**有些 OpenAI 兼容端点要求字面量命名空间 ID**。这时把 `openai_prefix_mode` 与 `unknown_prefix_mode` 都设成 `"model_id"`，整串名字原样转发。另外，`provider_map` 里显式登记的前缀优先级最高，压过所有内置回退——这是给自建网关留的入口。

```python
from agents import MultiProvider, RunConfig

provider = MultiProvider(
    openai_base_url="https://openrouter.ai/api/v1",
    openai_api_key="sk-...",
    openai_prefix_mode="model_id",
    unknown_prefix_mode="model_id",
)
# 此时 openrouter/openai/gpt-4.1-mini 会整串发给该端点
run_config = RunConfig(model_provider=provider)
```

## 19.6 LiteLLM 与 any-llm：第三方适配层

两个适配器都是 beta、best-effort，安装方式与入口类如下：

| 适配器 | 安装 | 模型类 | Provider | 模型名示例 |
| --- | --- | --- | --- | --- |
| LiteLLM | `pip install "openai-agents[litellm]"` | `LitellmModel` | `LitellmProvider` | `litellm/anthropic/claude-sonnet-4` |
| any-llm | `pip install "openai-agents[any-llm]"` | `AnyLLMModel` | `AnyLLMProvider` | `any-llm/openrouter/openai/gpt-4.1` |

```python
from agents import Agent
from agents.extensions.models.litellm_model import LitellmModel

agent = Agent(
    name="Claude agent",
    model=LitellmModel(model="anthropic/claude-sonnet-4"),
)
```

`AnyLLMModel` 多一个 `api="responses" | "chat_completions"` 参数，用来固定上游表面。用它们之前请记住三条：能力取决于上游而不是 SDK；用量上报常常要 `ModelSettings(include_usage=True)`；`LitellmModel` 目前不填充 `ModelResponse.request_id` 与 `raw_usage`。如果只是用 OpenAI 模型，别为了“看起来通用”而多套一层适配器——每次多一跳，就多一处语义损失。

## 19.7 自定义 Provider 与 Model：写对抽象方法名

先说一个容易记错的点：0.25.0 的 `Model` 抽象接口只有两个必须实现的方法，**`get_response`** 与 **`stream_response`**（不是 `get_streamed_response`）。签名可以从 `repo/src/agents/models/interface.py` 直接抄：

> 0.25 起 `Model` 还多了一个**可选钩子** `get_default_model_settings()`：SDK 用它推导"未显式设置时该模型该用什么默认参数"（例如 GPT-5 系列的 reasoning / verbosity）。不实现也能跑，只有当你希望自定义模型在默认参数上与其他 provider 对齐时才重写。对应地，0.25 修正了"隐式默认值 vs 显式赋值"的区分——完全没写 `reasoning` 与显式写 `reasoning=None`，现在不会再被混为一谈。

```python
from collections.abc import AsyncIterator
from typing import Any

from openai.types.responses import ResponseOutputMessage, ResponseOutputText

from agents import Agent, Model, ModelProvider, ModelResponse, RunConfig, Runner, Usage
from agents.agent_output import AgentOutputSchemaBase
from agents.handoffs import Handoff
from agents.items import TResponseStreamEvent
from agents.models.interface import ModelTracing
from agents.tool import Tool


class EchoModel(Model):
    """最小可用模型：不联网，把用户文本原样回显。"""

    async def get_response(
        self,
        system_instructions: str | None,
        input: Any,
        model_settings: Any,
        tools: list[Tool],
        output_schema: AgentOutputSchemaBase | None,
        handoffs: list[Handoff],
        tracing: ModelTracing,
        *,
        previous_response_id: str | None,
        conversation_id: str | None,
        prompt: Any,
    ) -> ModelResponse:
        text = input if isinstance(input, str) else "（非字符串输入）"
        message = ResponseOutputMessage(
            id="msg_echo",
            type="message",
            role="assistant",
            status="completed",
            content=[
                ResponseOutputText(
                    type="output_text",
                    text=f"收到：{text}",
                    annotations=[],
                    logprobs=[],
                )
            ],
        )
        return ModelResponse(output=[message], usage=Usage(requests=1), response_id=None)

    async def stream_response(
        self,
        system_instructions: str | None,
        input: Any,
        model_settings: Any,
        tools: list[Tool],
        output_schema: AgentOutputSchemaBase | None,
        handoffs: list[Handoff],
        tracing: ModelTracing,
        *,
        previous_response_id: str | None,
        conversation_id: str | None,
        prompt: Any,
    ) -> AsyncIterator[TResponseStreamEvent]:
        raise NotImplementedError("示例模型只支持非流式调用")
        yield  # pragma: no cover


class EchoProvider(ModelProvider):
    def get_model(self, model_name: str | None) -> Model:
        return EchoModel()
```

这段代码验证一件事：只要 `get_response` 返回合法的 `ModelResponse`，整个运行循环（含工具、护栏、handoff）都能照常跑。几个必须知道的细节：

- `ModelResponse` 只有 `output`、`usage`、`response_id` 是必填，`request_id` 与 `raw_usage` 可选。`request_id` 是排障时唯一的传输层线索，自研适配器能拿到就填。
- `output` 里的元素是 **Responses 格式的 output item**，必须是 `ResponseOutputMessage`、`ResponseFunctionToolCall` 这类对象。手写 dict 在多数情况下会被 Pydantic 宽容地转换，但字段缺失时就变成难查的校验错误——照 `agents.testing.assistant_message()` 的构造方式写最稳。
- `stream_response` 必须存在（抽象方法），但要真正支持流式，你得按 `response.created → response.output_item.added → … → response.completed` 的事件序列产出。手写这串事件没有教学价值，测试场景请直接用第 23 章的 `ScriptedModel`——它已经替你生成了完整序列。
- 模型可以覆写 `get_default_model_settings()` 与 `close()`：前者给命名空间型模型 ID 提供默认参数，后者释放长连接。

## 19.8 ModelSettings：所有字段一次看全

`ModelSettings` 在 0.25.0 有 25 个字段，全部可选。按用途分组：

| 用途 | 字段 |
| --- | --- |
| 采样 | `temperature`、`top_p`、`frequency_penalty`、`presence_penalty` |
| 工具 | `tool_choice`（`auto`/`required`/`none`/工具名/`MCPToolChoice`）、`parallel_tool_calls` |
| 输出形态 | `max_tokens`、`reasoning`、`verbosity`、`truncation` |
| 缓存与存储 | `store`、`prompt_cache_retention`、`prompt_cache_options`、`response_include`、`top_logprobs` |
| 上下文管理 | `context_management` |
| 用量与归因 | `include_usage`、`preserve_raw_usage`、`metadata` |
| 传输 | `extra_query`、`extra_body`、`extra_headers`、`extra_args`、`timeout` |
| 重试 | `retry` |

合并语义是本章第二重要的机制（第一是解析顺序）。`ModelSettings.resolve()` 规则如下：

1. 只覆盖 override 中**非 None** 的字段，因此“把某个值改回默认”不能靠 `None`。
2. `extra_args` 特殊：两边都是字典时**逐键合并**，不是替换。
3. `retry` 深合并：Agent 只改 `max_retries`，仍继承 RunConfig 的 `policy`。
4. 传字典而不是实例时，SDK 会校验字段名，拼错直接 `TypeError`（Unknown model settings）。

最后一条是很实用的护栏。写 `ModelSettings(temprature=0.2)` 不会沉默地按默认值跑，而是立刻报错。

```python
from agents import Agent, ModelSettings
from openai.types.shared import Reasoning

agent = Agent(
    name="Research agent",
    model="gpt-5.6-sol",
    model_settings=ModelSettings(
        reasoning=Reasoning(effort="high"),
        verbosity="low",
        parallel_tool_calls=False,
        truncation="auto",
        prompt_cache_options={"mode": "explicit", "ttl": "30m"},
        timeout=45.0,
    ),
)
```

> 注意：不要同时用直接字段和 `extra_args` 传同一个请求参数。`extra_args` 是给 SDK 还没暴露的供应商字段留的逃生舱，两边都写会让“到底哪个生效”变成实现细节。

## 19.9 模型选择与成本：三条可执行的判断

**第一条：先按任务分档，不要全站一个模型。** 分诊、抽取、改写这类短任务用 `gpt-5-nano` 或 `gpt-5.6-luna` 一档；需要长链推理的规划、代码改写用 `gpt-5.6-sol`。第 11 章的多智能体模式里，“便宜模型分诊 + 贵模型处理”是最常见也最有效的组合。

**第二条：延迟敏感时先降推理强度，再换模型。** 文档明确建议 GPT-5 系列用 `reasoning.effort="none"` 换低延迟；换模型是更大的动作。`verbosity="low"` 则直接压缩输出 token。

**第三条：把不确定性花在“上限”而不是“平均”上。** `max_turns`（默认 10）、`ModelSettings.timeout` 与 `retry` 决定的是最坏情况。没有 `timeout` 的模型调用在网关抖动时会把整个请求拖死；而 `retry` 是**显式 opt-in** 的，不配就不重试——这一点和很多框架的默认行为相反。

## 常见坑与排查

1. **症状**：给 Agent 传了 `Model` 实例，`MultiProvider` 的前缀或 WebSocket 开关全部失效。
   **原因**：`get_model()` 第 1、3 分支直接返回实例，provider 与传输选择根本不参与。
   **修法**：想保留路由就用字符串；确实要用实例时，在构造实例时就选对类（`OpenAIResponsesWSModel` / `OpenAIChatCompletionsModel`）。

2. **症状**：换到非 OpenAI 端点后 404，或 `prompt` / `previous_response_id` 毫无效果。
   **原因**：默认走 Responses，很多兼容端点只实现了 Chat Completions；而 Chat Completions 会静默丢弃 Responses-only 字段。
   **修法**：`set_default_openai_api("chat_completions")` 或显式用 `OpenAIChatCompletionsModel`；开发期加 `strict_feature_validation=True` 让不兼容立刻报错。

3. **症状**：`OPENAI_DEFAULT_MODEL` 设了却没生效，或 Azure 部署名报 model not found。
   **原因**：`get_default_model()` 会对环境变量值做 `.lower()`；且默认模型只在 `agent.model is None` 时启用。
   **修法**：改用 `RunConfig(model=...)` 或显式 `Agent(model=...)`，绕开大小写归一化。

4. **症状**：`ModelSettings(temprature=0.2)` 报 `TypeError`。
   **原因**：0.25.0 对 SDK 自有配置类型做未知字段校验，这是**预期行为**，不是 bug。
   **修法**：改成正确拼写；确实要传供应商私有字段，用 `extra_args`。

5. **症状**：接第三方适配器后 `usage.total_tokens` 一直是 0，或 `request_id` 全是 `None`。
   **原因**：流式 Chat Completions 常需要显式请求用量；`LitellmModel` 不填充 `request_id` 与 `raw_usage`。
   **修法**：加 `ModelSettings(include_usage=True)`；排障改用日志与 trace，不要依赖 `request_id`。

## 动手练习

1. **验证优先级**：建两个 Agent（一个 `model=None`，一个 `model="gpt-5-nano"`），用同一个 `RunConfig(model="gpt-5.6-sol")` 各跑一次，打印 `result.raw_responses[-1].response_id` 与日志里的模型名，确认 RunConfig 是否压过 Agent。
2. **写一个严格模式开关**：用 `OpenAIProvider(use_responses=False, strict_feature_validation=True)`，同一个 prompt 分别传 `previous_response_id=None` 和 `"resp_fake"`，记录两次的异常类型与消息。
3. **改造仓库示例**：打开 `repo/examples/model_providers/custom_example_provider.py`，把它改造成“按模型名前缀选择 Chat Completions 或 Responses”的 `MultiProvider` 版本（提示：用 `provider_map` 注册自定义前缀，别去改内置回退）。

## 本章小结

- 解析顺序：`RunConfig.model`（实例 > 字符串）> `Agent.model`（实例）> `provider.get_model(agent.model)`。
- 默认模型是 `gpt-5.6-luna`，`OPENAI_DEFAULT_MODEL` 可覆盖且会被 `.lower()`。
- 传字符串等于每次解析、受全局开关影响；传实例等于通道在构造时锁定。
- Responses 是推荐路径，Chat Completions 会静默丢弃 Responses-only 字段，用 `strict_feature_validation` 兜底。
- `MultiProvider` 是 `RunConfig` 的默认 provider，用前缀路由，`provider_map` 优先于内置回退。
- `Model` 的抽象方法是 `get_response` 与 `stream_response`；`ModelProvider` 只需要 `get_model`。
- `ModelSettings` 的合并是“非 None 覆盖 + `extra_args` 合并 + `retry` 深合并”。

## 延伸阅读

- 模型总览与路由：`repo/docs/models/index.md`
- LiteLLM 迁址说明：`repo/docs/models/litellm.md`
- 全局默认与日志：`repo/docs/config.md`
- 示例：`repo/examples/model_providers/custom_example_global.py`、`repo/examples/model_providers/custom_example_provider.py`、`repo/examples/model_providers/custom_example_agent.py`、`repo/examples/model_providers/litellm_provider.py`、`repo/examples/model_providers/any_llm_provider.py`
- 重试与超时：`repo/examples/basic/retry.py`
- 源码：`repo/src/agents/models/interface.py`、`repo/src/agents/models/openai_provider.py`、`repo/src/agents/models/multi_provider.py`、`repo/src/agents/models/default_models.py`、`repo/src/agents/model_settings.py`
- 下一章：《第20章 结构化输出与output_type》——把“模型说什么”变成可入库的对象。
