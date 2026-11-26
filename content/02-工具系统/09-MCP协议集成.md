# 第9章 MCP 协议集成

第 8 章的托管工具是"OpenAI 替你调工具"，工具由平台提供。真实项目里更多的工具在**别人那里**：公司内部的工单系统、第三方的 GitHub、你自己写的文件服务。

把它们一个个包成 `@tool` 当然可以，但那意味着每接一个系统就写一遍适配层。MCP（Model Context Protocol）解决的正是这件事：用一个协议把"工具提供方"和"Agent 运行方"解耦。

这一章讲清 SDK 支持的三条传输、生命周期管理，以及最容易出错的审批与命名。

## 学习目标

- 能说清 MCP 是一个开放协议，而不是 OpenAI Agents SDK 的私有概念。
- 能按场景选择 `MCPServerStdio`、`MCPServerSse`、`MCPServerStreamableHttp`。
- 能正确管理 server 的 `connect/cleanup`，并在多 server 场景用 `MCPServerManager`。
- 能配置 `mcp_config` 的三个开关，并解释 `include_server_in_tool_names` 解决什么问题。
- 能判断本地 MCP 服务器与 `HostedMCPTool` 的边界，并为危险工具加上审批。

## 一、MCP 是什么，不是什么

MCP 是一个开放协议，只规定"客户端如何发现工具、如何调用工具、结果长什么样"。它不规定模型，也不规定 Agent 循环，更不绑定某家厂商。

SDK 里的一切，包括 `MCPServerStdio`、`MCPUtil`、`HostedMCPTool`，都只是这个协议的**客户端实现**。

安全上还有几条硬规矩。只连可信 server；给最小权限的凭据；把访问令牌放在 `Authorization` 头而不是 URL 里，因为 URL 会进日志和 trace；对敏感操作强制审批。这些不是"最佳实践建议"，而是"出了事能不能追责"的分界线。

由此得出三条推论，后面所有细节都从这三条推出来：

1. **工具不是你的代码**。schema、描述、参数都由 server 决定，你只能过滤和包装，不能改语义。
2. **调用要走 IO**。要么子进程管道，要么 HTTP，所以 `list_tools` 有延迟、有缓存、有重试。
3. **信任边界在你这边**。server 能读你能读的一切、用你给的凭据做任何事。官方文档第一句警告就是"只连你信任的 server"。

SDK 支持 MCP Python 包的 v1 与 v2（依赖范围 `mcp>=1.19.0,<3`）。它会自动探测版本并适配 stdio/SSE/Streamable HTTP 的连接方式，普通配置不需要你切换。

## 二、三条传输，一张表选完

选传输只看两件事：server 跑在哪，用什么协议说。对照下表即可。

| 场景 | 用哪个类 | 关键 `params` |
| --- | --- | --- |
| 本地命令行 server（npx、uvx、自编译二进制） | `MCPServerStdio` | `command`、`args`、`env`、`cwd` |
| 远端/本地 HTTP，支持 Streamable HTTP | `MCPServerStreamableHttp` | `url`、`headers` |
| 旧式 SSE 传输 | `MCPServerSse` | `url`、`headers` |

下面这段把三种 server 都构造一遍，注意 HTTP 那个把令牌放在请求头里。

```python
import os

from agents.mcp import MCPServerSse, MCPServerStdio, MCPServerStreamableHttp

stdio_server = MCPServerStdio(
    name="Filesystem",
    params={"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]},
    client_session_timeout_seconds=30,
)

http_server = MCPServerStreamableHttp(
    name="Internal tools",
    params={
        "url": "http://localhost:8000/mcp",
        "headers": {"Authorization": f"Bearer {os.environ['MCP_SERVER_TOKEN']}"},
        "timeout": 10,
    },
    cache_tools_list=True,
)

legacy_sse_server = MCPServerSse(
    name="Legacy SSE",
    params={"url": "http://localhost:8000/sse"},
)
```

预期结果：三个对象都能构造成功，但此时还没连上 server，要等下一节的 `connect()`。

> 注意：MCP 项目已把 SSE 传输标记为废弃。新接入优先 stdio（本地）或 Streamable HTTP（远端），SSE 只用于兼容老 server。

三个构造参数值得单独记：

| 参数 | 说明 |
| --- | --- |
| `client_session_timeout_seconds` | 默认 5 秒，`None`/`0` 表示关闭 |
| `max_retry_attempts` 与 `retry_backoff_seconds_base` | 对 `list_tools`/`call_tool` 自动重试 |
| `use_structured_content` | 优先用 `structuredContent` 而不是文本内容 |

## 三、生命周期：connect / cleanup 与 MCPServerManager

MCP server 不是"构造完就能用"的。`MCPServer` 是抽象基类，明确要求你先 `await server.connect()`，用完 `await server.cleanup()`。

最省事的写法是 `async with`，下面这段把连接、run、清理收在一个块里。

```python
from agents import Agent, Runner
from agents.mcp import MCPServerStdio


async def main() -> None:
    async with MCPServerStdio(
        name="Filesystem",
        params={"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]},
    ) as server:
        agent = Agent(
            name="File assistant",
            instructions="Use the MCP tools to answer questions about local files.",
            mcp_servers=[server],
        )
        result = await Runner.run(agent, "List the files you can read.")
        print(result.final_output)
```

预期结果：进入 `with` 时 server 启动并握手，退出时自动清理，不会留下子进程。

`async with` 背后就是 `__aenter__` 到 `connect()`、`__aexit__` 到 `cleanup()`。**必须在同一个任务里连接和清理**，因为 stdio server 是一个子进程，跨任务清理会留下僵尸进程或悬空管道。

server 一多，逐个 `async with` 就难看了，而且"某一个连不上就全崩"也不合适。`MCPServerManager` 解决的就是这个问题。

```python
from agents import Agent, Runner
from agents.mcp import MCPServerManager, MCPServerStreamableHttp

servers = [
    MCPServerStreamableHttp(name="calendar", params={"url": "http://localhost:8000/mcp"}),
    MCPServerStreamableHttp(name="docs", params={"url": "http://localhost:8001/mcp"}),
]

async def main() -> None:
    async with MCPServerManager(servers) as manager:
        agent = Agent(
            name="Assistant",
            instructions="Use MCP tools when they help.",
            mcp_servers=manager.active_servers,
        )
        result = await Runner.run(agent, "Which MCP tools are available?")
        print(result.final_output)

    for server in manager.failed_servers:
        print("failed:", server.name, manager.errors.get(server))
```

预期结果：连上的 server 出现在 `active_servers` 里并参与 run，连不上的留在 `failed_servers`，原因在 `errors` 里按 server 索引。

行为要点有四条：

- `active_servers` 只含成功连接的 server（`drop_failed_servers=True` 为默认）；失败项在 `failed_servers` 与 `errors` 里。
- `strict=True` 时第一个失败就抛异常，适合"缺一个就不能跑"的关键依赖。
- `reconnect(failed_only=True)` 重试失败的，`False` 重启全部。`connect_all()`/`cleanup_all()`/`reconnect()` 是串行的，不会并发操作同一批连接。
- `connect_timeout_seconds`、`cleanup_timeout_seconds` 默认 10 秒；传 0 会被拒绝，因为那等于立刻超时。

## 四、agent.mcp_servers 与 mcp_config

把 server 交给 Agent 只需要一个字段：`mcp_servers=[...]`。每次 run，Agent 都会对这些 server 调一次 `list_tools()`，把结果转成 `FunctionTool` 一起给模型。

转换行为由 `mcp_config` 控制，下面这段把三个开关都打开。

```python
from agents import Agent

agent = Agent(
    name="Ops assistant",
    mcp_servers=[filesystem_server],
    mcp_config={
        "convert_schemas_to_strict": True,
        "failure_error_function": None,
        "include_server_in_tool_names": True,
    },
)
```

预期结果：MCP 工具以 strict schema、抛异常模式、带 server 前缀的名字进入工具列表。

三个键的含义：

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `convert_schemas_to_strict` | `False` | 尽力把 MCP schema 转成 strict。转不动就保留原样，不报错 |
| `failure_error_function` | 未设置时用 `default_tool_error_function` | 控制 MCP 工具失败时给模型看什么；显式 `None` 表示直接抛异常 |
| `include_server_in_tool_names` | `False` | 给本地 MCP 工具名加 `mcp_<server>__<tool>` 前缀 |

server 级别还能覆盖 `mcp_config["failure_error_function"]`：构造 `MCPServerStdio(..., failure_error_function=my_fn)` 的优先级更高。这一点在"某个 server 的错误必须暴露细节、其余保持脱敏"时很有用。

`convert_schemas_to_strict` 值得多说一句。MCP server 的 schema 往往来自 OpenAPI 或手写 JSON Schema，可能含 `additionalProperties: {}`、`$ref` 兄弟关键字、`oneOf` 等 strict 不接受的东西。

转换是"尽力而为"，转不动就静默保留。所以**不要把 strict 当成保证**，需要确定性时在 `instructions` 里把参数格式写清。

## 五、工具筛选、分页与缓存

一个文件系统 server 可能暴露二十个工具，而你只想给模型三个。筛法有两种，静态与动态。

下面这段两种都写了：静态用 allow/block 名单，动态按 Agent 与工具名判断。

```python
from agents.mcp import MCPServerStdio, ToolFilterContext, create_static_tool_filter

filesystem_server = MCPServerStdio(
    params={"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]},
    tool_filter=create_static_tool_filter(
        allowed_tool_names=["read_file", "list_directory"],
        blocked_tool_names=["write_file"],
    ),
)


async def context_aware_filter(context: ToolFilterContext, tool) -> bool:
    if context.agent.name == "Code Reviewer" and tool.name.startswith("danger_"):
        return False
    return True
```

预期结果：只读的两个工具留在列表里，`write_file` 被剔除；动态筛选那条在 Code Reviewer 下还会额外挡掉 `danger_` 开头的工具。

静态筛选先应用 allow 列表、再从中剔除 block 列表。动态筛选拿到 `ToolFilterContext`（含 `run_context`、`agent`、`server_name`），可以按 Agent 或租户动态收窄权限。

分页是自动的。`list_tools()` 与 `list_prompts()` 会自动跟随 `nextCursor`，把完整列表收齐后再应用过滤与缓存。中途某页失败，或 server 重复返回同一 cursor，会直接报错，而不是给你一个"半截工具列表"。`list_resources()` 仍是手动分页。

缓存用 `cache_tools_list=True`。默认每次 run 都调 `list_tools()`，远端 server 会明显拖慢首 token；只有在你确信工具定义不常变时才开缓存，需要刷新时调 `server.invalidate_tools_cache()`。缓存返回的是**深拷贝**，改它不会污染缓存。

## 六、审批：require_approval

MCP 工具最危险的地方是"你能做的它都能做"。三个本地 server 类都支持 `require_approval`，形式有五种：

| 形式 | 含义 |
| --- | --- |
| `"always"` / `"never"` | 全部要求/全部不要求 |
| `True` / `False` | 等价于上一条 |
| `{"delete_file": "always", "read_file": "never"}` | 按工具名分别设定 |
| `{"always": {"tool_names": [...]}, "never": {"tool_names": [...]}}` | 分组写法 |
| 可调用对象 `(run_context, agent, tool) -> bool` | 按上下文与工具元数据动态判定 |

下面这段只对写操作要审批，并在循环里逐项批准。

```python
async with MCPServerStdio(
    params={"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]},
    require_approval={"always": {"tool_names": ["write_file", "delete_file"]}},
) as server:
    agent = Agent(name="Filesystem agent", mcp_servers=[server])
    result = await Runner.run(agent, "Create a file named todo.txt.")
    while result.interruptions:
        state = result.to_state()
        for item in result.interruptions:
            state.approve(item)
        result = await Runner.run(agent, state)
```

预期结果：第一次 run 在写文件前停下，`interruptions` 里出现待审批项；批准后重跑才真正创建文件。

关键差异在这儿：**MCP 的 `require_approval` 可调用对象拿不到本次调用的参数与 call_id**。这两样是 `FunctionTool.needs_approval` 才有的，MCP 侧只能看 `run_context`、`agent` 和 server 提供的 `Tool` 元数据。

所以"按参数判断该不该批准"在 MCP 侧做不到，只能按工具名或业务上下文判断。server 给的 `annotations` 只是提示，不要无条件信任。

另外，本地 server 类还支持 `tool_input_guardrails`/`tool_output_guardrails`。这些护栏会挂到过滤后剩下的每个工具上，与函数工具的护栏走同一条执行管线。

## 七、本地 server vs 托管 MCP

两者的分界线是"谁连 server"：本地 `mcp_servers` 由你的进程连，`HostedMCPTool` 由 Responses API 连。

| 维度 | 本地 `mcp_servers` | `HostedMCPTool` |
| --- | --- | --- |
| 谁连 server | 你的进程 | OpenAI Responses API |
| 网络要求 | server 可只在内网 | server 必须公网可达 |
| 工具列表 | 你调 `list_tools()`，可过滤/缓存 | 平台自动列，可用 `allowed_tools` 收窄 |
| 参数可见性 | 转换后仍在你进程内，可加护栏 | 完全不经你手 |
| 审批 | `require_approval` 策略 | `tool_config["require_approval"]` 加 `on_approval_request` |
| 适合 | 内部系统、需要审计的动作 | 公开 SaaS、连接器（如日历、Wiki） |

选择标准很朴素：**server 能不能被公网访问、你需不需要在调用前拦一道**。两个都要 → 本地；只要能用、且平台侧足够可信 → 托管。

还有一个容易被忽略的差异。本地 server 的 `list_tools()` 结果参与 SDK 的工具名冲突检测、`is_enabled` 求值和护栏；托管 MCP 的工具完全在平台侧展开，这些 SDK 侧的控制一律不生效。如果你的权限模型依赖这些机制，就只能选本地。

## 八、工具名冲突与 include_server_in_tool_names

两个 server 都提供了 `read_file`，模型只会看到一个，这是 MCP 场景最常见的"灵异事件"。

默认 `include_server_in_tool_names=False`，名字保持 server 原样。打开后变成 `mcp_<server>__<tool>`，例如 `mcp_filesystem__read_file`。生成规则保证了 ASCII 安全、长度受限，且不与同 Agent 上已启用的 `FunctionTool` 或 handoff 名字冲突。SDK 调用时仍然用原始工具名发给原始 server。

打开它有代价：模型看到的工具名变长，prompt 里的引用也要跟着改。建议只在**确实存在同名工具**时才开，并把 `RunConfig(tool_name_collision_policy="error")` 一起用上，让漏网的重名在模型调用前就炸出来。

## 九、完整例子：接一个文件系统 MCP server

先跑通官方的 filesystem server，这是验证"环境是否就绪"的最短路径。以下命令与示例都在 `repo/openai-agents-python/`（SDK 根目录）下执行；若 clone 在别处，按自己的目录替换。

这段把工作目录指向脚本旁的 `sample_files`，连上 server，列出工具再让它读一个文件。

```python
import asyncio
import shutil
from pathlib import Path

from agents import Agent, Runner, trace
from agents.mcp import MCPServerStdio


async def main() -> None:
    workspace = Path(__file__).parent / "sample_files"
    async with MCPServerStdio(
        name="Filesystem",
        params={
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-filesystem", str(workspace)],
            "cwd": str(workspace),
        },
        cache_tools_list=True,
        require_approval="never",
    ) as server:
        tools = await server.list_tools()
        print("exposed tools:", [t.name for t in tools])

        agent = Agent(
            name="Workspace assistant",
            instructions=(
                "Answer questions using only the MCP filesystem tools. "
                "Always use absolute paths inside the workspace."
            ),
            mcp_servers=[server],
        )
        with trace("MCP filesystem demo"):
            result = await Runner.run(agent, "Read favorite_books.txt and summarise it in one line.")
        print(result.final_output)


if __name__ == "__main__":
    if not shutil.which("npx"):
        raise RuntimeError("npx is not installed; run npm install -g npx first.")
    asyncio.run(main())
```

预期输出：先打印一行 `exposed tools: [...]`，列出 server 暴露的工具名；随后打印一行摘要，内容来自 `favorite_books.txt`。

换成 GitHub 只是换 `params`。GitHub 官方 MCP server 以容器镜像发布，凭据通过环境变量注入。

```python
import os

from agents.mcp import MCPServerStdio

github_server = MCPServerStdio(
    name="GitHub",
    params={
        "command": "docker",
        "args": [
            "run", "-i", "--rm",
            "-e", "GITHUB_PERSONAL_ACCESS_TOKEN",
            "ghcr.io/github/github-mcp-server",
        ],
        "env": {"GITHUB_PERSONAL_ACCESS_TOKEN": os.environ["GITHUB_PERSONAL_ACCESS_TOKEN"]},
    },
    cache_tools_list=True,
    require_approval={"always": {"tool_names": ["create_issue", "create_pull_request"]}},
)
```

预期结果：`create_issue` 与 `create_pull_request` 每次调用都要审批，其余工具直接放行。

> 注意：镜像名与可用工具集由 server 项目维护，可能随版本变化。接之前先看它的 README，用 `await server.list_tools()` 打印真实工具名，别照抄猜出来的名字。

本地与仓库自带示例一一对应：`repo/examples/mcp/filesystem_example`（npx + 文件系统）、`repo/examples/mcp/git_example`（uvx + `mcp-server-git`）、`repo/examples/mcp/manager_example`（FastAPI + manager 生命周期）、`repo/examples/mcp/tool_filter_example`（过滤 + 审批）。

## 十、MCP 的另外两件礼物：prompts 与 resources

MCP 不只提供工具，server 还可以暴露 **prompts**（动态生成指令模板）和 **resources**（可读取的资源）。

下面这段从 server 取一份 prompt 模板，直接当 Agent 的 instructions 用。

```python
prompt_result = await server.get_prompt(
    "generate_code_review_instructions",
    {"focus": "security vulnerabilities", "language": "python"},
)
instructions = prompt_result.messages[0].content.text

agent = Agent(name="Code Reviewer", instructions=instructions, mcp_servers=[server])
```

预期结果：`instructions` 是平台维护的那段审查指令，改了模板下次启动即生效。

`list_prompts()` 枚举模板，`get_prompt(name, arguments)` 取具体内容；resources 侧则是 `list_resources()`、`list_resource_templates()`、`read_resource(uri)`。

这两类能力常被忽略，但在"指令由平台统一维护、多个 Agent 复用"的团队里非常实用：prompt 改了不用发版，Agent 下次启动就生效。

## 十一、预取工具：把 MCP 工具当普通工具用

有时你不想让 Agent 每次 run 都去连 server，比如启动慢的 server，或要在连不上时降级。做法是先预取工具列表，再把它们塞进 `tools`。

下面这段一次性取出全部函数工具，之后 run 期间不再触发 `list_tools()`。

```python
from agents import Agent, RunContextWrapper
from agents.mcp.util import MCPUtil

run_context: RunContextWrapper[dict[str, str]] = RunContextWrapper(context={})
fetcher = Agent(name="Tool fetcher", instructions="Prefetch MCP tools.")

prefetched = await MCPUtil.get_all_function_tools(
    [server],
    convert_schemas_to_strict=True,
    run_context=run_context,
    agent=fetcher,
)
agent = Agent(name="Prefetched assistant", tools=prefetched)
```

预期结果：`agent` 的 `tools` 里已经是普通 `FunctionTool`，`mcp_servers` 留空也不影响运行。

这样 `agent.mcp_servers` 可以是空的，工具在 run 期间不再触发 `list_tools()`。代价是你自己承担"工具列表过期"的风险，需要刷新时重新预取。仓库里 `repo/examples/mcp/get_all_mcp_tools_example` 就是这条路线。

## 常见坑与排查

1. **`RuntimeError: Attempted to exit cancel scope in a different task`**
   症状：run 结束后异常退出，报 cancel scope 不在同一任务。
   原因：connect 与 cleanup 不在同一任务，常见于把 server 存进全局，或在两个 `asyncio.run` 里复用。
   修法：用 `async with` 或 `MCPServerManager` 把生命周期收在一个任务内。
2. **`npx`/`uvx` 首次启动超时**
   症状：第一次连 server 就报超时，第二次可能就正常。
   原因：包在下载，首次启动比后续慢得多。
   修法：先手动装好，或调大 `client_session_timeout_seconds`；MCP v2 的 `server/discover` 探测有独立超时，靠调大 session 超时不一定够。
3. **模型说"没有这个工具"**
   症状：server 明明有这个工具，模型却坚持说没有。
   原因：`tool_filter` 把它挡住了，或 server 没暴露出该工具。
   修法：`await server.list_tools()` 打印过滤后的真实列表。
4. **两个 server 的同名工具只剩一个**
   症状：同名工具在模型眼里只出现一次。
   原因：命名冲突被 SDK 静默择一。
   修法：`mcp_config={"include_server_in_tool_names": True}`。
5. **每次 run 都很慢**
   症状：首 token 延迟随 server 数量线性上升。
   原因：没开 `cache_tools_list`，每轮都在远端列工具。
   修法：开缓存，变更时 `invalidate_tools_cache()`。
6. **审批回调里拿不到参数**
   症状：想按参数决定批不批，回调里却没有参数字段。
   原因：MCP 的 `require_approval` 回调只给 `(run_context, agent, tool)`。
   修法：把授权判断下沉到 server 侧，或改用本地 function 工具包一层。

## 动手练习

以下练习都在 `repo/openai-agents-python/`（SDK 根目录）下执行；若 clone 在别处，按自己的目录替换。

1. 用 `MCPServerStdio` 接 filesystem server，打印 `list_tools()` 的结果，再用 `create_static_tool_filter` 只保留只读工具，验证写操作确实不可见。
2. 改成 `MCPServerManager` 同时接 filesystem 与 git 两个 server，故意把其中一个的 `command` 写错，观察 `active_servers`、`failed_servers`、`errors` 的差异，再用 `reconnect(failed_only=True)` 重试。
3. 打开 `repo/examples/mcp/tool_filter_example/main.py`，把 `require_approval="always"` 改成只对 `read_file` 要求审批，并让 `run_with_auto_approval` 拒绝一次，观察模型收到拒绝后的回答。

## 本章小结

- MCP 是开放协议，SDK 是它的客户端；工具语义由 server 决定，你只能过滤与包装。
- 三条传输：stdio（本地进程）、Streamable HTTP（首选远端）、SSE（仅兼容）。
- 生命周期必须"同任务 connect/cleanup"，多 server 用 `MCPServerManager` 只暴露连上的那部分。
- `mcp_config` 三个开关：strict 转换（尽力）、失败文案、server 名前缀；`require_approval` 支持五种写法，但回调拿不到单次参数。
- 本地 server 能审计能加护栏；`HostedMCPTool` 省事但把参数交给了平台。
- MCP 还能提供 prompts（指令可平台化维护）与 resources；启动慢或需要降级时，用 `MCPUtil.get_all_function_tools` 预取工具，让 `mcp_servers` 保持为空。

## 延伸阅读

- `repo/docs/mcp.md`（选型矩阵、四种集成、缓存与分页）
- `repo/src/agents/mcp/server.py`、`repo/src/agents/mcp/manager.py`、`repo/src/agents/mcp/util.py`
- `repo/examples/mcp/`（`filesystem_example`、`git_example`、`manager_example`、`tool_filter_example`）
- `repo/examples/hosted_mcp/`（`simple.py`、`on_approval.py`、`human_in_the_loop.py`）
- 下一章：《第10章 Agent即工具与工具调用控制》——把 Agent 本身变成工具，并决定模型"必须调用谁"。
