# 第25章 语音流水线 VoicePipeline

第 24 章我们把 Agent 的运行过程"看见"了：trace、items、日志。这一章换个方向，把 Agent 搬到电话线上。

语音不是新的一套运行时。它只是包在 Runner 外面的一层适配器。想通这一点，"语音 Agent"就不再是一门新学问。

本章解决的真实问题：**用户对着麦克风说话，怎么变成 Agent 能处理的文本，再把 Agent 的回答变回声音，并且中途不卡顿、能被打断、能测试。**读完你会清楚每一段归谁负责、失败从哪冒出来，以及怎么在没有麦克风的机器上跑测试。

这一章只给一条主线：先装 `voice` 可选依赖、配齐 key，跑通仓库自带的静态语音示例；再用一个静音缓冲区的最小脚本看懂三段式；最后学自定义 workflow、打断和测试。三种音频输入里默认走整段 `AudioInput`，麦克风流式降级为"可选微调"放在主线之后。

---

## 学习目标

- 能说清 `VoicePipeline` 的三段式（STT → workflow → TTS）中每一段归谁负责、失败时错误从哪冒出来。
- 能装齐 `voice` 可选依赖与 API key，跑通 `examples/voice/static/main.py`，在扬声器听到合成语音。
- 能写出一个最小可运行骨架，分别用 `AudioInput`（整段音频）和 `StreamedAudioInput`（麦克风流）喂数据。
- 能用 `VoicePipelineConfig` 配置 STT/TTS 模型、语音、语言与追踪开关，并解释每个字段的副作用。
- 能判断一个"打断"需求 SDK 做没做（答案：没做），并知道该监听哪个生命周期事件自己实现。
- 会用 `agents.voice.testing` 里的脚本化模型写出不需要麦克风、不需要网络的语音测试。

---

## 一、三段式：语音只是一层适配器

**语音流水线（voice pipeline）从头到尾只有三段：转写（speech-to-text）、workflow、合成（text-to-speech）。**

`VoicePipeline` 的 docstring 把设计意图写得很直白，见 `repo/src/agents/voice/pipeline.py`。它只做三件事：

1. 把音频输入转成文本（speech-to-text）；
2. 运行你给的 workflow，它产出一串文本；
3. 把这些文本流转成流式音频输出（text-to-speech）。

关键在于第 2 步：**"你的代码"在中间，SDK 不关心你里面是不是 Agent**。你可以是一个 Agent，也可以是三个 Agent 轮流上、纯规则逻辑，甚至直接 yield 一句硬编码的话。

语音层只认一个接口。下面这段是接口定义片段，摘自 `repo/src/agents/voice/pipeline.py`，不是独立运行的脚本：

```python
class VoiceWorkflowBase(abc.ABC):
    @abc.abstractmethod
    def run(self, transcription: str) -> AsyncIterator[str]: ...

    async def on_start(self) -> AsyncIterator[str]: ...  # 可选，用于开场白
```

预期结果：只要实现 `run()`，语音层就能驱动你的全部逻辑。注意 `run` 的类型标注是 `-> AsyncIterator[str]`，而基类用的是普通 `def`。

实现时两种写法都合法：**普通 `def` + `yield`**（生成器函数），或 **`async def` + `yield`**（异步生成器函数，仓库里的 `repo/examples/voice/streamed/my_workflow.py` 就是这种）。真正会炸的是第三种：`async def` 里**只 `return` 不 `yield`**。那它变成协程，`async for` 会报 `TypeError: 'coroutine' object is not async iterable`。

整条链路的形状如下，文本在中间进、音频在最后出。

```text
麦克风/文件 ──► STTModel.transcribe()          ──┐
               (整段) 或 create_session()         │ 文本
                                                  ▼
                                   VoiceWorkflowBase.run(transcription)
                                                  │ 文本流
                                                  ▼
                    StreamedAudioResult ──► TTSModel.run()  ──► PCM 字节流
                                                  │
                                                  ▼
                          VoiceStreamEventAudio / Lifecycle / Error
```

预期结果：中间那层文本是你的地盘，前后两端由 SDK 负责换格式。

> 提示：第 26 章的 Realtime 是另一种做法，音频帧直接进模型，模型直接出音频，没有中间那层文本。本章的三段式把"思考"留在你的 Python 里，所以工具、handoff、护栏全都照旧可用；代价是多了一跳转写、多了一份延迟。

---

## 二、最小可运行骨架

**不接麦克风也能跑通完整闭环，只要给一段 int16 的静音缓冲区。**

在跑任何脚本前，先把配置项一次配齐。语音是可选能力，缺任何一项都会在第一声之前失败。

| 配置项 | 怎么设 | 漏了会报什么错 |
| --- | --- | --- |
| `voice` 可选依赖 | `uv pip install -e ".[voice]"`，装 numpy + websockets | `ImportError: numpy + websockets are required` |
| API Key | `export OPENAI_API_KEY=sk-...`，Windows 用 `$env:OPENAI_API_KEY = "sk-..."` | 401 鉴权失败，或 warning `OPENAI_API_KEY is not set, skipping trace export` |
| STT 模型 | 默认 `gpt-transcribe`，官方场景可不设 | 网关场景沿用默认会报 model not found |
| TTS 模型 | 默认 `gpt-4o-mini-tts`，官方场景可不设 | 网关无此模型会报 model not found |
| 音色 `voice` | 默认 `ash`，用 `TTSModelSettings(voice="marin")` 改 | 填了不存在的音色会报 invalid voice |
| base URL / 模型名 / API 形态 | 官方默认即可；网关要给 client 传 `base_url` 与 `api_key`，再 `set_default_openai_api("chat_completions")` 并设 `Agent(model=...)` | 请求发去 `api.openai.com`、model not found 或 404 接口不支持 |
| 音频设备 | 麦克风/扬声器另装 `sounddevice` | 采集或播放时报 `ModuleNotFoundError: sounddevice` |
| 输入 `buffer` 的 dtype | 用 `np.zeros(..., dtype=np.int16)` 或 float32 | 别的 dtype 抛 `UserError` |

课程正文里写 `repo/src/agents/voice/pipeline.py` 这样的路径，点开是 v0.25.0 的源码。本机上我们把源码 clone 成 `openai-agents-python/`，两者对照如下：

| 课程里写的（可点击） | 你本机打开的文件 |
| --- | --- |
| `repo/examples/voice/static/main.py` | `openai-agents-python/examples/voice/static/main.py` |
| `repo/src/agents/voice/pipeline.py` | `openai-agents-python/src/agents/voice/pipeline.py` |

本机目录就叫 `openai-agents-python/`，不叫 `repo/`。若你的 clone 在别处，把命令里的 `openai-agents-python` 换成自己的路径即可，后文不再重复。

### 主线第 1 步：跑通仓库自带示例

先装依赖、再跑官方静态示例。这条命令在 SDK 根目录发起，音频输入由示例自己从麦克风采集：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
uv pip install -e ".[voice]"
python examples/voice/static/main.py
```

预期结果：对麦克风说一句"讲个笑话"，扬声器里放出合成语音，脚本正常退出。若机器没有麦克风，跳到下面的静音骨架，它用数组代替录音。

### 主线第 2 步：看懂最小骨架

下面这段验证"不接麦克风也能走完三段式"。把它存成 `voice_skeleton.py`，放在 SDK 根目录 `openai-agents-python/` 下：

```python
import asyncio

import numpy as np

from agents import Agent
from agents.voice import AudioInput, SingleAgentVoiceWorkflow, VoicePipeline

agent = Agent(
    name="语音客服",
    instructions="你是电话客服。回答控制在两句话内，不要用列表和 markdown。",
)


async def main() -> None:
    pipeline = VoicePipeline(workflow=SingleAgentVoiceWorkflow(agent))

    # 3 秒静音。真实场景这里是麦克风采集的 int16 数组，或从 wav 解出来的 buffer。
    buffer = np.zeros(24000 * 3, dtype=np.int16)
    result = await pipeline.run(AudioInput(buffer=buffer))

    async for event in result.stream():
        if event.type == "voice_stream_event_audio":
            play(event.data)  # np.ndarray，dtype 由 tts_settings.dtype 决定
        elif event.type == "voice_stream_event_lifecycle":
            print("lifecycle:", event.event)  # turn_started / turn_ended / session_ended
        elif event.type == "voice_stream_event_error":
            print("voice error:", event.error)


def play(chunk: np.ndarray) -> None:
    # 换成 sounddevice 的 OutputStream.write，参考 repo/examples/voice/static/util.py
    ...


if __name__ == "__main__":
    asyncio.run(main())
```

运行它：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python voice_skeleton.py
```

预期结果：屏幕按 `turn_started`、若干 `audio`、`turn_ended`、`session_ended` 的顺序打印 lifecycle 行。`play()` 目前是占位钩子，填成 `sounddevice` 的输出流就能听到声音；没有声卡就只看事件顺序。

音频输入的准备方式有三种：官方示例从麦克风采集；本骨架用 `np.zeros` 生成静音；若用手头音频文件，先用 `wave` 或 `soundfile` 解码成 int16 一维数组，再填进 `AudioInput(buffer=...)`。

三个关键点必须记住：

| 要点 | 说明 |
| --- | --- |
| `pipeline.run()` 是 `async` 的，但**不阻塞等到音频结束** | 它立刻返回 `StreamedAudioResult`，真正的转写、Agent 调用、合成都在后台 task 里跑（output._set_task(asyncio.create_task(...))） |
| 必须消费 `result.stream()` | 它是唯一的输出通道，也是错误通道；终端错误在消费过程中被抛出，见第六节 |
| 四个参数全部 keyword-only | `workflow`、`stt_model`、`tts_model`、`config`；后两个既接受已实例化的模型对象，也接受模型名字符串 |

---

## 三、音频输入：整段 vs 流式

**两种输入走两条完全不同的代码路径：一次性转写，和长连接会话。**

| | `AudioInput` | `StreamedAudioInput` |
| --- | --- | --- |
| 语义 | 一整段音频，一次性 | 持续追加的音频块 |
| 触发时机 | 直接 `transcribe()` 一次 | 服务端 VAD 判定一轮结束才回调 |
| STT 路径 | `STTModel.transcribe()`（HTTP 一次性请求） | `STTModel.create_session()`（WebSocket 长连接） |
| 适用 | 录音文件、按住说话（push-to-talk）、回归测试 | 实时对话、需要自动检测"说完了" |

`AudioInput` 只有四个字段，`buffer` 的类型限制最容易踩：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `buffer` | 无 | int16 或 float32 的 numpy 数组；别的 `dtype` 会抛 `UserError` |
| `frame_rate` | 24000 | 采样率 |
| `sample_width` | 2 | 每个采样点占 2 字节 |
| `channels` | 1 | 单声道 |

流式一侧要先把输入对象交给 pipeline，再从另一个 task 持续推数据。**这是片段，不是完整脚本**：它嵌进 `voice_skeleton.py` 的 `main()`，替换掉 `AudioInput(buffer=...)` 那次调用；`pipeline` 来自 `main()` 第一行创建的对象，`recording` 是你自己维护的录音开关，`chunk` 是 `sounddevice.InputStream` 回调里拿到的 np.int16 一维数组。下面这段验证推流与收尾：

```python
from agents.voice import StreamedAudioInput, VoicePipeline

audio_input = StreamedAudioInput()
result = await pipeline.run(audio_input)

# 另一个 task 里持续推麦克风数据，40ms 一块比较贴 OpenAI 的默认帧长
while recording:
    await audio_input.add_audio(chunk)   # chunk: np.int16 一维数组

await audio_input.add_audio(None)        # None 表示输入结束
```

预期结果：`add_audio(None)` 只关闭输入队列，转写 session 随后自行收尾。

> 注意：add_audio(None) 只是关掉输入队列，不会替你生成 `session_ended`。收尾靠转写 session 关闭后走正常的 turn 流程；如果你在写 UI，请在 finally 里把 `result.stream()` 消费干净或主动取消，否则后台 task 会残留。

**轮次检测（turn detection）由 STT 模型那一侧做，不是你判断的。**`STTModelSettings.turn_detection` 默认是 {"type": "semantic_vad"}，见 `repo/src/agents/voice/models/openai_stt.py`。也就是说"用户说完了"这件事由服务端 VAD 判断。自己实现一个"按静音时长切句"的 VAD，通常只会让切句时机和转写结果打架。

---

## 四、Workflow：从 SingleAgentVoiceWorkflow 到自定义

**`SingleAgentVoiceWorkflow` 只做四步，够用但不够灵活。**

它的全部逻辑如下，见 `repo/src/agents/voice/workflow.py`：

1. 把转写文本 append 进 _input_history；
2. `Runner.run_streamed`(self._current_agent, self._input_history, context=self._context)；
3. 用 `VoiceWorkflowHelper.stream_text_from(result)` 只挑出 `response.output_text.delta` 事件，作为文本块 yield 出去；
4. 用 `result.to_input_list()` 和 result.last_agent 更新历史与当前 Agent，所以 handoff 在语音里自动生效。

它**只支持一个起始 Agent + 无自定义逻辑**。一旦你要"用户说了暗号就切分支"，或者"先查数据库再决定用哪个 Agent"，就得继承 `VoiceWorkflowBase`。下面是完整脚本，暗号命中时直接 yield 固定话术。把它存成 `triage_workflow.py`，放在 SDK 根目录 `openai-agents-python/` 下：

```python
import asyncio
from collections.abc import AsyncIterator

import numpy as np

from agents import Agent, Runner, TResponseInputItem
from agents.voice import (
    AudioInput,
    VoicePipeline,
    VoiceWorkflowBase,
    VoiceWorkflowHelper,
)


class TriageWorkflow(VoiceWorkflowBase):
    def __init__(self, agent: Agent) -> None:
        self._history: list[TResponseInputItem] = []
        self._agent = agent

    async def on_start(self) -> AsyncIterator[str]:
        yield "您好，这里是技术支持，请描述您遇到的问题。"

    async def run(self, transcription: str) -> AsyncIterator[str]:
        self._history.append({"role": "user", "content": transcription})

        if "人工" in transcription:
            yield "正在为您转接人工客服，请稍候。"
            self._history.append({"role": "assistant", "content": "正在为您转接人工客服。"})
            return

        result = Runner.run_streamed(self._agent, self._history)
        async for delta in VoiceWorkflowHelper.stream_text_from(result):
            yield delta

        self._history = result.to_input_list()
        self._agent = result.last_agent


async def main() -> None:
    agent = Agent(name="技术支持", instructions="简短口语化地回答用户问题。")
    pipeline = VoicePipeline(workflow=TriageWorkflow(agent))
    result = await pipeline.run(AudioInput(buffer=np.zeros(24000, dtype=np.int16)))
    async for event in result.stream():
        if event.type == "voice_stream_event_lifecycle":
            print("lifecycle:", event.event)


if __name__ == "__main__":
    asyncio.run(main())
```

运行它：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python triage_workflow.py
```

预期结果：输入是静音，通常走正常的流式回答分支；把 `main()` 里的静音换成转写为"转人工"的音频，就会跳过模型调用、直接播报转接话术。

**历史要你自己维护。**`SingleAgentVoiceWorkflow` 帮你做了这件事，自定义 workflow 就得自己写。不写的话每一轮都是一次全新对话，Agent 会反复自我介绍。

`on_start()` 只在流式输入的会话开始前跑一次，适合开场白。它产出的文本会被单独收成一轮，pipeline 内部会立刻 `_turn_done()`，不会和用户第一句话粘在一起。这个细节在 0.25 里是显式处理的，早期版本确实会把问候语和第一轮回答拼成一段。

---

## 五、VoicePipelineConfig：模型、语音与追踪

**`VoicePipelineConfig` 是 dataclass，语音链路的每个旋钮都收在这里。**

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| model_provider | `OpenAIVoiceModelProvider`() | 把模型名映射成 STT/TTS 实例 |
| stt_settings | `STTModelSettings`() | 转写参数：`prompt`、`language`、`temperature`、`turn_detection`，流式还有 `languages`、`keywords` |
| tts_settings | `TTSModelSettings`() | 合成参数：`voice`、`speed`、`instructions`、`dtype`、`buffer_size`、`text_splitter`、`transform_data` |
| tracing_disabled | False | 关掉 pipeline 自己的 trace |
| tracing | None | TracingConfig，细粒度追踪配置 |
| `trace_include_sensitive_data` | True | 是否把转写文本、TTS 文本写进 trace |
| `trace_include_sensitive_audio_data` | True | 是否把音频字节写进 trace |
| workflow_name | "Voice Agent" | trace 里的 workflow 名 |
| group_id | 随机 | 串联同一次会话的多个 trace |
| trace_metadata | None | 附加元数据 |

模型默认值见 `repo/src/agents/voice/models/openai_model_provider.py`：STT 是 `gpt-transcribe`，TTS 是 `gpt-4o-mini-tts`。TTS 的 `voice` 不填时用 ash。

下面这段是完整脚本，把上面几个字段落成代码，验证配置怎么组装。把它存成 `voice_config.py`，放在 SDK 根目录 `openai-agents-python/` 下：

```python
import asyncio

import numpy as np

from agents import Agent
from agents.voice import (
    AudioInput,
    SingleAgentVoiceWorkflow,
    STTModelSettings,
    TTSModelSettings,
    VoicePipeline,
    VoicePipelineConfig,
)


async def main() -> None:
    agent = Agent(name="语音客服", instructions="简短口语化地回答。")
    config = VoicePipelineConfig(
        stt_settings=STTModelSettings(
            prompt="一通关于产品 AC-42 的客服电话。",
            languages=["zh", "en"],   # 流式多语言，优先级高于 language
            keywords=["AC-42"],       # 转写提示词，不是强制输出
        ),
        tts_settings=TTSModelSettings(
            voice="marin",
            speed=1.1,
            instructions="用平静、专业的客服语气朗读，不要补充原文没有的内容。",
            buffer_size=120,
        ),
        trace_include_sensitive_data=False,      # 生产环境建议关
        trace_include_sensitive_audio_data=False,
    )
    pipeline = VoicePipeline(workflow=SingleAgentVoiceWorkflow(agent), config=config)
    result = await pipeline.run(AudioInput(buffer=np.zeros(24000, dtype=np.int16)))
    async for event in result.stream():
        if event.type == "voice_stream_event_error":
            print("voice error:", event.error)


if __name__ == "__main__":
    asyncio.run(main())
```

运行它：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python voice_config.py
```

预期结果：pipeline 用 marin 音色、1.1 倍速合成，trace 里不再出现转写原文和音频字节。

> 注意：`trace_include_sensitive_data=False` 只影响**pipeline 自己产生的 span**（转写 span、语音 span），不影响你 workflow 内部 Runner 产生的 trace。两套开关要分别关：这里关 pipeline，`RunConfig.trace_include_sensitive_data` 关 run。

---

## 六、事件流：VoiceStreamEvent 家族

**`result.stream()` 只吐三种事件，全是 dataclass，靠 type 字段区分。**

| 事件 | 关键字段 | 什么时候来 |
| --- | --- | --- |
| `VoiceStreamEventAudio` | data: np.ndarray（int16 或 float32） | TTS 每攒够 `buffer_size` 字节就发一块 |
| `VoiceStreamEventLifecycle` | event 取 `turn_started` / `turn_ended` / `session_ended` | 一轮开始、该轮音频发完、会话结束 |
| `VoiceStreamEventError` | error: Exception | 后台 task 出错，同时 stream() 会在末尾抛出该异常 |

有四个语义最容易误判：

| 误判 | 正确理解 |
| --- | --- |
| 以为事件在收到音频时才来 | `turn_started` 在**第一块文本进入 TTS 之前**发出（`StreamedAudioResult._start_turn`），所以它适合用来"静音麦克风" |
| 以为 `turn_ended` 就是播完了 | 它只表示这一轮音频**已经全部投递到队列**，不等于"用户已经听完"；真正播完还要等你自己的播放器队列排空 |
| 以为可以自己 `break` 退出 | `session_ended` 是终止事件，stream() 见到它就结束循环；之后若后台还存着异常，会在 finally 里抛出。提前 break 会让收尾逻辑走取消路径，你可能看不到真实的失败原因 |
| 担心并发合成会乱序 | 顺序是有保证的：不同句子会并发合成，但 `_dispatch_audio` 按句子入队顺序把音频块发出来，你不需要自己做重排序 |

---

## 七、中断打断：SDK 没做，你要自己做

**SDK 不提供打断，只给你生命周期事件，所以打断（barge-in）是应用层的事。**

官方文档写得很清楚：**`StreamedAudioInput` 没有内建打断处理**。每检测到一轮转写，就触发一次独立的 workflow 运行。这意味着两件事：

1. 用户在 Agent 说话时插话，SDK 不会帮你取消上一轮；上一轮的音频还会继续合成、继续投递。
2. 你能拿到的只有生命周期事件，"打断"得自己接。

一个可用的最小策略是：播报时静音麦克风，检测到用户开口就清空播放队列。**这是片段，不是完整脚本**：它嵌进 `voice_skeleton.py` 的 `async for event in result.stream()` 循环里；`result` 来自那次 `pipeline.run(...)`，`microphone`、`player`、`asr` 是你应用层的对象，`speaking` 是循环外维护的状态。下面这段验证插话时的清队列逻辑：

```python
speaking = False

async for event in result.stream():
    if event.type == "voice_stream_event_lifecycle":
        if event.event == "turn_started":
            speaking = True
            microphone.mute()        # 或降低增益，避免把自己的声音收回去
        elif event.event == "turn_ended":
            speaking = False
            microphone.unmute()
    elif event.type == "voice_stream_event_audio":
        player.enqueue(event.data)

    # 应用层打断：用户在播报期间说了话
    if speaking and asr.detected_speech():
        player.flush()               # 丢掉未播放的块
        microphone.unmute()
```

预期结果：用户一插话，尚未播放的音频块被丢弃，麦克风立刻恢复采集。

更稳的做法是**在音频播放侧做淡出**，因为直接 `flush()` 会"啪"一声。`repo/examples/realtime/cli/demo.py` 里 `_output_callback` 用 12ms 线性淡出加抖动缓冲，这套做法可以原样搬到语音侧。

> 提示：如果你的产品对打断要求很高（电话场景、实时客服），认真评估第 26 章的 Realtime。打断、截断、回填历史这些它是内建的，三段式要自己拼一个"半成品"。

---

## 八、测试：agents.voice.testing

**`agents.voice.testing` 把语音测试变成了纯单元测试：不需要麦克风，不需要网络。**

语音测试有两痛点：没有麦克风、没有网络，输出还不确定。`agents.voice.testing` 用三个脚本化组件加一个 PCM 编码助手全解决了。下面是完整脚本，验证整条链路的断言方式。把它存成 `test_voice_turn.py`，放在 SDK 根目录 `openai-agents-python/` 下：

```python
import asyncio

import numpy as np

from agents.voice import AudioInput, VoicePipeline
from agents.voice.testing import (
    ScriptedSTTModel,
    ScriptedTTSModel,
    ScriptedVoiceWorkflow,
    pcm16_samples,
)


async def test_voice_turn() -> None:
    stt = ScriptedSTTModel(transcriptions=["我的订单到哪了"])
    tts = ScriptedTTSModel(results=[pcm16_samples([1, 2, 3, 4])])
    workflow = ScriptedVoiceWorkflow(turns=["您的订单今天发出。"])

    pipeline = VoicePipeline(workflow=workflow, stt_model=stt, tts_model=tts)
    result = await pipeline.run(AudioInput(buffer=np.zeros(24000, dtype=np.int16)))

    events = [event async for event in result.stream()]

    assert stt.calls[0].input.buffer.shape == (24000,)      # 记录到的调用参数
    assert tts.calls[0].text == "您的订单今天发出。"
    assert workflow.transcriptions == ("我的订单到哪了",)
    assert any(
        e.type == "voice_stream_event_lifecycle" and e.event == "session_ended" for e in events
    )

    stt.assert_complete()
    tts.assert_complete()
    workflow.assert_complete()
    print("voice turn OK")


if __name__ == "__main__":
    asyncio.run(test_voice_turn())
```

运行它（这个脚本不需要 key、不需要网络）：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python test_voice_turn.py
```

预期结果：打印 `voice turn OK`，四个断言全部通过，说明转写文本、TTS 输入、workflow 收到的转写、终止事件都对得上。

设计要点有三条：

| 要点 | 说明 |
| --- | --- |
| **每个脚本化组件都记录调用** | `stt.calls`、`tts.calls`、`workflow.transcriptions` 让你能断言"送给 TTS 的到底是哪句文本"，这是排查"语音念错内容"最快的手段 |
| **`assert_complete()` 检查有没有剩余未消费的步骤** | 脚本配了 3 轮却只跑了 2 轮，测试会失败，能抓住"pipeline 少跑了一轮"这类静默 bug |
| **可以塞异常** | `ScriptedTTSModel(results=[RuntimeError("boom")])` 用来测错误路径；`ScriptedTranscriptionSession(turns=[...], close_error=...)` 用来测收尾失败 |

流式场景用 `ScriptedSTTModel(sessions=[...])`；`ScriptedTranscriptionSession` 让你直接控制 `transcribe_turns()` 与 `close()`。

---

## 九、成本与延迟优化

**语音是"按秒计费 + 人耳感知延迟"的双重压力，能拧的旋钮就这么几个。**

| 目标 | 手段 | 代价 |
| --- | --- | --- |
| 降低首字节延迟 | 调小 `TTSModelSettings.buffer_size`（默认 120 字节）；用流式 STT | 请求更碎，单块开销上升 |
| 减少 TTS 请求数 | 调大 `buffer_size`；自定义 `text_splitter` 按句聚合 | 首句出声变晚 |
| 少发无用文本 | workflow 里 yield 前过滤 markdown、括号注、调试输出 | 需要维护清洗逻辑 |
| 降低音频成本 | `voice` 选便宜模型组合；`speed` 调快（上限 4.0） | 语速快影响可懂度 |
| 缩短转写成本 | 整段场景用 `AudioInput` 一次性转写，别开 WebSocket | 失去实时感 |
| 减少模型调用 | 把"寒暄、确认、转接"交给规则直接 yield 文本，不进 Runner | 需要设计分支 |

`TTSModelSettings` 还有两个进阶钩子。`text_splitter` 决定"攒到什么程度才送去合成"，默认按句末标点切，且合并后至少 20 字符；`transform_data` 让你在拿到 numpy 音频后做重采样、增益、AEC。这两个是延迟与音质的主战场。

---

## 常见坑与排查

**语音故障按症状查，下面六条都给出"症状 → 原因 → 修法"。**

1. **`TypeError: 'coroutine' object is not async iterable`**
   原因：`run` 写成了 `async def`，函数体里只有 `return` 没有 `yield`，于是它返回协程而不是异步迭代器。修法：要么在 `async def` 里加 `yield`（异步生成器），要么改成普通 `def` + `yield`。

2. **Agent 每轮都重新自我介绍**
   原因：自定义 workflow 没有维护历史，每轮都拿只含一句话的输入去跑。修法：像 `SingleAgentVoiceWorkflow` 那样保存 `result.to_input_list()`，下一轮把整段历史传给 `Runner.run_streamed`。

3. **stream() 里听不到 `session_ended`，程序卡住**
   原因：没有任何音频产出（例如 TTS 一直没拿到完整句子），dispatcher 从未启动。0.25 已在 `_done()` 里补了这个洞，但如果你自己实现了消费循环并提前 `break`，仍会走取消路径。修法：不要 `break`，让它自然结束；确实要提前退出就显式取消收尾。

4. **流式场景一句话被拆成好几轮**
   原因：`STTModelSettings.turn_detection` 覆盖不当，或你把 `language` 和流式专用的 `languages` 同时传了。修法：用 `languages` / `keywords`（`gpt-transcribe`、`gpt-live-transcribe` 支持），不要再传单数 `language`。

5. **trace 里能看到转写全文，合规过不了**
   原因：`trace_include_sensitive_data` 默认为 `True`。修法：pipeline 侧关 `trace_include_sensitive_data` 与 `trace_include_sensitive_audio_data`，run 侧关 `RunConfig.trace_include_sensitive_data`，两边都要关。

6. **`VoicePipeline` 报 ImportError: numpy + websockets are required**
   原因：`voice` 是可选依赖，没装就导入失败。修法：`pip install 'openai-agents[voice]'`；麦克风、扬声器还需要额外装 `sounddevice`。

---

## 动手练习

**三道练习从跑通到改造，第一道现在就能做。**

1. **跑通静音闭环**：用第二节的骨架，把 `play()` 换成打印 `chunk.shape` 与 `chunk.dtype`。命令与第二节相同。确认事件顺序是 `turn_started` → 若干 audio → `turn_ended` → `session_ended`。
2. **加一轮开场白**：在 `SingleAgentVoiceWorkflow` 旁边写一个自定义 workflow，实现 `on_start()` 返回问候语，并验证问候语是**独立一轮**：观察 `turn_started` 出现了两次。
3. **改造示例**：打开 `repo/examples/voice/streamed/my_workflow.py`，把"暗号命中就 yield 固定文本"改成"暗号命中就 yield 一段从本地文件读出来的话术，并记录命中次数"。然后用 `agents.voice.testing` 的思路，给自己写一个不依赖麦克风的回归测试。

---

## 本章小结

**这一章的结论压成六条：**

- `VoicePipeline` 是三段式适配器：STT → 你的 workflow → TTS；中间那段 SDK 只认 `VoiceWorkflowBase`。
- `run()` 立刻返回 `StreamedAudioResult`，音频与生命周期事件都从 `stream()` 出来，错误也在那里抛。
- `AudioInput` 走一次性转写，`StreamedAudioInput` 走 WebSocket + 服务端 VAD；轮次边界不是你判断的。
- 自定义 workflow 必须自己维护 `to_input_list()` 历史，否则 Agent 失忆。
- 生命周期只有三个事件，SDK 不提供打断；打断靠 `turn_started` / `turn_ended` 加播放侧 flush 自己做。
- 延迟与成本的主旋钮是 `buffer_size`、`text_splitter`、`voice` 与 `speed`，以及"哪些话术用规则直接说"；测试一律用 `agents.voice.testing` 的脚本化模型，断言 calls 与 `assert_complete()`。

---

## 延伸阅读

**按下面的顺序查资料，最后一条指向下一章。**

- 官方概念与最佳实践：`repo/docs/voice/pipeline.md`、`repo/docs/voice/quickstart.md`
- 追踪细节：`repo/docs/voice/tracing.md`
- 可运行示例：`repo/examples/voice/static/main.py`（整段音频）、`repo/examples/voice/streamed/main.py` 与 `repo/examples/voice/streamed/my_workflow.py`（麦克风流式）
- 源码：`repo/src/agents/voice/pipeline.py`、`repo/src/agents/voice/result.py`、`repo/src/agents/voice/workflow.py`、`repo/src/agents/voice/model.py`
- 测试范本：`repo/tests/voice/test_pipeline.py`、`repo/src/agents/voice/testing.py`
- 下一章：《第26章 实时 Agent Realtime》把中间那层文本拿掉，换成端到端 speech-to-speech。
