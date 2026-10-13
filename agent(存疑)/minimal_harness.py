import json, os, shutil, subprocess, tempfile
from openai import OpenAI

# ============ 配置 ============
MODEL = "qwen2.5:7b"
WORKDIR = "./agent_workspace"
MAX_STEPS = 15
MAX_CONTEXT_CHARS = 8000

client = OpenAI(base_url="http://localhost:11434/v1", api_key="ollama")


# ============ 1. 沙箱 ============
class Sandbox:
    def __init__(self, workdir):
        os.makedirs(workdir, exist_ok=True)
        self.workdir = workdir
        self.snapshot_dir = None

    def snapshot(self):
        self.snapshot_dir = tempfile.mkdtemp()
        shutil.copytree(self.workdir, self.snapshot_dir, dirs_exist_ok=True)

    def rollback(self):
        if self.snapshot_dir:
            shutil.rmtree(self.workdir)
            shutil.copytree(self.snapshot_dir, self.workdir)

    def run(self, cmd, timeout=30):
        try:
            r = subprocess.run(cmd, shell=True, cwd=self.workdir,
                               capture_output=True, text=True, timeout=timeout)
            return r.returncode, r.stdout[-2000:], r.stderr[-2000:]
        except subprocess.TimeoutExpired:
            return -1, "", "TIMEOUT"


# ============ 2. 工具注册表 ============
class ToolRegistry:
    def __init__(self):
        self.tools = {}

    def register(self, name, fn, schema, dangerous=False):
        self.tools[name] = {"fn": fn, "schema": schema, "dangerous": dangerous}

    def active(self, allowed):
        return {k: v for k, v in self.tools.items() if k in allowed}

    def call(self, name, args, approve=None):
        t = self.tools.get(name)
        if not t:
            return f"ERROR: unknown tool '{name}'"
        if t["dangerous"] and not (approve and approve(name, args)):
            return f"DENIED: '{name}' needs approval"
        try:
            return t["fn"](**args)
        except Exception as e:
            return f"ERROR: {type(e).__name__}: {e}"


def build_tools(sandbox):
    reg = ToolRegistry()

    def read_file(path):
        p = os.path.join(sandbox.workdir, path)
        with open(p) as f:
            return f.read()[:4000]

    def write_file(path, content):
        p = os.path.join(sandbox.workdir, path)
        os.makedirs(os.path.dirname(p) or ".", exist_ok=True)
        with open(p, "w") as f:
            f.write(content)
        return f"wrote {len(content)} bytes to {path}"

    def run_shell(cmd):
        code, out, err = sandbox.run(cmd)
        return f"exit={code}\nstdout:\n{out}\nstderr:\n{err}"

    def list_files():
        return "\n".join(os.listdir(sandbox.workdir)) or "(empty)"

    reg.register("read_file", read_file,
                 {"type": "function", "function": {
                     "name": "read_file", "description": "读取工作目录下的文件",
                     "parameters": {"type": "object", "properties": {
                         "path": {"type": "string"}}, "required": ["path"]}}})
    reg.register("write_file", write_file,
                 {"type": "function", "function": {
                     "name": "write_file", "description": "写入文件到工作目录",
                     "parameters": {"type": "object", "properties": {
                         "path": {"type": "string"},
                         "content": {"type": "string"}},
                         "required": ["path", "content"]}}})
    reg.register("run_shell", run_shell,
                 {"type": "function", "function": {
                     "name": "run_shell", "description": "在工作目录执行 shell 命令",
                     "parameters": {"type": "object", "properties": {
                         "cmd": {"type": "string"}}, "required": ["cmd"]}}},
                 dangerous=True)
    reg.register("list_files", list_files,
                 {"type": "function", "function": {
                     "name": "list_files", "description": "列出工作目录文件",
                     "parameters": {"type": "object", "properties": {}}}})
    return reg


# ============ 3. 审批（核心新增） ============
SAFE_PREFIXES = ("ls", "cat", "pwd", "echo", "grep", "head", "tail",
                 "python -m pytest", "python -m unittest", "find", "wc")

_approved_cache = set()   # 本次任务内已批准过的命令，避免重复问


def ask_approval(name, args):
    """
    审批策略：
      1. 非危险工具 → 直接放行
      2. 危险工具命中只读白名单 → 直接放行
      3. 之前批准过的同一条命令 → 直接放行
      4. 其余 → 弹 y/n 问用户
    """
    if name != "run_shell":
        return True

    cmd = args.get("cmd", "").strip()
    if any(cmd.startswith(p) for p in SAFE_PREFIXES):
        return True

    if cmd in _approved_cache:
        print(f"    (已批准过，自动放行: {cmd})")
        return True

    print(f"\n⚠️  Agent 请求执行命令:")
    print(f"    {cmd}")
    while True:
        ans = input("    允许吗? [y=允许 / n=拒绝 / a=本任务内总是允许] ").strip().lower()
        if ans in ("y", "yes"):
            return True
        if ans in ("n", "no", ""):
            print("    → 已拒绝")
            return False
        if ans in ("a", "always"):
            _approved_cache.add(cmd)
            print("    → 已批准，本任务内不再询问")
            return True
        print("    请输入 y / n / a")


# ============ 4. 上下文压缩 ============
def compress(messages, limit=MAX_CONTEXT_CHARS):
    total = sum(len(str(m)) for m in messages)
    if total < limit:
        return messages
    kept = [messages[0]]
    for m in reversed(messages[1:]):
        if total > limit and m.get("role") == "tool":
            m = {**m, "content": str(m["content"])[:400] + "...[truncated]"}
        kept.insert(1, m)
        total = sum(len(str(x)) for x in kept)
    return kept


# ============ 5. 完成门禁 ============
def completion_gate(sandbox, task):
    if "测试" in task or "test" in task.lower():
        code, out, err = sandbox.run("python -m pytest -q 2>&1 | tail -5")
        if code != 0:
            return False, f"测试未通过:\n{out}\n{err}"
        return True, f"测试通过:\n{out}"
    return True, "无需验证"


# ============ 6. Agent Loop ============
def run_agent(task, allowed_tools, max_steps=MAX_STEPS):
    sandbox = Sandbox(WORKDIR)
    sandbox.snapshot()
    registry = build_tools(sandbox)
    tools = registry.active(allowed_tools)
    schemas = [t["schema"] for t in tools.values()]

    messages = [
        {"role": "system", "content":
            "你是一个谨慎的 Agent。每次只做一步，用工具完成任务。"
            "如果需要执行命令，先说明你要做什么。"
            "如果工具返回 DENIED，说明用户拒绝了，请换一种方式或先询问用户，"
            "不要重复请求同一条被拒的命令。"
            "完成后直接回复最终答案，不要再调用工具。"},
        {"role": "user", "content": task},
    ]

    for step in range(max_steps):
        print(f"\n--- step {step+1} ---")
        resp = client.chat.completions.create(
            model=MODEL, messages=compress(messages),
            tools=schemas or None)
        msg = resp.choices[0].message
        messages.append(msg.model_dump())

        if not msg.tool_calls:
            ok, reason = completion_gate(sandbox, task)
            if not ok:
                print(f"[gate] 未通过，退回继续: {reason}")
                messages.append({"role": "user",
                                 "content": f"验证未通过：{reason}，请修复。"})
                continue
            return msg.content

        for tc in msg.tool_calls:
            name = tc.function.name
            try:
                args = json.loads(tc.function.arguments)
            except json.JSONDecodeError:
                args = {}
            print(f"[tool] {name}({args})")
            result = registry.call(name, args, approve=ask_approval)
            messages.append({"role": "tool", "tool_call_id": tc.id,
                             "content": str(result)[:2000]})

    return "MAX_STEPS_EXCEEDED"


# ============ 入口 ============
if __name__ == "__main__":
    print("=== Agent Harness 已启动（输入 exit / quit 退出）===")
    while True:
        try:
            task = input("\n任务> ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\n再见。")
            break

        if not task:
            continue
        if task.lower() in ("exit", "quit", "q"):
            print("再见。")
            break

        try:
            result = run_agent(
                task,
                allowed_tools=["read_file", "write_file", "run_shell", "list_files"]
            )
            print(f"\n=== 最终结果 ===\n{result}")
        except Exception as e:
            print(f"\n[任务出错，已跳过] {type(e).__name__}: {e}")