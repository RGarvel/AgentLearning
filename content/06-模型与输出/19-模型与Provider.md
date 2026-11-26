# 第19章 模型与Provider

上一章讲的是「跨轮历史到底放在哪里」，那属于运行循环的外围。这一章回到最内圈：每一轮都要向一个模型要响应。

「那个模型对象是谁、从哪来、能调哪些参数」，这条链最容易被跳过。链条不清，后面所有「模型不听话」的排查都会退化成猜谜。

本章给一条主线：用 `OpenAIProvider` 做一次局部配置，亲手跑通一次运行，并打印出它到底用了哪个模型。走完你会得到三样东西：一段能直接跑的脚本、一张 Provider 参数对照表、一条「换模型就改哪一行」的判断规则。后面的 19.1 到 19.9 都在解释这段脚本为什么这么写，以及还能怎么微调。

第 2 章已经把全局的 key、base URL、模型名、API 形态讲全了，本章不重复那些内容。两者不冲突：全局配置是「没显式指定时的默认值」，Provider 层是「这一次运行显式指定的局部值」。局部值只作用于传了它的那次运行，全局值继续给别处兜底。

> 路径约定：本机 SDK 目录一律写作 `openai-agents-python/`。课程里的 `repo/xxx` 是逻辑前缀，点击跳 GitHub 上 v0.25.0 的源码，不用真的建 `repo` 目录。若你 clone 到别处，把命令里的 `openai-agents-python` 换成自己的路径即可，后文不再重复。

| 课程里写的（可点击） | 你本机打开的文件 |
| --- | --- |
| `repo/src/agents/models/openai_provider.py` | `openai-agents-python/src/agents/models/openai_provider.py` |

**主线跑通所需的全部配置项（Provider 层）。** 这张表把五项一次列全，每项都写明漏了会报什么错、以及和全局配置混用会发生什么。全局四项的细节见第 2 章，这里只讲局部层。

| 配置项 | 属哪一层 | 默认路线怎么设 | 漏了会报什么错 | 与全局配置混用会怎样 |
| --- | --- | --- | --- | --- |
| `api_key` | `OpenAIProvider` 构造参数 | `OpenAIProvider(api_key="sk-...")`，凭据写进 provider | 局部和全局都没有 key 时，构造客户端报 `OpenAIError`（找不到 api_key） | 传了 `openai_client` 后全局 `OPENAI_API_KEY` 被完全忽略；同时传 `api_key` 和 `openai_client` 会抛 `UserError` |
| `base_url` | `OpenAIProvider` 构造参数 | `OpenAIProvider(base_url="https://.../v1")`，网关地址通常带 `/v1` | 网关场景漏设：请求发到 `api.openai.com`，报 `APIConnectionError`、401 或 404 | 传了 `openai_client` 后全局 `OPENAI_BASE_URL` 被忽略；同时传 `base_url` 和 `openai_client` 会抛 `UserError` |
| `openai_client` | 自定义 `AsyncOpenAI` 实例 | 默认路线不传；要用它时把 key 和 base URL 都写进 client | 只设环境变量却传一个没带 key 的 client，会因找不到凭据而失败 | 它一旦传入就是唯一真相；再传 `api_key`、`base_url`、`websocket_base_url`、`organization`、`project` 任一项，构造时抛 `UserError` |
| `use_responses` | `OpenAIProvider` 构造参数 | `OpenAIProvider(use_responses=False)`，多数兼容网关只支持 Chat Completions | 漏设就跟随全局默认（Responses）；兼容网关返回 404 或「接口不支持」 | 传 provider 时局部值覆盖全局 `set_default_openai_api()`；传 `Model` 实例时此开关失效 |
| `model` | `Agent(model=...)` / `RunConfig(model=...)`，经 `provider.get_model()` 解析 | `Agent(model="gpt-4o-mini")`，照网关控制台的真实 ID 写 | 不设就用 `gpt-5.6-luna` 且被 `.lower()`；网关没这个模型报 `model not found` | `RunConfig.model` 压过 `Agent.model` 和全局 `OPENAI_DEFAULT_MODEL` |

**主线脚本：把上面几项装进一段代码。** 这段验证「局部配置能独立跑通一次，不依赖第 2 章的全局设置」。把它存成 `provider_main.py`，放在 SDK 根目录 `openai-agents-python/` 下，改掉两处占位符即可运行。

```python
# provider_main.py —— 主线：用 OpenAIProvider 局部配置跑通一次
import asyncio

from agents import Agent, OpenAIProvider, RunConfig, Runner


async def main() -> None:
    # 1. 局部配置全部装进 provider，不依赖全局设置
    provider = OpenAIProvider(
        api_key="你的网关key",                             # ← 改成网关签发的 key
        base_url="https://your-gateway.example.com/v1",   # ← 改成网关地址，通常带 /v1
        use_responses=False,                               # 多数兼容网关只支持 Chat Completions
    )
    # 2. 模型名走 provider.get_model() 解析
    agent = Agent(
        name="Assistant",
        instructions="You only respond in haikus.",
        model="gpt-4o-mini",                               # ← 换成网关真正支持的模型 ID
    )
    # 3. 把 provider 交给本次运行，全局配置不参与这一次
    result = await Runner.run(
        agent,
        "Tell me about recursion in programming.",
        run_config=RunConfig(model_provider=provider),
    )
    print(result.final_output)


if __name__ == "__main__":
    asyncio.run(main())
```

运行它。这条命令只做一件事：在 SDK 根目录下启动脚本。

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python provider_main.py
```

预期输出是一首三行俳句，措辞每次不同但形状固定：

```text
Function calls itself,
Looping in smaller pieces,
Endless by design.
```

看到俳句，说明「局部配置 + 网络 + 模型名」三件事同时通了，这是本章的总验收点。追踪（tracing）相关的配置在第 2 章已经讲全，本章不重复；网关 key 不能用于官方追踪时，按第 2 章的方式关掉或单独指定即可。

## 学习目标

- 用一段可运行的脚本完成 `OpenAIProvider` 局部配置，并说出它与第 2 章全局配置为什么不冲突。
- 能按「RunConfig.model → Agent.model → provider 默认」的顺序，说清一次运行实际用了哪个模型。
- 能判断什么时候传字符串、什么时候传 `Model` 实例，并说出两者在默认参数与传输上的差异。
- 能对照上面五项配置，逐项说出漏配或混用会报什么错，尤其是 `openai_client` 与 `api_key` 同传抛 `UserError`。
- 能用 `OpenAIProvider` 与 `MultiProvider` 完成 Responses、Chat Completions、WebSocket 与前缀路由的切换。
- 能对照 `ModelSettings` 的全部字段，为一次调用选出正确的参数组合。

---

## 19.1 解析顺序由四行源码决定

一次运行用哪个模型，由 `get_model()` 的四行分支决定，不在 `Agent` 里。这段源码出自 `repo/src/agents/run_internal/turn_preparation.py`，是整章的地基。

下面是源码摘录，不是可运行脚本。它嵌在 `repo/src/agents/run_internal/turn_preparation.py` 的 `get_model()` 里，前置变量 `agent` 与 `run_config` 由运行循环调用时传入，无需你自己构造。

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

四行分支翻成中文，就是一条严格的优先级。

| 优先级 | 条件 | 结果 |
| --- | --- | --- |
| 1 | `RunConfig(model=某个 Model 实例)` | 直接用它，provider 完全不参与 |
| 2 | `RunConfig(model="名字")` | 用 `run_config.model_provider.get_model("名字")` |
| 3 | `Agent(model=某个 Model 实例)` | 直接用它 |
| 4 | 其余（含 `Agent.model=None`） | 用 `run_config.model_provider.get_model(agent.model)` |

两个推论容易被忽略。第一，**RunConfig 的优先级高于 Agent**。想给某个 Agent 单独指定模型，就别在 RunConfig 里再设 `model`。

第二，第 4 行的 `agent.model` 可以是 `None`。此时 `provider.get_model(None)` 返回该供应商（provider）的默认模型；`OpenAIProvider.get_model()` 里的写法是 `model_name if model_name is not None else get_default_model()`。

默认模型来自 `repo/src/agents/models/default_models.py`。下面也是源码摘录，不是可运行脚本，前置变量 `os` 与 `OPENAI_DEFAULT_MODEL_ENV_VARIABLE_NAME` 由该源码文件定义。

```python
def get_default_model() -> str:
    return os.getenv(OPENAI_DEFAULT_MODEL_ENV_VARIABLE_NAME, "gpt-5.6-luna").lower()
```

也就是说：不写 `model` 时，0.25.0 用的是 **gpt-5.6-luna**。`OPENAI_DEFAULT_MODEL` 可以整体替换它，但结果会被 `.lower()` 处理过。接 Azure 这类对部署名大小写敏感的端点时，这一点会咬你一口。

`RunConfig.model_provider` 的默认值同样容易记错：它不是 `OpenAIProvider`，而是 `MultiProvider`（`run_config.py` 里 `field(default_factory=MultiProvider)`）。所以 `openai/gpt-4.1` 这种写法开箱即用，路由能力默认就在。

> 提示：模型的**默认参数**也跟着模型名走。`Agent.model_settings` 的默认工厂会针对模型名套用 GPT-5 系列的默认值（reasoning effort 与 verbosity）。如果你传的是 `Model` 实例而不是字符串，`_initial_model_settings_for_model()` 返回的是空 `ModelSettings()`。SDK 不敢替你猜。

---

## 19.2 字符串与 Model 实例：不只是写法差异

字符串是「名字」，实例是「通道」。这一节只讲这一条区分带来的后果。

传字符串时，`provider.get_model(name)` 每次解析都可能造一个新模型对象（Responses 路径），或从缓存里取（WebSocket 路径按事件循环缓存）。因此字符串天然支持「改配置就生效」：换 `RunConfig(model=...)` 立刻换模型。

传 `Model` 实例时，对象构造完成的那一刻，它的**传输方式、端点、客户端**就固定了。文档在 WebSocket 一节写得很直接：三种模型类各走各的路。`OpenAIResponsesWSModel` 走 WebSocket，`OpenAIResponsesModel` 走 HTTP，`OpenAIChatCompletionsModel` 固定走 Chat Completions。

传实例进去之后，`set_default_openai_responses_transport()` 这类全局开关就不再影响它。

什么时候该传实例？三种场景：接一个没有名字路由体系的自定义模型；对同一个端点做多份不同配置（不同 key、不同超时）；在测试里塞入 `ScriptedModel`。

下面这段验证「字符串交给 provider 解析、实例在构造时锁定通道」。把它存成 `model_shapes.py`，放在 SDK 根目录 `openai-agents-python/` 下。它只构造对象、不调用模型，所以不需要真实 key 也能跑。

```python
import asyncio

from openai import AsyncOpenAI

from agents import Agent, OpenAIChatCompletionsModel, OpenAIResponsesModel


async def main() -> None:
    client = AsyncOpenAI(api_key="sk-placeholder")

    # 写法一：字符串，交给 provider 解析（推荐）
    triage_agent = Agent(name="Triage agent", model="gpt-5.6-sol")

    # 写法二：实例，通道在构造时锁定
    cheap_agent = Agent(
        name="Cheap agent",
        model=OpenAIChatCompletionsModel(model="gpt-5-nano", openai_client=client),
    )

    print(type(triage_agent.model).__name__)
    print(type(cheap_agent.model).__name__)


if __name__ == "__main__":
    asyncio.run(main())
```

运行它：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python model_shapes.py
```

预期输出两行：第一行是 `str`，说明字符串原样留着、等待 provider 解析；第二行是 `OpenAIChatCompletionsModel`，说明实例在构造时就锁定了通道。

两种写法可以混用，但文档给了一条明确的工程建议：**一个 workflow 内尽量只用一种模型形状**（Responses 或 Chat Completions）。原因是两者的工具与特性集合不同。混用会让「这个 Agent 能用的工具，换一个就不能用」变成随机故障。

---

## 19.3 Responses 与 Chat Completions 的能力边界

`OpenAIResponsesModel` 是推荐路径，`OpenAIChatCompletionsModel` 是兼容路径。差异不在新旧，而在少了哪些字段。

| 能力 | Responses | Chat Completions |
| --- | --- | --- |
| `prompt`（平台提示模板） | 支持 | 不支持，默认忽略并告警 |
| `previous_response_id` / `conversation_id` | 支持 | 静默丢弃 |
| `reasoning.mode` / `reasoning.context` | 支持 | 只保留 `reasoning.effort`，其余告警 |
| 托管工具、`tool_namespace`、延迟加载 | 支持 | 请求会被拒绝 |
| 音频输出 | 支持 | 适配器直接抛 `AgentsException("Audio is not currently supported")` |
| 结构化输出 | 支持 JSON Schema | 取决于供应商，常有 400 |

「静默丢弃」是这里最危险的默认值。它让代码能跑，但跑的不是你以为的那条路。想让不兼容立刻炸出来，可以打开开发期校验。

下面这段验证「传了 `previous_response_id` 会抛 `UserError`，而不是悄悄忽略」。把它存成 `strict_validation.py`，放在 SDK 根目录 `openai-agents-python/` 下。请求在发网络前就被拦下，所以占位 key 也够用。

```python
import asyncio

from agents import Agent, OpenAIProvider, RunConfig, Runner


async def main() -> None:
    provider = OpenAIProvider(
        api_key="sk-placeholder",
        use_responses=False,
        strict_feature_validation=True,
    )
    agent = Agent(name="Assistant", instructions="用中文简洁作答。")
    await Runner.run(
        agent,
        "Hello",
        run_config=RunConfig(model_provider=provider),
        previous_response_id="resp_fake",
    )


if __name__ == "__main__":
    asyncio.run(main())
```

运行它：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python strict_validation.py
```

预期结果是抛 `UserError`，消息里点名 `OpenAIChatCompletionsModel does not support server-managed conversation state (previous_response_id)`。把 `strict_feature_validation` 改成 `False` 再跑，就只看到一条 warning 而不再抛错。

反过来，某些 OpenAI 兼容供应商的流式工具调用分片不可靠。表现是 SDK 里「参数拼到一半」的怪异现象。这时打开 `buffer_streamed_tool_calls=True`，让适配器等供应商的流结束后，再一次性吐出工具调用。

---

## 19.4 OpenAIProvider：一个构造器，四个开关

`OpenAIProvider` 的构造器参数可以分成四组，看懂这四组就掌握了它的全部行为。开篇那张表列的是「跑通要填哪几项」，这张表列的是「所有参数怎么分组」，两者不重复。

| 组别 | 参数 | 说明 |
| --- | --- | --- |
| 凭据与端点 | `api_key`、`base_url`、`organization`、`project`、`openai_client` | 传了 `openai_client` 就不能再传其余四项中任一项，否则抛 `UserError` |
| API 形状 | `use_responses` | `None` 时跟随 `set_default_openai_api()` 的全局设置 |
| 传输 | `use_responses_websocket`、`websocket_base_url`、`responses_websocket_options` | 只对 Responses 生效 |
| 兼容 | `strict_feature_validation`、`buffer_streamed_tool_calls`、`agent_registration` | 前两个见 19.3 与本节开头 |

`get_model()` 的三条分支正好对应三种模型类。`use_responses=False` 走 `OpenAIChatCompletionsModel`；`use_responses=True` 且传输为 websocket 走 `OpenAIResponsesWSModel`；其余走 `OpenAIResponsesModel`。WebSocket 模型会按事件循环缓存，目的是复用同一条长连接。

下面这段验证「构造 provider 时打开 WebSocket，并把它指向自己的代理地址」。把它存成 `provider_websocket.py`，放在 SDK 根目录 `openai-agents-python/` 下，把占位地址换成你的代理后运行。

```python
import asyncio

from agents import Agent, OpenAIProvider, RunConfig, Runner


async def main() -> None:
    provider = OpenAIProvider(
        api_key="你的网关key",
        use_responses_websocket=True,
        websocket_base_url="wss://your-proxy.example/v1",
        responses_websocket_options={"ping_interval": 20.0, "ping_timeout": 60.0},
    )
    agent = Agent(name="Assistant", model="gpt-4o-mini")

    result = await Runner.run(
        agent, "Hello", run_config=RunConfig(model_provider=provider)
    )
    print(result.final_output)


if __name__ == "__main__":
    asyncio.run(main())
```

运行它：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python provider_websocket.py
```

预期结果是：该 provider 解析出的模型走 WebSocket，`ping_interval` 与 `ping_timeout` 按给定值生效，终端打印出模型的回答。

如果只想全局开一次，不必构造 provider。下面这段验证「一行设置把默认 provider 的模型解析切成 WebSocket」，存成 `set_ws_transport.py`，放在 SDK 根目录 `openai-agents-python/` 下。

```python
from agents import set_default_openai_responses_transport

set_default_openai_responses_transport("websocket")
```

运行它：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python set_ws_transport.py
```

预期结果是：此后默认 provider 把模型名解析成 WebSocket 模型。这条设置只在「provider 把模型名解析成模型实例」时生效，再次印证 19.2 的结论。

WebSocket 不是银弹。官方服务每条连接同时只处理一个响应，单连接上限 60 分钟，而且失败的一轮会把 `previous_response_id` 指向的那份响应从连接内存里挤掉。可靠优先于延迟时，老实用 HTTP/SSE。

---

## 19.5 MultiProvider：用前缀做路由

`MultiProvider` 是 `RunConfig` 的默认供应商（provider），路由规则集中在 `_resolve_prefixed_model()` 里。

| 模型名写法 | 路由结果 |
| --- | --- |
| `gpt-4.1`（无前缀） | 直接交给 `OpenAIProvider` |
| `openai/gpt-4.1` | 默认 `openai_prefix_mode="alias"`：剥掉前缀，按 `gpt-4.1` 走 |
| `litellm/anthropic/claude-sonnet-4` | 懒加载 `LitellmProvider` |
| `any-llm/openrouter/openai/gpt-4.1` | 懒加载 `AnyLLMProvider` |
| 其它前缀 | 默认 `unknown_prefix_mode="error"`，抛 `UserError` |

两类「模式」参数解决的是同一件事：**有些 OpenAI 兼容端点要求字面量命名空间 ID**。这时把 `openai_prefix_mode` 与 `unknown_prefix_mode` 都设成 `"model_id"`，整串名字原样转发。

另外，`provider_map` 里显式登记的前缀优先级最高，压过所有内置回退。这是给自建网关留的入口。

下面这段验证「整串模型名原样转发」。把它存成 `multi_provider_router.py`，放在 SDK 根目录 `openai-agents-python/` 下，换成你的端点与 key 后运行。

```python
import asyncio

from agents import Agent, MultiProvider, RunConfig, Runner


async def main() -> None:
    provider = MultiProvider(
        openai_base_url="https://openrouter.ai/api/v1",
        openai_api_key="sk-...",
        openai_prefix_mode="model_id",
        unknown_prefix_mode="model_id",
    )
    # 此时 openrouter/openai/gpt-4.1-mini 会整串发给该端点
    agent = Agent(name="Assistant", model="openrouter/openai/gpt-4.1-mini")
    result = await Runner.run(agent, "Hello", run_config=RunConfig(model_provider=provider))
    print(result.final_output)


if __name__ == "__main__":
    asyncio.run(main())
```

运行它：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python multi_provider_router.py
```

预期结果是：`openrouter/openai/gpt-4.1-mini` 整串发给该端点，前缀不会被剥掉，终端打印出模型回答。

---

## 19.6 LiteLLM 与 any-llm：第三方适配层

两个适配器都是 beta、best-effort。装上就能用，但别指望它们与官方路径等价。安装方式与入口类如下。

| 适配器 | 安装 | 模型类 | Provider | 模型名示例 |
| --- | --- | --- | --- | --- |
| LiteLLM | `pip install "openai-agents[litellm]"` | `LitellmModel` | `LitellmProvider` | `litellm/anthropic/claude-sonnet-4` |
| any-llm | `pip install "openai-agents[any-llm]"` | `AnyLLMModel` | `AnyLLMProvider` | `any-llm/openrouter/openai/gpt-4.1` |

先装额外依赖，再跑下面的脚本。这条命令一次只装一个 extra。

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
uv pip install -e ".[litellm]"
```

下面这段验证「请求经 LiteLLM 转发到 Anthropic 的模型」。把它存成 `litellm_agent.py`，放在 SDK 根目录 `openai-agents-python/` 下，配好对应环境的 key 后运行。

```python
import asyncio

from agents import Agent, Runner
from agents.extensions.models.litellm_model import LitellmModel


async def main() -> None:
    agent = Agent(
        name="Claude agent",
        model=LitellmModel(model="anthropic/claude-sonnet-4"),
    )
    result = await Runner.run(agent, "用一句话解释递归。")
    print(result.final_output)


if __name__ == "__main__":
    asyncio.run(main())
```

运行它：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python litellm_agent.py
```

预期结果是：该 Agent 的请求经 LiteLLM 转发到 `anthropic/claude-sonnet-4`，终端打印出回答。

`AnyLLMModel` 多一个 `api="responses" | "chat_completions"` 参数，用来固定上游表面。用它们之前请记住三条。

- 能力取决于上游，而不是 SDK。
- 用量上报常常要 `ModelSettings(include_usage=True)`。
- `LitellmModel` 目前不填充 `ModelResponse.request_id` 与 `raw_usage`。

如果只是用 OpenAI 模型，别为了「看起来通用」多套一层适配器。每次多一跳，就多一处语义损失。

---

## 19.7 自定义 Provider 与 Model：写对抽象方法名

0.25.0 的 `Model` 抽象接口只有两个必须实现的方法：**`get_response`** 与 **`stream_response`**。名字容易记错，尤其第二个不是 `get_streamed_response`。签名可以从 `repo/src/agents/models/interface.py` 直接抄。

> 0.25 起 `Model` 还多了一个**可选钩子** `get_default_model_settings()`。SDK 用它推导「未显式设置时该模型该用什么默认参数」，例如 GPT-5 系列的 reasoning 与 verbosity。不实现也能跑，只有当你希望自定义模型在默认参数上与其他 provider 对齐时才需要重写。
>
> 与之对应，0.25 修正了「隐式默认值 vs 显式赋值」的区分。完全没写 `reasoning` 与显式写 `reasoning=None`，现在不会再被混为一谈。

下面这段验证「只要 `get_response` 返回合法的 `ModelResponse`，整个运行循环就能跑」。把它存成 `echo_model.py`，放在 SDK 根目录 `openai-agents-python/` 下，它不联网、不需要 key。

```python
import asyncio
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


async def main() -> None:
    agent = Agent(name="Echo agent")
    result = await Runner.run(
        agent, "你好", run_config=RunConfig(model_provider=EchoProvider())
    )
    print(result.final_output)


if __name__ == "__main__":
    asyncio.run(main())
```

运行它：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python echo_model.py
```

预期结果是打印一行以「收到：」开头的文本；当 `input` 是原始字符串时原样回显，是消息列表时显示「（非字符串输入）」。工具、护栏、交接（handoff）全部照常工作。几个必须知道的细节如下。

- `ModelResponse` 只有 `output`、`usage`、`response_id` 是必填，`request_id` 与 `raw_usage` 可选。`request_id` 是排障时唯一的传输层线索，自研适配器能拿到就填。
- `output` 里的元素是 **Responses 格式的 output item**，必须是 `ResponseOutputMessage`、`ResponseFunctionToolCall` 这类对象。手写 dict 在多数情况下会被 Pydantic 宽容地转换，但字段缺失时就变成难查的校验错误。照 `agents.testing.assistant_message()` 的构造方式写最稳。
- `stream_response` 必须存在（抽象方法）。要真正支持流式，你得按 `response.created → response.output_item.added → … → response.completed` 的事件序列产出。手写这串事件没有教学价值；测试场景请直接用第 23 章的 `ScriptedModel`，它已经替你生成了完整序列。
- 模型可以覆写 `get_default_model_settings()` 与 `close()`。前者给命名空间型模型 ID 提供默认参数，后者释放长连接。

---

## 19.8 ModelSettings：所有字段一次看全

`ModelSettings` 在 0.25.0 有 25 个字段，全部可选。按用途分成八组，查表即可。

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

合并语义是本章第二重要的机制（第一是解析顺序）。`ModelSettings.resolve()` 有四条规则。

1. 只覆盖 override 中**非 None** 的字段，因此「把某个值改回默认」不能靠 `None`。
2. `extra_args` 特殊：两边都是字典时**逐键合并**，不是替换。
3. `retry` 深合并：Agent 只改 `max_retries`，仍继承 RunConfig 的 `policy`。
4. 传字典而不是实例时，SDK 会校验字段名，拼错直接 `TypeError`（Unknown model settings）。

最后一条是很实用的护栏。写 `ModelSettings(temprature=0.2)` 不会沉默地按默认值跑，而是立刻报错。

下面这段验证「常用的几组参数能共存于同一个 `ModelSettings`」。把它存成 `model_settings_demo.py`，放在 SDK 根目录 `openai-agents-python/` 下，配好 key 后运行。

```python
import asyncio

from openai.types.shared import Reasoning

from agents import Agent, ModelSettings, Runner


async def main() -> None:
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
    result = await Runner.run(agent, "用两句话解释缓存命中率。")
    print(result.final_output)


if __name__ == "__main__":
    asyncio.run(main())
```

运行它：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python model_settings_demo.py
```

预期结果是：该 Agent 以高推理强度、低 verbosity 运行，关闭并行工具调用，带 45 秒超时，并打印出回答。

> 注意：不要同时用直接字段和 `extra_args` 传同一个请求参数。`extra_args` 是给 SDK 还没暴露的供应商字段留的逃生舱。两边都写，会让「到底哪个生效」变成实现细节。

---

## 19.9 模型选择与成本：三条可执行的判断

选型可以落到三条判断上：先分档，再降强度，最后守住最坏情况。

**第一条：先按任务分档，不要全站一个模型。** 分诊、抽取、改写这类短任务用 `gpt-5-nano` 或 `gpt-5.6-luna` 一档。需要长链推理的规划、代码改写用 `gpt-5.6-sol`。第 11 章的多智能体模式里，「便宜模型分诊 + 贵模型处理」是最常见也最有效的组合。

**第二条：延迟敏感时先降推理强度，再换模型。** 文档明确建议 GPT-5 系列用 `reasoning.effort="none"` 换低延迟，换模型是更大的动作。`verbosity="low"` 则直接压缩输出 token。

**第三条：把不确定性花在「上限」而不是「平均」上。** `max_turns`（默认 10）、`ModelSettings.timeout` 与 `retry` 决定的是最坏情况。没有 `timeout` 的模型调用，在网关抖动时会把整个请求拖死。`retry` 则是**显式 opt-in** 的，不配就不重试。这一点和很多框架的默认行为相反。

---

## 常见坑与排查

按症状查，每条都给出「症状 → 原因 → 修法」。

1. **症状**：给 Agent 传了 `Model` 实例，`MultiProvider` 的前缀或 WebSocket 开关全部失效。
   **原因**：`get_model()` 第 1、3 分支直接返回实例，provider 与传输选择根本不参与。
   **修法**：想保留路由就用字符串；确实要用实例时，在构造实例时就选对类（`OpenAIResponsesWSModel` / `OpenAIChatCompletionsModel`）。

2. **症状**：换到非 OpenAI 端点后 404，或 `prompt` / `previous_response_id` 毫无效果。
   **原因**：默认走 Responses，很多兼容端点只实现了 Chat Completions；而 Chat Completions 会静默丢弃 Responses-only 字段。
   **修法**：`set_default_openai_api("chat_completions")` 或显式用 `OpenAIChatCompletionsModel`；开发期加 `strict_feature_validation=True`，让不兼容立刻报错。

3. **症状**：`OPENAI_DEFAULT_MODEL` 设了却没生效，或 Azure 部署名报 model not found。
   **原因**：`get_default_model()` 会对环境变量值做 `.lower()`；且默认模型只在 `agent.model is None` 时启用。
   **修法**：改用 `RunConfig(model=...)` 或显式 `Agent(model=...)`，绕开大小写归一化。

4. **症状**：`ModelSettings(temprature=0.2)` 报 `TypeError`。
   **原因**：0.25.0 对 SDK 自有配置类型做未知字段校验，这是**预期行为**，不是 bug。
   **修法**：改成正确拼写；确实要传供应商私有字段，用 `extra_args`。

5. **症状**：构造 `OpenAIProvider` 时抛 `UserError: Don't provide api_key, base_url, websocket_base_url, organization, or project if you provide openai_client`。
   **原因**：`openai_client` 一旦传入就是唯一真相，其余凭据与端点参数必须全部写进那个 client。
   **修法**：二选一。要么只传 `openai_client=AsyncOpenAI(api_key=..., base_url=...)`，要么只传 `api_key` / `base_url` 让 provider 自己造 client，不要两边同时给。

6. **症状**：接第三方适配器后 `usage.total_tokens` 一直是 0，或 `request_id` 全是 `None`。
   **原因**：流式 Chat Completions 常需要显式请求用量；`LitellmModel` 不填充 `request_id` 与 `raw_usage`。
   **修法**：加 `ModelSettings(include_usage=True)`；排障改用日志与 trace，不要依赖 `request_id`。

---

## 动手练习

下面三项都在 SDK 根目录里做。若仓库 clone 在别处，把 `openai-agents-python` 换成自己的路径即可。

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
ls pyproject.toml
```

1. **验证优先级**：建两个 Agent（一个 `model=None`，一个 `model="gpt-5-nano"`），用同一个 `RunConfig(model="gpt-5.6-sol")` 各跑一次。打印 `result.raw_responses[-1].response_id` 与日志里的模型名，确认 RunConfig 是否压过 Agent。
2. **写一个严格模式开关**：把 `strict_validation.py` 里的 `previous_response_id` 分别设成 `None` 和 `"resp_fake"` 各跑一次，记录两次的异常类型与消息。
3. **改造仓库示例**：打开 `repo/examples/model_providers/custom_example_provider.py`，把它改造成「按模型名前缀选择 Chat Completions 或 Responses」的 `MultiProvider` 版本。提示：用 `provider_map` 注册自定义前缀，别去改内置回退。

---

## 本章小结

- 开篇五项局部配置一次列全：`api_key`、`base_url`、`openai_client`、`model`、`use_responses`；`openai_client` 与其余凭据同传抛 `UserError`。
- Provider 层局部配置与第 2 章全局配置不冲突：局部只作用于当次运行，全局继续兜底。
- 解析顺序：`RunConfig.model`（实例 > 字符串）> `Agent.model`（实例）> `provider.get_model(agent.model)`。
- 传字符串等于每次解析、受全局开关影响；传实例等于通道在构造时锁定。
- 默认模型是 `gpt-5.6-luna`，`OPENAI_DEFAULT_MODEL` 可覆盖且会被 `.lower()`。
- Responses 是推荐路径，Chat Completions 会静默丢弃 Responses-only 字段，用 `strict_feature_validation` 兜底。
- `MultiProvider` 是 `RunConfig` 的默认 provider，用前缀路由，`provider_map` 优先于内置回退。
- `Model` 的抽象方法是 `get_response` 与 `stream_response`；`ModelProvider` 只需要 `get_model`；`ModelSettings` 的合并是「非 None 覆盖 + `extra_args` 合并 + `retry` 深合并」。

---

## 延伸阅读

- 模型总览与路由：`repo/docs/models/index.md`
- LiteLLM 迁址说明：`repo/docs/models/litellm.md`
- 全局默认与日志：`repo/docs/config.md`
- 示例：`repo/examples/model_providers/custom_example_global.py`、`repo/examples/model_providers/custom_example_provider.py`、`repo/examples/model_providers/custom_example_agent.py`、`repo/examples/model_providers/litellm_provider.py`、`repo/examples/model_providers/any_llm_provider.py`
- 重试与超时：`repo/examples/basic/retry.py`
- 源码：`repo/src/agents/models/interface.py`、`repo/src/agents/models/openai_provider.py`、`repo/src/agents/models/multi_provider.py`、`repo/src/agents/models/default_models.py`、`repo/src/agents/model_settings.py`
- 下一章：《第20章 结构化输出与output_type》，把「模型说什么」变成可入库的对象。
