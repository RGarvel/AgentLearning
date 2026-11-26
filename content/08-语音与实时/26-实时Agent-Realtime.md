# 第26章 实时 Agent Realtime

第 25 章把语音拆成三段：转写 → Agent → 合成。每一段都可以替换、都可以调试，但每一段都往延迟里加时间。

这一章讲另一种答案：**把音频帧直接喂给模型，模型直接吐音频**，中间的文本只作为副产物存在。

本章解决的真实问题：什么场景该放弃三段式、改用端到端；改用之后工具、handoff、护栏、打断还剩多少；以及这套东西在你的服务端怎么摆。读完你会拿到一张取舍表、一套最小闭环，和三条不能踩的硬限制。

---

## 学习目标

- 能说清 realtime（端到端 speech-to-speech）与 VoicePipeline（三段式）的取舍边界，并给出选择理由。
- 能写出 RealtimeAgent + RealtimeRunner + RealtimeSession 的最小闭环，并说明为什么必须先 `async with`。
- 能读懂 RealtimeRunConfig 的 model_settings 嵌套结构（audio.input / audio.output），知道旧扁平字段为什么不该再用。
- 能列出 realtime 下 handoff 与 guardrails 的三条硬限制，并解释 `guardrail_tripped` 的恢复流程。
- 能画出浏览器 / 服务端 / SIP 三种部署拓扑，并指出为什么浏览器不能直连。
- 能用 `RealtimePlaybackTracker` 解释"打断位置为什么会错"。

---

## 一、端到端 vs 三段式：先做选择

**先给结论：业务逻辑要控流程就选三段式，核心体验要自然就选端到端。**

| 维度 | 三段式（VoicePipeline） | 端到端（Realtime） |
| --- | --- | --- |
| 延迟 | 转写 + 推理 + 合成逐段相加 | 单跳，首字节明显更快 |
| 打断 | SDK 不提供，自己做 | 内建（VAD + `audio_interrupted` + 历史回填） |
| 中间可插入逻辑 | 任意 Python 代码 | 只有工具与 handoff |
| 工具调用 | 完整支持 | 支持，且可配审批 |
| handoff | 完整（含 `input_filter`） | 支持但不支持 `input_filter` |
| 护栏 | 输入 / 输出 / 工具全套 | 输出护栏 + 工具护栏，没有用户输入护栏 |
| 可观测性 | trace 完整、可复现 | 事件流为主，靠 `raw_model_event` 下钻 |
| 调试成本 | 低（每一步都能单测） | 高（时序、音频缓冲、网络抖动） |
| 计费 | 按转写秒数 + 文本 token + 合成字符 | 按音频 token 计费，长会话成本更敏感 |

还有一个差别容易被忽略：**三段式的每一步都是可缓存的**。同样的转写文本可以复用 Agent 的 session，也可以只重跑 TTS。端到端则是一条长连接上的连续上下文，很难"只重放后半段"。所以做评测（第 23 章）时，三段式更容易构造确定性用例。

判断口径很简单。**业务逻辑必须"先想清楚再说话"（查库、算价、走审批），三段式更容易控；核心体验是"像打电话一样自然"，选 realtime。**两者并不互斥，不少生产系统用 realtime 做前台，用三段式的思路在工具里做重活。

---

## 二、四个对象，各管一段

**这套东西有四个对象，职责边界比三段式更细。**

| 对象 | 角色 | 关键事实 |
| --- | --- | --- |
| `RealtimeAgent` | 一个实时专家 | 字段比 `Agent` 窄：没有 `model`、`model_settings`、`output_type`、`tool_use_behavior` |
| `RealtimeRunner` | 会话工厂 | 默认用 `OpenAIRealtimeWebSocketModel`；`run()` 返回 `RealtimeSession`，不是最终结果 |
| `RealtimeSession` | 活着的会话 | 持有本地历史、后台工具执行、护栏状态、当前 Agent；发事件给你 |
| `RealtimeModel` | 传输抽象 | 自定义 transport 就实现这个接口 |

`RealtimeAgent` 的收窄是设计决定，不是漏做。所有 Agent 在同一个会话里共用一个模型，所以"每个 Agent 选模型"没有意义。结构化输出在实时语音里也无处安放。

它的字段只有两批。第一批继承自 `AgentBase`：`name`、`handoff_description`、`tools`、`mcp_servers`、`mcp_config`。第二批是自己的：`instructions`、`prompt`、`handoffs`、`output_guardrails`、`hooks`。

> 注意：`voice` 可以在 Agent 级配置，但**第一个 Agent 已经发出声音之后就不能再改**。这是会话级的音频输出设置，换 Agent 不会重置它。

---

## 三、最小闭环

**跑通最小闭环只需要一个 RealtimeAgent 加一个会话。**

下面这段验证三件事：会话怎么进、事件怎么消费、`async with` 该套在谁身上。为了让链路先跑通，输入用文本而不是麦克风：

```python
import asyncio

from agents.decorators import tool
from agents.realtime import RealtimeAgent, RealtimeRunner, RealtimeSessionEvent


@tool
def get_weather(city: str) -> str:
    """查询城市天气。"""
    return f"{city} 今天晴，22 度。"


agent = RealtimeAgent(
    name="前台助理",
    instructions="你是电话前台。回答简短口语化，需要查天气时调用工具。",
    tools=[get_weather],
)


async def main() -> None:
    runner = RealtimeRunner(starting_agent=agent)

    async with await runner.run() as session:
        await session.send_message("你好，帮我查一下杭州天气")   # 文本输入，便于先跑通
        async for event in session:
            handle(event)


def handle(event: RealtimeSessionEvent) -> None:
    if event.type == "audio":
        play(event.audio.data)          # 原始音频字节
    elif event.type == "audio_end":
        print("这段音频说完了")
    elif event.type == "audio_interrupted":
        player.flush()                  # 立刻停播，见第七节
    elif event.type == "tool_start":
        print("调用工具:", event.tool.name)
    elif event.type == "error":
        print("会话错误:", event.error)


if __name__ == "__main__":
    asyncio.run(main())
```

预期结果：事件顺序是 `agent_start` → `tool_start`（打印"调用工具: get_weather"）→ `tool_end` → 若干 `audio` → `audio_end`。

跑之前先把 SDK 装好。若你的 clone 在别的目录，按自己的路径替换 `cd` 后面那段：

```bash
# 工作目录：repo/openai-agents-python/（SDK 根目录）
cd repo/openai-agents-python
uv pip install -e .
```

三个必须记住的点：

| 要点 | 说明 |
| --- | --- |
| `async with` 的对象是 `run()` 的返回值 | `runner.run()` 是协程，返回 `RealtimeSession`，所以写成 `async with await runner.run() as session:`；漏掉 `await` 会得到 `TypeError: 'coroutine' object does not support the asynchronous context manager protocol` |
| 不用上下文管理器就得手动收尾 | `session = await runner.run()` 之后要 `await session.enter()`，结束时**必须** `await session.close()`，否则 WebSocket 和后台工具任务都会泄漏 |
| 事件循环会自然结束 | `async for event in session` 在会话关闭或服务端正常断开时自行退出，不抛异常；真正的失败通过 `error` 事件和 `raw_model_event` 里的异常事件表达 |

---

## 四、RealtimeRunConfig：两层配置

**配置分两层：运行级传在 runner 上，会话级放在 `model_settings` 里。**

| 层 | 传在哪 | 管什么 |
| --- | --- | --- |
| 运行级 | `RealtimeRunner(config={...})` | `model_settings`、`output_guardrails`、`guardrails_settings`、`async_tool_calls`、`tool_execution`、`tool_error_formatter`、`tracing_disabled` |
| 会话/模型级 | `model_settings` 里面（或 `runner.run(model_config=...)` 的 `initial_model_settings`） | 模型名、音频输入输出、轮次检测、转写、声音、工具选择 |

`model_settings` 里最值钱的是嵌套的 `audio`。下面这段验证嵌套结构与几个常用键：

```python
runner = RealtimeRunner(
    starting_agent=agent,
    config={
        "model_settings": {
            "model_name": "gpt-realtime-2.1",
            "audio": {
                "input": {
                    "format": "pcm16",
                    "transcription": {"model": "gpt-live-transcribe", "languages": ["zh", "en"]},
                    "turn_detection": {"type": "semantic_vad", "interrupt_response": True},
                    "noise_reduction": {"type": "near_field"},
                },
                "output": {"format": "pcm16", "voice": "ash", "speed": 1.0},
            },
            "tool_choice": "auto",
        }
    },
)
```

预期结果：会话用 `gpt-realtime-2.1`，输入 pcm16 加近场降噪，按 semantic_vad 断句且允许打断，输出 pcm16、ash 音色。

四个键的细节值得单独说：

| 键 | 说明 |
| --- | --- |
| `audio.input.format` / `audio.output.format` | 可选 `pcm16`、`g711_ulaw`、`g711_alaw`，也可以传 `{"type": "audio/pcm", "rate": 24000}` 这样的映射；电话链路通常用 `g711_ulaw` |
| `audio.input.turn_detection` | `type` 是 `semantic_vad` 或 `server_vad`；`interrupt_response` 决定用户插话能不能打断；`create_response` 决定检测到一轮结束是否自动生成回复。**设成 `None` 就关掉自动检测**，你必须自己发 `input_audio_buffer.commit` 和 `response.create` |
| `audio.input.transcription` | `gpt-live-transcribe` 走低延迟增量转写，支持 `prompt`、`keywords`、`languages`（复数，不要再传 `language`）；`gpt-realtime-whisper` 才支持 `delay`（`minimal` 到 `xhigh`）。转写只影响"你看到的字幕"，不影响模型听到的音频 |
| 旧扁平字段 | `input_audio_format`、`voice`、`turn_detection` 这些写法仍然被接受，但新代码统一用 `audio` 嵌套结构 |

---

## 五、事件模型

**`RealtimeSession` 把底层事件翻译成两层：高层语义事件，和 `raw_model_event` 包装的原始事件。**

| 高层事件 | 用途 |
| --- | --- |
| `agent_start` / `agent_end` | 当前 Agent 开始/结束回答 |
| `handoff` | 会话从一个 Agent 转到另一个 |
| `tool_start` / `tool_end` | 本地函数工具执行 |
| `tool_approval_required` | 工具需要人工批准，会话暂停等待 |
| `audio` / `audio_end` | 音频块与"这段说完了" |
| `audio_interrupted` | 被打断，应立即停止本地播放 |
| `history_added` / `history_updated` | 本地历史变化，做 UI 通常只监听这两个 |
| `guardrail_tripped` | 输出护栏命中 |
| `input_audio_timeout_triggered` | 输入音频静默超时 |
| `error` | 会话级错误 |
| `raw_model_event` | 原始模型事件（含用量、连接状态、流结束） |

做 UI 时不要两个都听。`history_added` 只给"刚新增的那一条"，适合追加渲染；`history_updated` 给完整列表，适合整体重绘与对账。两者都会在工具调用、转写、打断回填时触发，频率很高，务必做节流。

用量从 `raw_model_event` 拿。`isinstance(event.data, RealtimeModelUsageEvent)` 可以拿到单次响应的 token 明细；累计用量在下次高层事件的 `event.info.context.usage` 上，也就是你的 `RunContextWrapper.usage`。

---

## 六、handoff 与 guardrails 的三条硬限制

**realtime 下的 handoff 与护栏有三条硬限制，写代码前得先知道。**

**限制一：handoff 没有 `input_filter`。**`RealtimeAgent` 直接放进 `handoffs` 会被自动包装；想定制名字、描述、可用性就用 `realtime_handoff(...)`。下面这段验证包装写法：

```python
from agents.realtime import RealtimeAgent, realtime_handoff

billing = RealtimeAgent(name="账务专员", instructions="只管账单和退款。")
front = RealtimeAgent(
    name="客服前台",
    instructions="先判断诉求，必要时转接。",
    handoffs=[realtime_handoff(billing, tool_description_override="转接到账务专员")],
)
```

预期结果：前台拿到的转接工具描述是"转接到账务专员"，而不是默认生成的描述。

**限制二：没有用户输入护栏。**`RealtimeAgent` 只有 `output_guardrails` 字段，输入侧只有**工具**的输入护栏。想拦截用户说的话，只能自己在 `send_message` / `send_audio` 之前做，或者干脆把敏感动作放进工具里守。

**限制三：护栏命中不抛异常，而是走恢复流程。**输出护栏是**去抖**执行的，每累积 `debounce_text_length`（默认 100）字符才检查一次，不会对每个 delta 都跑。命中后 SDK 依次做三件事：取消当前响应、发 `guardrail_tripped`、追加一条点名该护栏的用户消息，让模型重新生成。

```python
from agents.guardrail import GuardrailFunctionOutput, OutputGuardrail


def no_password(context, agent, output):
    return GuardrailFunctionOutput(
        tripwire_triggered="密码" in output,
        output_info=None,
    )


agent = RealtimeAgent(
    name="助理",
    instructions="不要复述用户的密码。",
    output_guardrails=[OutputGuardrail(guardrail_function=no_password)],
)
```

预期结果：输出里出现"密码"时，这一轮被取消，会话收到 `guardrail_tripped`，模型重新生成一版不带密码的回答。

> 注意：护栏命中时可能已经有音频缓冲在你的播放器里了。**必须监听 `audio_interrupted` 并立即 flush**，否则用户会听到半句被判定为违规的话。

---

## 七、打断：服务端判、本地停

**打断要"服务端判、本地停"，两件事都得做对，缺一半都会出问题。**

打断是 realtime 最值钱的能力，也是最多人做错的地方。四个要点：

| 要点 | 说明 |
| --- | --- |
| 服务端侧 | `turn_detection.interrupt_response=True` 时，用户一开口，服务端就取消正在生成的响应，SDK 发 `audio_interrupted` 并把"模型实际被听到的内容"回填进历史 |
| 本地侧 | `audio_interrupted` 只是通知。你的播放器队列里可能还压着几百毫秒音频，**必须自己 flush**，最好带 10-20ms 淡出（直接清空会"啪"一声） |
| 主动打断 | `await session.interrupt()` 发 `RealtimeModelSendInterrupt(force_response_cancel=True)`，取消生成但**不取消正在运行的工具** |
| 播放器进度 | 模型生成音频的速度远快于真实播放。低延迟本地播放可以假设"生成即播放"；**电话、远程、跨网络场景必须传 `RealtimePlaybackTracker`**，用 `on_play_bytes()` / `on_play_ms()` 报告真实播放位置，否则服务端按"全部已播"来截断，历史里留下的和用户实际听到的对不上 |

---

## 八、拓扑：谁连谁

**Python SDK 只有两条路：服务端 WebSocket（默认）和 SIP attach。**

| 拓扑 | 形态 | 何时用 |
| --- | --- | --- |
| 服务端 WebSocket | 浏览器 ⇄ 你的服务 ⇄ Realtime API | 默认推荐；密钥留在服务端，工具与审批也在服务端 |
| SIP attach | 电话网络 ⇄ OpenAI ⇄ 你 `call_id` attach | 呼叫中心、Twilio 接入 |

浏览器 WebRTC 不在这个 SDK 里。最常见的错误拓扑是"浏览器直连 OpenAI 并带上 API key"，那等于把密钥发到每个用户的浏览器。

下面这段验证两件事：自定义 transport 参数，以及换端点、换鉴权：

```python
from agents.realtime import OpenAIRealtimeWebSocketModel, RealtimeRunner

# 想调 WebSocket 心跳/超时/单帧上限，就自己构造 transport
model = OpenAIRealtimeWebSocketModel(
    transport_config={"ping_interval": 20.0, "ping_timeout": 60.0, "max_size": 8 * 1024 * 1024}
)
runner = RealtimeRunner(starting_agent=agent, model=model)

# 换端点 / 换鉴权（Azure）：model_config
session = await runner.run(
    model_config={
        "url": "wss://<your-resource>.openai.azure.com/openai/v1/realtime?model=<deployment>",
        "headers": {"api-key": "<key>"},   # 传了 headers 就不会自动加 Authorization
    }
)
```

预期结果：连接按 20 秒心跳、60 秒超时、单帧 8MB 上限运行；Azure 场景下鉴权改用 `api-key` 头，不再自动带 `Authorization`。

服务端示例可以直接读 `repo/examples/realtime/app/server.py`。它用 FastAPI 的 `/ws/{session_id}` 收浏览器消息，转成 `session.send_audio()` / `session.send_message()` / `session.approve_tool_call()`，再把 `RealtimeSessionEvent` 序列化回浏览器。这条链路就是一个生产骨架：浏览器只管采集与播放，密钥、工具、审批全在服务端。

---

## 常见坑与排查

1. **`TypeError: 'coroutine' object does not support the asynchronous context manager protocol`**
   原因：写成了 `async with runner.run() as session`。修法：改成 `async with await runner.run() as session`，或先 `await` 再 `enter()`。

2. **给 RealtimeAgent 设 `model` 或 `output_type` 报错/无效**
   原因：这些字段被刻意去掉了。修法：模型名放 `model_settings.model_name`；结构化输出改走"工具返回结构化结果"。

3. **打断后还有声音在播，或历史里多了一句没听到的话**
   原因：只监听了事件、没 flush 播放器；远程场景没传 `playback_tracker`。修法：`audio_interrupted` 时立即清空队列并淡出；电话链路挂 `RealtimePlaybackTracker`。

4. **改了 `voice` 没生效**
   原因：会话里第一个 Agent 已经发过声。修法：voice 只在会话开始时设一次；要变声只能新开会话。

5. **`turn_detection` 设成 `None` 后模型永远不回复**
   原因：关掉自动检测等于关掉自动回复。修法：自己发 `input_audio_buffer.commit` 与 `response.create`，通过 `session.model.send_event(RealtimeModelSendRawMessage(...))`。

6. **`tool_approval_required` 事件来了但会话卡住**
   原因：审批是你的事，SDK 只负责暂停。修法：`await session.approve_tool_call(event.call_id)` 或 `await session.reject_tool_call(...)`。注意带 input guardrails 的工具默认在批准后才跑护栏，需要前置检查就配 `tool_execution.pre_approval_tool_input_guardrails=True`。

---

## 动手练习

1. **文本先行**：用第三节骨架，只发 `send_message`，把全事件打到控制台。确认顺序是 `agent_start → tool_start → tool_end → agent_end`，并找出 `history_updated` 出现在哪。
2. **关掉自动轮次检测**：把 `turn_detection` 设为 `None`，手动用 `send_audio(..., commit=True)` 提交一轮，再发 `response.create`，体会"手动控制"和"自动 VAD"的差别。
3. **改造示例**：打开 `repo/examples/realtime/cli/demo.py`，把"助手播报时用 RMS 门限做 barge-in"那段（`capture_audio` 里的 `ENERGY_THRESHOLD` 逻辑）换成"只按 `audio_interrupted` 事件驱动"，对比哪种在扬声器外放时误触发更少。

---

## 本章小结

- 端到端 realtime 换掉的是"中间那层文本"，换来更低延迟和内建打断，代价是可插入逻辑与可观测性；浏览器不能直连，服务端 WebSocket 或 SIP attach 才是 SDK 支持的拓扑。
- 四个对象：`RealtimeAgent`（窄）、`RealtimeRunner`（工厂）、`RealtimeSession`（活会话）、`RealtimeModel`（传输）。
- 配置分运行级与会话级；音频相关全在 `model_settings.audio` 的嵌套结构里，旧扁平字段仅兼容。
- 事件分两层：高层语义事件做 UI，`raw_model_event` 做下钻与用量统计。
- handoff 无 `input_filter`，护栏只有输出侧 + 工具侧，命中走 `guardrail_tripped` 恢复而不是抛异常。
- 打断要"服务端判 + 本地停"，远程播放必须上报 `RealtimePlaybackTracker`。

---

## 延伸阅读

- 指南与生命周期：`repo/docs/realtime/guide.md`
- 传输选型：`repo/docs/realtime/transport.md`
- 快速开始：`repo/docs/realtime/quickstart.md`
- 示例：`repo/examples/realtime/cli/demo.py`、`repo/examples/realtime/app/server.py`、`repo/examples/realtime/twilio_sip/server.py`
- 源码：`repo/src/agents/realtime/agent.py`、`repo/src/agents/realtime/runner.py`、`repo/src/agents/realtime/session.py`、`repo/src/agents/realtime/config.py`、`repo/src/agents/realtime/events.py`
- 上一章：《第25章 语音流水线 VoicePipeline》如果你只需要"录音进、语音出"，三段式往往更省事。
- 下一章：《第27章 源码架构走读》从这一章开始，我们换到源码视角，看这些能力是怎么被组织进 `src/agents` 的。
