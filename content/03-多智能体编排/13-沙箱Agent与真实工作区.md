# 第13章 沙箱Agent与真实工作区

上一章我们把控制权在 Agent 之间交接，但那些 Agent 全都活在你的 Python 进程里。它们能碰到的文件，就是你代码能碰到的文件。

当任务变成"把一个真实仓库拉下来、装依赖、跑测试、改代码、产出 patch"时，进程内的工具就不够了。你需要一块**可以被弄脏、可以被丢弃、可以被快照恢复**的工作区。

这正是沙箱（sandbox）要解决的问题，也就是 `SandboxAgent`。本章只有一条主线：把第六节的 code review 最小脚本跑通。换后端、加技能、改历史策略都是可选微调，放在主线之后。

按这章走完，你会得到一个能产出 `review.md` 与 `findings.jsonl` 的脚本，以及一张"漏了哪项配置会报什么错"的对照表。

---

## 学习目标

- 能说清 `SandboxAgent` 相对 `Agent` 多了哪几个字段，以及"这一次跑在哪"的配置为什么必须放在 `SandboxRunConfig` 而不是 Agent 上。
- 能用 `Manifest` 声明一份"新鲜沙箱"的工作区契约，并知道它什么时候不生效。
- 能列举 `Shell`、`Filesystem`、`Skills`、`Memory`、`Compaction` 五个内置 capability 各自注入什么工具、有什么前置依赖。
- 能根据隔离需求、宿主环境、预算在 Unix-local / Docker / 托管后端之间做出选择并说明理由。
- 能跑通一个"给仓库做 code review"的最小脚本，并知道怎么从快照或 session state 恢复上一次的工作区。

---

## 一、SandboxAgent 只是换了执行边界

先消除一个误解：`SandboxAgent` 不是新的运行时。

源码里它就是 `class SandboxAgent(Agent[TContext])`（`repo/src/agents/sandbox/sandbox_agent.py`）。所以 `prompt`、`tools`、`handoffs`、`mcp_servers`、`model_settings`、`output_type`、护栏、hooks 全部照旧，运行入口也还是 `Runner.run` / `run_sync` / `run_streamed`。

变的只有一件事：**模型面对的工具不再直接操作你的宿主环境，而是绑定到一个活的沙箱会话上**。

`exec_command` 跑在沙箱里，`apply_patch` 改的是沙箱里的文件，`view_image` 读的是沙箱里的图片。

它在 `Agent` 之上新增了四个字段，另外 `instructions` 的语义发生了变化。其余全部继承。

| 字段 | 作用 | 什么时候用 |
| --- | --- | --- |
| `default_manifest` | 新建沙箱会话时的默认工作区 | 大多数情况下必填，是"这个 Agent 期待看到什么目录结构"的声明 |
| `instructions` | 追加在 SDK 沙箱基础提示之后的角色与流程规则 | 永远该写：成功标准、验证命令、产出放在哪 |
| `base_instructions` | 整体替换 SDK 的沙箱基础提示 | 高级逃生舱，普通 Agent 不要设 |
| `capabilities` | 沙箱原生能力（工具 + 提示片段 + 运行时行为） | 默认已是 `Filesystem + Shell + Compaction` |
| `run_as` | 模型侧工具以哪个沙箱用户身份执行 | 需要用文件权限做读写隔离时才设 |

而"这一次到底跑在哪台机器、哪个容器、用哪个镜像"全部属于运行期，放在 `RunConfig(sandbox=SandboxRunConfig(...))` 里。

这个拆分不是为了好看。同一个 `SandboxAgent` 定义，本地开发用 Unix-local、CI 用 Docker、线上一部分流量丢给托管后端，改的只是 run config 一行。

一次沙箱运行的准备顺序是固定的，值得背下来（`repo/docs/sandbox/guide.md`）：

1. 先解析出沙箱会话。依次尝试：注入的 session → RunState 里的会话状态 → 显式的 `session_state` → 用 client 新建。
2. 让 capabilities 处理 manifest。
3. 拼出最终指令。顺序是 SDK 沙箱提示（或 `base_instructions`）→ `instructions` → capability 提示片段 → 远端挂载策略 → 渲染出的文件树。
4. 把工具绑到会话上。

> 注意：沙箱不改变"轮次（turn）"的含义。一个 turn 仍是一次模型步进，不是一条 shell 命令。别指望"跑了 5 条命令 = 5 个 turn"。

### 主线路径与配置对照表

课程正文里的 `repo/xxx` 是逻辑前缀，点击跳 GitHub；本机 SDK 根目录是 `openai-agents-python/`。两者对照如下：

| 课程里写的（可点击） | 你本机打开的文件 |
| --- | --- |
| `repo/examples/sandbox/tutorials/repo_code_review/main.py` | `openai-agents-python/examples/sandbox/tutorials/repo_code_review/main.py` |
| `repo/docs/sandbox/guide.md` | `openai-agents-python/docs/sandbox/guide.md` |

如果你的源码 clone 在别处，把命令里的 `openai-agents-python` 换成自己的路径即可，后文不再重复。

第六节那条主线要跑通，下面每一项都得对。表里同时写了漏了或设错会看到什么。

| 配置项 | 怎么设 | 漏了/设错会报什么错 |
| --- | --- | --- |
| 本机 SDK 根目录 | `openai-agents-python/` | 命令报 `python: can't open file` |
| 工作目录 | 主脚本不设 `cwd`，相对路径从工作区根算起 | patch 路径按 shell 的 `workdir` 写会找不到文件（坑 2） |
| `SandboxRunConfig.cwd` | 可选，设 `"repo"` 把解析起点挪进仓库 | 它只改起点，不是牢笼，不限制其他被允许路径 |
| `Manifest.root` | 默认 `/workspace` | 条目路径算错，工作区内容与预期对不上 |
| 条目路径 | 工作区相对，不能绝对、不能 `..` | 构建 manifest 时就直接报错 |
| `LocalFile.src` / `LocalDir.src` | 相对 SDK 进程工作目录，源必须在其下 | 找不到源文件或被拒绝，除非 `extra_path_grants` 覆盖 |
| `GitRepo` 的 `git` | Unix-local 宿主装；Docker/托管镜像装 | clone 阶段失败（坑 6） |
| `GitRepo.ref` | 钉具体 commit，如 `621e4974ca25ce531773def586ba3ed8e736b3fc` | 不报错，但同一问题明天可能得出不同结论 |
| `capabilities` | 主脚本写 `[Shell(), Filesystem()]` | 写 `[Shell()]` 就改不了文件（坑 3） |
| `Shell` | 跑测试、装依赖必须有 | 模型没有 `exec_command` 工具 |
| `Filesystem` | 改文件、看图必须有 | 模型没有 `apply_patch` / `view_image` |
| 允许的命令 | `exec_command` 在沙箱内执行；主脚本跑 `python -m unittest discover -s tests` | 缺 `Shell` 时无工具可用；沙箱里没有 python 或测试依赖时命令本身失败 |
| `extra_path_grants` | 显式绝对路径，`read_only=True` 可只读 | 访问工作区外路径被拒；`host_path` 在 Unix-local 被拒 |
| `network_mode="none"` | Docker 断网时显式设 | 容器仍有网络；设了以后不能再暴露端口 |
| Docker 镜像 | `python:3.14-slim`，镜像里要有 git 与运行时 | 启动或物化阶段失败 |
| `client` / `session` / `session_state` / `snapshot` | SDK 托管传 `client`；复用传 `session` | 混用会冲突；不传则按默认新建会话 |
| `workflow_name` | `"repo-code-review"` | 不报错，但 trace 不好找 |
| 模型名 | `model="gpt-5.6-sol"` | 网关场景沿用默认会报 `model not found` |
| `output_type` | `output_type=ReviewReport` | `final_output_as(ReviewReport)` 拿不到结构化对象 |
| 平台 | Unix-local 仅 macOS/Linux；Windows 用 Docker 或托管 | 初始化或启动即失败（坑 5） |
| API Key | 同第 2 章的 `OPENAI_API_KEY` | 鉴权失败 |
| 输出目录 | 脚本自己 `mkdir("review-output")` | 不报错，但取不到产物文件 |

---

## 二、Manifest：新鲜沙箱的工作区契约

`Manifest` 描述的是**新建沙箱会话**时工作区长什么样。复用会话、从快照或 `session_state` 恢复时，它不是真相来源。

它包含根目录、条目、环境变量、用户与组，以及工作区之外的额外路径授权。源码里它是一个 Pydantic 模型，字段包括 `root`（默认 `/workspace`）、`entries`、`environment`、`users`、`groups`、`extra_path_grants`。

条目（entry）决定"起跑线放什么"：

| 条目 | 用途 |
| --- | --- |
| `File` / `Dir` | 合成出来的小文件、占位输出目录，**不读宿主磁盘** |
| `LocalFile` / `LocalDir` | 把宿主上的文件或目录搬进沙箱 |
| `GitRepo` | 在沙箱里 clone 一个仓库，可以钉 `ref` |
| `S3Mount` / `GCSMount` / `R2Mount` / `AzureBlobMount` / `BoxMount` / `S3FilesMount` | 把远端存储挂进来 |

三条硬规则，违反了会直接报错，而不是"行为奇怪"。

1. 条目路径是**工作区相对路径**。不能是绝对路径，也不能用 `..` 逃出工作区。这让同一份 manifest 在本地、Docker、托管后端之间可移植。
2. `LocalFile.src` / `LocalDir.src` 默认相对 **SDK 进程的工作目录**解析，且源必须落在这个目录之下。除非被 `extra_path_grants` 显式覆盖。
3. `GitRepo` 依赖沙箱内 `PATH` 上的 `git`。装 Python SDK 不会替你装 git：Unix-local 要宿主有 git，Docker/托管要镜像里有 git。

`extra_path_grants` 是"让 Agent 访问工作区之外的具体绝对路径"的唯一正当方式，例如 `/tmp` 或只读的 `/opt/toolchain`。

```python
from agents.sandbox import Manifest, SandboxPathGrant

manifest = Manifest(
    extra_path_grants=(
        SandboxPathGrant(path="/tmp"),
        SandboxPathGrant(path="/opt/toolchain", read_only=True),
    ),
)
```

这是片段，不是完整脚本：把它嵌到第六节主脚本的 manifest 定义区，作为 `extra_path_grants` 参数；`Manifest` 与 `SandboxPathGrant` 由片段顶部的 import 提供。

预期：两个路径被授权，`/tmp` 可写，`/opt/toolchain` 只读。这段要验证的是"授权是显式的、可只读的"。两个细节要记住。

`host_path` 只有 Docker 支持，它把宿主路径映射到容器内另一个 POSIX 路径。Unix-local 只接受同路径授权，并会拒绝 `host_path`。

快照与 `persist_workspace()` **只覆盖工作区根目录**。被授权的路径是运行期访问权限，不是可持久化的状态。

> 注意：把 `extra_path_grants` 当成可信配置对待。不要根据模型输出或任何不可信载荷动态生成授权路径。

需要多身份隔离时，用 `users` + `Permissions` + `run_as` 三件套。

`Permissions` 控制 manifest 物化出来的文件对 owner/group/other 的读写执行位，`run_as` 决定模型侧工具以哪个用户身份执行。

两者都不等于"审批策略"，那是第 15 章的话题。

---

## 三、capabilities：把沙箱原语装到 Agent 上

capability 是"能改 manifest、能追加指令、能往会话上绑工具"的插件。内置五个：

| capability | 注入什么 | 前置依赖与注意点 |
| --- | --- | --- |
| `Shell` | `exec_command`；客户端支持 PTY 时还有 `write_stdin` | 想跑测试、装依赖就得有它 |
| `Filesystem` | `apply_patch` 改文件、`view_image` 看图 | 相对路径默认从工作区根解析，配了 `SandboxRunConfig.cwd` 则从 `cwd` 解析 |
| `Skills` | 技能索引与 `load_skill` 物化 | 优先用它，而不是手工挂 `.agents/skills` |
| `Memory` | 跨 run 的经验读写 | 需要 `Shell`；运行中更新记忆还需要 `Filesystem` |
| `Compaction` | 上下文压缩后的采样与输入处理 | 长流程才需要关心 |

`SandboxAgent.capabilities` 的默认值是 `Capabilities.default()`，也就是 `[Filesystem(), Shell(), Compaction()]`。

这里有个极容易踩的语义：**如果你传 `capabilities=[...]`，这个列表会整体替换默认值**。写 `capabilities=[Shell()]` 的 Agent 不会改文件，因为 `Filesystem` 被你自己删掉了。

要么写 `Capabilities.default() + [Skills(...)]`，要么把想保留的默认项显式列全。

本章示例里的 `[Shell(), Filesystem()]` 就是这种"显式列全"：一次性的评审任务不需要 `Compaction`，但 `Filesystem` 必须手工写回来。

`view_image` 有个反直觉的设计：它按文件内容识别 PNG/JPEG/GIF/WebP/BMP/TIFF，而不是看扩展名。

扩展名是图片但内容不是，会被拒绝；内容确实是图片但文件名没扩展名，反而能读。SVG 则保留按扩展名识别的兼容路径。

技能来源有四种写法，选错会得到"技能明明在磁盘上却加载不到"。

```python
from agents.sandbox.capabilities import Capabilities, LocalDirLazySkillSource, Skills
from agents.sandbox.entries import GitRepo, LocalDir

capabilities = Capabilities.default() + [
    Skills(lazy_from=LocalDirLazySkillSource(source=LocalDir(src="./skills"))),
]
```

这是片段，不是完整脚本：把它嵌到第六节主脚本的 `capabilities=` 参数处；`Capabilities`、`Skills`、`LocalDirLazySkillSource`、`LocalDir` 由片段顶部的 import 提供。

预期：模型先看到技能索引，用到哪个才把哪个物化进沙箱。这段要验证的是"懒加载技能"。`LocalDir.src` 指的是 **SDK 宿主进程**上的目录，不是沙箱里的路径。

`lazy_from` 先让模型看到索引，用到哪个再物化到沙箱的 `skills_path`（默认 `.agents`），适合技能目录较大的场景。

技能很小、希望一次性铺好，就用 `Skills(from_=LocalDir(...))`；技能有自己的发布节奏，就用 `Skills(from_=GitRepo(repo=..., ref=...))`。

---

## 四、选一个 sandbox client

默认走 `UnixLocalSandboxClient`，先把主线跑通；其他客户端都是可选微调。agent 定义不动，换 client 就换执行环境。

| client | 安装 | 什么时候选 |
| --- | --- | --- |
| `UnixLocalSandboxClient` | 无需额外依赖 | macOS/Linux 上的可信本地开发，或已有外部隔离 |
| `DockerSandboxClient` | `openai-agents[docker]` | 需要容器隔离，或需要镜像与线上一致 |
| `E2BSandboxClient` / `ModalSandboxClient` / `DaytonaSandboxClient` | `openai-agents[e2b]` 等 | 需要托管执行、弹性伸缩 |
| `BlaxelSandboxClient` / `CloudflareSandboxClient` / `VercelSandboxClient` | 对应 extra | 已有该平台基础设施 |
| `DatabricksSandboxClient` | `databricks-openai[sandbox]` | 数据在 Unity Catalog 里 |

> 注意：`UnixLocalSandboxClient` 在 Linux 上**不提供任何 OS 级隔离**，命令就是宿主进程；macOS 上用 `sandbox-exec` 限制文件系统，但不隔离网络。它只适合可信的本地开发。**Windows 上请直接用 Docker 或托管后端**，Unix-local 不支持。凡是命令受不可信输入影响，就必须换 Docker 或托管后端。

切到 Docker 只需要改 run config，镜像里要有 git 和你需要的运行时。

```python
from docker import from_env as docker_from_env

from agents.run import RunConfig
from agents.sandbox import SandboxRunConfig
from agents.sandbox.sandboxes.docker import DockerSandboxClient, DockerSandboxClientOptions

run_config = RunConfig(
    sandbox=SandboxRunConfig(
        client=DockerSandboxClient(docker_from_env()),
        options=DockerSandboxClientOptions(
            image="python:3.14-slim",
            network_mode="none",  # 需要断网时显式关闭
        ),
    ),
)
```

这是片段，不是完整脚本：把它嵌到第六节主脚本的 `Runner.run` 处，替换原来的 `run_config=` 参数；`DockerSandboxClientOptions` 等由片段顶部的 import 提供。

预期：同一个 Agent 换到容器里跑，容器内没有网络；`network_mode="none"` 时也不能再暴露端口。这段要验证的是"同一 Agent、只换执行后端"。

`options` 是 client 专属的创建参数，Docker 和多数托管后端**必须**提供。`network_mode` 唯一支持的显式取值是 `"none"`，此时不能再暴露端口。

---

## 五、会话、快照与断点恢复

这里有三个容易混淆的概念，一张表分清：

| 机制 | 保存的是什么 | 用法 |
| --- | --- | --- |
| `RunState` | Runner 管理的整份断点（含沙箱会话状态） | `result.to_state()` 后 `Runner.run(agent, state)` 续跑 |
| `SandboxRunConfig.session_state` | 显式序列化的沙箱连接状态 | 状态存在你自己的存储里时用，需要同时给 `client` |
| `SandboxRunConfig.snapshot` | 工作区**内容**（文件与产物） | 让新沙箱从上次的文件继续，而不是从 manifest 从零开始 |

一句话区分：`session_state` 是"接回同一个后端会话"，`snapshot` 是"用一个存好的工作区喂一个新沙箱"。前者要求后端能恢复，后者只要求能读快照。

默认不传 `snapshot` 时，运行时会尝试用本地默认位置。搭不起来就退化成空快照（不持久化）。

生命周期有两种模式。**SDK 托管**适合一次 run 就结束的沙箱：传 `client`，Runner 负责建、启、跑、存档、删。

```python
result = await Runner.run(
    agent,
    "检查工作区并总结改动。",
    run_config=RunConfig(
        sandbox=SandboxRunConfig(client=UnixLocalSandboxClient()),
        workflow_name="sandbox-smoke",
    ),
)
```

这是片段，不是完整脚本：把它嵌到第六节主脚本的 `main()` 里；`agent`、`Runner`、`RunConfig`、`SandboxRunConfig`、`UnixLocalSandboxClient` 都由主脚本提供。

预期：run 结束后沙箱由 Runner 收掉，你不需要手动清理。

**开发者托管**适合要复用、要在 run 之后翻文件、要自己决定何时清理的场景。传 `session`，Runner 只用不管。

```python
client = UnixLocalSandboxClient()
sandbox = await client.create(manifest=manifest)

try:
    async with sandbox:                       # 进入时 start，退出时走清理
        shared = RunConfig(sandbox=SandboxRunConfig(session=sandbox))
        await Runner.run(agent, "先分析文件。", run_config=shared)
        await Runner.run(agent, "再写最终报告。", run_config=shared)
finally:
    await client.delete(sandbox)              # 资源是你建的，也得你删
```

这是片段，不是完整脚本：第六节主脚本已经用了这套"开发者托管"结构，把上面这段和它对照着看即可；`client`、`manifest`、`agent`、`Runner` 都由主脚本提供。

预期：两次 run 落在同一个沙箱里，第二次能看到第一次留下的文件。这段要验证的是"一个沙箱跑两次 run"。两个语义差别必须记住。

`stop()` 只把工作区存进快照，**不拆沙箱**；`aclose()` 才是完整清理（跑 pre-stop 钩子、`stop()`、关资源）。

而在 `client.create(...)` 之后，`client.delete(sandbox)` 才真正释放后端资源。`async with` 不会替你删。

> 注意：序列化会**剥离凭据**。session state 与 `RunState` 里不含云挂载凭据、`host_path`、容器内凭据暴露确认。恢复时 SDK 只信任你当前传入的 manifest：拓扑不一致就**在沙箱启动前失败**，序列化状态本身永远不授予权限。所以恢复带挂载或 host 授权的会话，必须把可信 manifest（`SandboxRunConfig.manifest` 或 `agent.default_manifest`）一起给上。另外 `VercelSandboxClient` 不支持恢复已挂载的会话。

---

## 六、最小示例：给仓库做 code review

这是本章主线：钉住一个仓库、钉住一个 ref、跑测试、产出结构化评审结论，再把结论落成文件。

这份代码改编自 `repo/examples/sandbox/tutorials/repo_code_review/main.py`，删掉了流式打印和 CLI。想跑原版，先确认工作目录：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
cd openai-agents-python
python examples/sandbox/tutorials/repo_code_review/main.py
```

预期输出测试摘要与 findings 统计。如果你的源码 clone 在别处，把命令里的 `openai-agents-python` 换成自己的路径即可，后文不再重复。

下面这段是删掉流式与 CLI 之后的版本。把它存成 `sandbox_review.py`，放在 SDK 根目录 `openai-agents-python/` 下。

```python
import asyncio
import json
from pathlib import Path

from pydantic import BaseModel, Field

from agents import ModelSettings, Runner
from agents.run import RunConfig
from agents.sandbox import Manifest, SandboxAgent, SandboxRunConfig
from agents.sandbox.capabilities import Filesystem, Shell
from agents.sandbox.entries import File, GitRepo
from agents.sandbox.sandboxes.unix_local import UnixLocalSandboxClient

RULES = (
    "You review the repository mounted at `repo/` like a maintainer. "
    "Run `python -m unittest discover -s tests` from `repo/` and report the result. "
    "Return at most three findings, each with an exact workspace-relative path, a 1-based line "
    "number, and a concrete fix. Do not edit the repository; put the minimal git diff in "
    "`suggested_patch`."
)


class Finding(BaseModel):
    file: str = Field(description="工作区相对路径，例如 repo/src/sample/simple.py")
    line_number: int = Field(description="1 基行号")
    comment: str = Field(description="针对该行的具体意见，附最小改法")


class ReviewReport(BaseModel):
    test_command: str
    test_summary: str
    findings: list[Finding]
    markdown: str
    suggested_patch: str | None = None


manifest = Manifest(
    entries={
        "AGENTS.md": File(content=RULES.encode("utf-8")),
        "repo": GitRepo(repo="pypa/sampleproject", ref="621e4974ca25ce531773def586ba3ed8e736b3fc"),
    }
)

reviewer = SandboxAgent(
    name="Repo reviewer",
    model="gpt-5.6-sol",
    instructions=RULES,
    default_manifest=manifest,
    capabilities=[Shell(), Filesystem()],
    model_settings=ModelSettings(tool_choice="required"),
    output_type=ReviewReport,
)


async def main() -> None:
    client = UnixLocalSandboxClient()
    sandbox = await client.create(manifest=manifest)
    try:
        async with sandbox:
            result = await Runner.run(
                reviewer,
                "跑 repo/ 里的测试，然后评审 repo/src/sample/simple.py。",
                run_config=RunConfig(
                    sandbox=SandboxRunConfig(session=sandbox),
                    workflow_name="repo-code-review",
                ),
            )
            report = result.final_output_as(ReviewReport)
    finally:
        await client.delete(sandbox)

    out = Path("review-output")
    out.mkdir(exist_ok=True)
    (out / "review.md").write_text(report.markdown, encoding="utf-8")
    (out / "findings.jsonl").write_text(
        "\n".join(json.dumps(f.model_dump(), ensure_ascii=False) for f in report.findings) + "\n",
        encoding="utf-8",
    )
    print(report.test_summary)
    print(f"wrote {len(report.findings)} findings to {out}")


if __name__ == "__main__":
    asyncio.run(main())
```

运行它：

```bash
# 工作目录：openai-agents-python/（SDK 根目录）
python sandbox_review.py
```

预期：终端打印测试摘要和 `wrote N findings to review-output`，并在 `review-output/` 下写出 `review.md` 与 `findings.jsonl`。看到这两个文件，就是本章的总验收点。

这段要验证的是"沙箱 + 结构化产出 + 事后取文件"这条完整链路。四个关键行值得单独说：

- `GitRepo(repo=..., ref=...)` 把仓库钉在具体 commit 上。评审类任务必须钉 ref，否则同一个问题明天可能得出不同结论。
- `instructions` 与 `AGENTS.md` 内容相同，是刻意的：一份进系统提示（稳），一份落进工作区（模型可以用 `rg` 反复查）。长任务规格应该放工作区文件，短规则才放 `instructions`。
- `output_type=ReviewReport` 让模型直接给你可落库的对象，而不是一段需要再解析的 Markdown。
- 这里刻意**不设** `cwd`，让 `apply_patch` 与 `exec_command` 的相对路径都从工作区根算起，所以提示里统一写 `repo/...`。如果你不想让模型每次都写前缀，可以加 `cwd="repo"` 把解析起点挪进去；但 `cwd` **不是牢笼**：它只改变相对路径的起点，不限制访问共享会话里其他被允许的路径。

### 换成 Docker 或加一个只读评审员

这两项都是主线之后的可选微调。换后端只需要改 run config。

如果想让"评审员"和"修改员"各自有独立工作区，典型做法是给每个 `Agent.as_tool(...)` 传各自的 `run_config=RunConfig(sandbox=SandboxRunConfig(client=..., options=...))`。

如果想让它们看同一个工作区但权限不同，就共享一个 `session` 并用 `run_as` 区分用户（`repo/examples/sandbox/sandbox_agents_as_tools.py`、`repo/examples/sandbox/shared_session_workdirs.py`）。

---

## 七、边界：什么时候不该用沙箱

沙箱不是"更高级的 Agent"，它解决的是**工作区边界**问题。判断标准很干脆：

| 你的需求 | 选择 |
| --- | --- |
| 只是偶尔跑一条 shell 命令、不需要保留文件 | 托管 shell 工具即可（见第 8 章） |
| 需要读写真实文件、跑测试、产出文件 | `SandboxAgent` |
| 需要多 Agent 各有独立工作区 | 多个 `SandboxAgent` + 各自 run config |
| 需要同一轮对话里"审"与"改"分离 | 共享 session + `run_as` + `Permissions` |
| 任务纯文本、无文件 | 普通 `Agent` |

成本上要有心理准备，钱主要花在四处：

| 花钱的地方 | 为什么 |
| --- | --- |
| 会话存活时间 | 托管后端通常按沙箱存活时长计费 |
| 镜像与冷启动 | Docker 拉镜像、托管后端排队 |
| 物化 | `LocalDir` 大目录、`GitRepo` clone、挂载初始化 |
| 快照归档 | 每次 `stop()` 都要打包工作区 |

控制手段也很直接：manifest 只放真正需要的目录；用 `concurrency_limits` 限制物化并发；用 `archive_limits` 限制解包资源；不在一个沙箱里塞十个互不相关的任务。

隔离上必须放弃幻想：**本地后端不等于隔离**。

Unix-local 在 Linux 上就是宿主进程。工作区目录、`HOME`、`cwd` 都不构成访问边界。

真正需要隔离时，用配置正确的 Docker（`network_mode="none"`、只挂必要的目录、非 root 用户）或托管后端。并且按最小权限发放凭据：挂载用短期、沙箱范围、只读的凭据，需要写回才开 `read_only=False`。

---

## 常见坑与排查

按症状查，每条都给出"症状 → 原因 → 修法"。

1. **改了 manifest，沙箱里却没变**
   - 症状：工作区内容与新的 manifest 对不上。
   - 原因：你复用了一个已存在的 `session`，或从 `snapshot` / `session_state` 恢复；工作区内容由它们决定，`manifest` 只对新建会话生效。
   - 修法：确认这次 run 走的是"新建"分支；需要新工作区就新建会话，而不是改 manifest 后重跑。

2. **`apply_patch` 报找不到文件**
   - 症状：patch 路径按 shell 里的写法写，却报文件不存在。
   - 原因：patch 路径以工作区根为准（配了 `cwd` 则以 `cwd` 为准），**不跟随 shell 命令的 `workdir`**。
   - 修法：统一在 `instructions` 里写清"patch 路径从哪算起"，或显式给 `SandboxRunConfig.cwd`。

3. **自建 capabilities 后 Agent 不会改文件了**
   - 症状：能执行命令，但写不了文件。
   - 原因：`capabilities=[...]` 整体替换默认列表，你漏掉了 `Filesystem()`。
   - 修法：`Capabilities.default() + [...]`，或把 `Filesystem()` 显式加回。

4. **恢复会话在启动前就失败**
   - 症状：沙箱还没起来就报错。
   - 原因：序列化剥离了 `host_path` 与挂载凭据，而恢复时你没有提供拓扑一致的可信 manifest。
   - 修法：把同一份 `Manifest` 通过 `SandboxRunConfig.manifest` 或 `agent.default_manifest` 传进去；永远不要从不可信输入推导宿主路径。

5. **Windows 上跑 Unix-local 直接报错**
   - 症状：client 初始化或启动即失败。
   - 原因：Unix-local 只支持 macOS/Linux。
   - 修法：换 `DockerSandboxClient` 或托管后端。

6. **`GitRepo` 物化失败**
   - 症状：clone 阶段报错。
   - 原因：沙箱里没有 `git`。
   - 修法：Unix-local 装 git；Docker/托管在镜像里预装 git。

---

## 动手练习

1. **立刻跑主线**：在 `openai-agents-python/` 下运行 `sandbox_review.py`，确认 `review-output/` 里出现 `review.md` 与 `findings.jsonl`。这是本章最短的成功验证。
2. **读懂默认值**：不传 `capabilities`，用 `Runner.run` 跑一个"列出工作区所有文件"的任务，然后把 `capabilities` 显式写成 `[Shell()]` 再跑一次。记录第二次少了哪些工具，并解释原因。
3. **换成 Docker 并断网**：把上面 code review 示例切到 `DockerSandboxClient`，加 `network_mode="none"`。观察 `pip install` 之类的命令如何失败，写出你会怎么调整镜像或命令。
4. **改造仓库示例**：打开 `repo/examples/sandbox/tutorials/repo_code_review/main.py`，把 `AGENTS.md` 里"恰好两条 finding"的约束改成"按严重度排序、最多三条、必须包含一个 CI 相关发现"，再跑 `evals.py`，观察断言在哪一条上失败、为什么。

---

## 本章小结

- `SandboxAgent` 继承 `Agent`，只多 `default_manifest` / `base_instructions` / `capabilities` / `run_as`；后端与会话全部由 `SandboxRunConfig` 决定。
- `Manifest` 是**新鲜会话**的工作区契约；复用 session、`session_state`、`snapshot` 时它不是真相来源。条目路径只能相对工作区，`LocalDir.src` 受 SDK 进程工作目录与 `extra_path_grants` 约束，快照只存工作区根。
- `capabilities=[...]` 会**替换**默认值；默认是 `Filesystem + Shell + Compaction`。
- 选后端顺序：可信本地用 Unix-local（Linux 无 OS 隔离、Windows 不可用）→ 需要隔离用 Docker → 需要弹性用托管。
- `session_state` 接回后端会话，`snapshot` 喂新会话内容；序列化剥离凭据，恢复要带可信 manifest。
- `stop()` 存档不拆沙箱，`aclose()` 完整清理，`client.delete(sandbox)` 释放后端资源。

---

## 延伸阅读

- 沙箱快速开始：`repo/docs/sandbox_agents.md`
- 概念与生命周期：`repo/docs/sandbox/guide.md`
- 后端选型与挂载：`repo/docs/sandbox/clients.md`、`repo/docs/sandbox/custom-providers.md`
- 跨 run 经验记忆：`repo/docs/sandbox/memory.md`
- 可运行示例：`repo/examples/sandbox/basic.py`、`repo/examples/sandbox/docs/coding_task.py`、`repo/examples/sandbox/docker/docker_runner.py`、`repo/examples/sandbox/tutorials/repo_code_review/main.py`
- 源码入口：`repo/src/agents/sandbox/sandbox_agent.py`、`repo/src/agents/sandbox/manifest.py`、`repo/src/agents/run_config.py`
- 下一章：工作区里跑的命令和改的文件都可能是危险动作，第 14 章《Guardrails 输入输出护栏》开始处理"该不该让它做"。

> 提示：沙箱依赖 Docker 或远端服务，本地环境不满足是常态。卡住时先把示例换成 `repo/examples/sandbox/basic.py` 的最小形态跑通，再回来看 manifest。
