/**
 * YOLO 检测桥接模块（Node 侧）
 *
 * 做三件事：
 *   1. 找到可用的 Python 解释器（必须是装了 ultralytics 的那个）
 *   2. 以子进程方式常驻运行 yolo_worker.py，模型只加载一次
 *   3. 对外提供 detect() 方法，内部处理请求排队、超时和进程崩溃重启
 *
 * 为什么要常驻进程：
 *   ultralytics 加载权重到 torch 就绪需要 2~4 秒。如果每次检测都起新进程，
 *   用户每发一张图都要多等几秒。常驻之后模型只加载一次，之后每张图只要几十毫秒。
 *
 * 设计上的一个取舍：检测请求串行执行（用队列），不做并发。
 *   原因是 YOLO 单张推理只要几毫秒，串行的吞吐量完全够用；
 *   而且并发会让 CPU/GPU 争抢，反而更慢，还容易把内存吃满。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const WORKER_SCRIPT = path.join(__dirname, 'yolo_worker.py');

// 模型加载比较慢，给足时间；单张推理很快，超时时间可以短一些
const STARTUP_TIMEOUT = 120000;
const DETECT_TIMEOUT = 60000;

// 启动失败后，隔多久才允许再试一次（避免每个请求都重启一遍几秒的进程）
const RETRY_COOLDOWN = 30000;

/**
 * 候选 Python 解释器，按顺序探测。
 * 本机只有 C:\Python314 装了 ultralytics，所以它排在前面；
 * 但直接把绝对路径写死不利于换机器，因此探测失败会继续往后找。
 * 也可以完全用环境变量 YOLO_PYTHON 覆盖。
 */
function candidateInterpreters() {
  const list = [];

  if (process.env.YOLO_PYTHON) {
    list.push({ exe: process.env.YOLO_PYTHON, prefix: [] });
  }

  // 明确指定本机装了 ultralytics 的解释器
  list.push({ exe: 'C:\\Python314\\python.exe', prefix: [] });

  // 常规命令名，交给 PATH 去找
  list.push({ exe: 'python', prefix: [] });
  list.push({ exe: 'py', prefix: ['-3'] });
  list.push({ exe: 'python3', prefix: [] });

  return list;
}

class YoloDetector {
  constructor() {
    this.child = null;
    this.status = 'idle';       // idle | starting | ready | failed | stopped
    this.lastError = null;
    this.modelPath = null;
    this.classList = null;

    this.nextId = 1;
    this.pending = new Map();    // id -> {resolve, reject, timer}
    this.queue = [];             // 等待执行的检测任务
    this.busy = false;
    this.readyWaiters = [];      // 等待 ready 的回调
    this.failedAt = 0;
    this.watchdog = null;
  }

  /** 当前 Python 解释器（探测成功后缓存，避免每次都试一遍） */
  get interpreter() {
    return this._interpreter || null;
  }

  /**
   * 用 `python -c "import ultralytics"` 检查某个解释器能不能用。
   * 同步执行（spawnSync），因为只在启动时跑一次，简单可靠比异步优雅更重要。
   */
  probeInterpreter(candidate) {
    const { spawnSync } = require('child_process');

    try {
      const res = spawnSync(
        candidate.exe,
        [...candidate.prefix, '-c', 'import ultralytics, sys; print(sys.version.split()[0])'],
        { encoding: 'utf8', timeout: 60000, windowsHide: true }
      );

      if (res.status === 0) {
        return { ok: true, exe: candidate.exe, prefix: candidate.prefix, version: (res.stdout || '').trim() };
      }
      return { ok: false, reason: (res.stderr || '').trim().split('\n').pop() || 'exit ' + res.status };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  /** 依次探测，返回第一个装了 ultralytics 的解释器 */
  findInterpreter() {
    for (const candidate of candidateInterpreters()) {
      // 带路径的先确认文件存在，省一次进程启动开销
      if (/[\\/]/.test(candidate.exe) && !fs.existsSync(candidate.exe)) continue;

      const result = this.probeInterpreter(candidate);
      if (result.ok) {
        console.log(`[YOLO] 使用 Python 解释器：${result.exe}（Python ${result.version}，已安装 ultralytics）`);
        return result;
      }
      console.log(`[YOLO] 跳过 ${candidate.exe}：${result.reason}`);
    }
    return null;
  }

  /** 启动常驻 worker 并等待它把模型加载完 */
  async start() {
    if (this.status === 'ready') return true;
    if (this.status === 'starting') return this.waitForReady();

    if (this.status === 'failed') {
      // 失败过不代表永远失败：可能是磁盘临时繁忙、显存被别人占用之类的瞬时问题。
      // 但也不能每个请求都重试一遍（那会反复启动几秒的进程），所以限制重试频率。
      const since = Date.now() - (this.failedAt || 0);

      if (since < RETRY_COOLDOWN) {
        return false;
      }

      console.log(`[YOLO] 距离上次失败已过 ${Math.round(since / 1000)} 秒，重试启动检测进程...`);
      this.status = 'idle';
      this.lastError = null;
    }

    if (this.status === 'stopped') return false;

    this.status = 'starting';

    if (!fs.existsSync(WORKER_SCRIPT)) {
      this.fail(`找不到 yolo_worker.py：${WORKER_SCRIPT}`);
      return false;
    }

    const found = this.findInterpreter();
    if (!found) {
      this.fail('没有找到安装了 ultralytics 的 Python 解释器。请先运行：py -m pip install ultralytics\n' +
                '（如果 ultralytics 装在别的环境里，可以设置环境变量 YOLO_PYTHON 指向那个 python.exe）');
      return false;
    }

    this._interpreter = found;

    console.log('[YOLO] 正在加载模型，首次大约需要几秒...');

    let child;
    try {
      child = spawn(found.exe, [...found.prefix, '-u', WORKER_SCRIPT], {
        cwd: __dirname,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      this.fail('启动 Python 失败：' + err.message);
      return false;
    }

    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.onStdout(chunk));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      // worker 的日志走 stderr，直接转发方便排查
      const text = chunk.trim();
      if (text) console.log('[YOLO:py] ' + text);
    });

    child.on('error', (err) => {
      this.fail('Python 进程出错：' + err.message);
    });

    child.on('close', (code) => {
      // 进程退出：可能是启动失败，也可能是运行中崩了
      const wasReady = this.status === 'ready';
      this.child = null;

      // 所有在途请求都失败掉，避免调用方永远等下去
      for (const [id, job] of this.pending) {
        clearTimeout(job.timer);
        job.reject(new Error('YOLO 进程已退出'));
        this.pending.delete(id);
      }

      // 关闭服务器时主动 kill 会走到这里，此时状态已经是 stopped，不该再重启
      if (this.status === 'stopped') return;

      if (wasReady) {
        console.error(`[YOLO] 检测进程意外退出（code=${code}），5 秒后自动重启`);
        this.status = 'idle';
        // 主动重启，而不是等下一次有人发图才重启：
        // 这样下次发图时模型已经加载好了，用户不用等
        this.scheduleRestart(5000);
      } else if (this.status === 'starting') {
        this.fail(`YOLO 进程启动失败，退出码 ${code}`);
      }
    });

    return this.waitForReady();
  }

  /** 延迟重启（用于崩溃后自动恢复） */
  scheduleRestart(delay) {
    if (this.restartTimer) clearTimeout(this.restartTimer);

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      // 只有确实处于「需要启动」的状态才动手，避免和别处的启动逻辑打架
      if (this.status === 'idle') {
        this.start().catch((err) => {
          console.error('[YOLO] 自动重启失败：' + err.message);
        });
      }
    }, delay);

    // 不要因为这个定时器让进程无法退出
    if (this.restartTimer.unref) this.restartTimer.unref();
  }

  /**
   * 启动一个健康检查定时器：周期性 ping 检测进程。
   * 如果进程已经卡死或悄悄退出，ping 会失败，从而触发重启逻辑，
   * 不用等到用户发图时才发现检测功能坏了。
   */
  startWatchdog(interval = 60000) {
    if (this.watchdog) return;

    this.watchdog = setInterval(async () => {
      if (this.status !== 'ready' || !this.child) return;

      try {
        await this.send({ cmd: 'ping' });
      } catch (err) {
        console.error('[YOLO] 健康检查失败：' + err.message + '，准备重启检测进程');
        this.status = 'idle';

        // 主动结束已经没用的进程，close 回调里会安排重启
        try {
          this.child.kill();
        } catch {
          this.scheduleRestart(1000);
        }
      }
    }, interval);

    if (this.watchdog.unref) this.watchdog.unref();
  }

  /** 等待 ready（或启动失败） */
  waitForReady() {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.fail('加载模型超时（超过 ' + (STARTUP_TIMEOUT / 1000) + ' 秒）');
      }, STARTUP_TIMEOUT);

      this.readyWaiters.push((ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
    });
  }

  fail(message) {
    this.status = 'failed';
    this.lastError = message;
    this.failedAt = Date.now();
    console.error('[YOLO] ' + message);

    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    waiters.forEach((fn) => fn(false));
  }

  /** 处理 worker 的一行行 JSON 输出 */
  onStdout(chunk) {
    // 一个 chunk 里可能有多行，也可能只有半行，所以必须自己按行缓冲
    this._buffer = (this._buffer || '') + chunk;

    let index;
    while ((index = this._buffer.indexOf('\n')) >= 0) {
      const line = this._buffer.slice(0, index).trim();
      this._buffer = this._buffer.slice(index + 1);
      if (!line) continue;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // 不是 JSON 的输出（比如第三方库的警告）忽略掉，不能让它打断协议
        console.log('[YOLO:py] ' + line);
        continue;
      }

      this.onMessage(msg);
    }
  }

  onMessage(msg) {
    if (msg.type === 'ready') {
      this.status = 'ready';
      this.modelPath = msg.model;
      this.classList = msg.names || null;
      console.log(`[YOLO] 模型加载完成：${msg.model}（${msg.classes} 个类别）`);

      // 就绪之后开始周期性健康检查，进程万一挂了能被及时发现
      this.startWatchdog();

      const waiters = this.readyWaiters;
      this.readyWaiters = [];
      waiters.forEach((fn) => fn(true));
      return;
    }

    if (msg.type === 'fatal') {
      this.fail('模型加载失败：' + msg.error);
      return;
    }

    // 普通响应：按 id 找回对应的等待者
    const job = this.pending.get(msg.id);
    if (!job) return;

    clearTimeout(job.timer);
    this.pending.delete(msg.id);

    if (msg.ok) {
      job.resolve(msg);
    } else {
      job.reject(new Error(msg.error || '检测失败'));
    }
  }

  /** 往 worker 写一条请求（内部用，不做队列管理） */
  send(payload) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('检测超时'));
      }, DETECT_TIMEOUT);

      this.pending.set(id, { resolve, reject, timer });

      try {
        this.child.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('向检测进程发送请求失败：' + err.message));
      }
    });
  }

  /**
   * 对外主入口：检测一张图片。
   * @param {string} imagePath 原图绝对路径
   * @param {string} saveDir   标注图输出目录（可为空，为空则只返回坐标不画图）
   * @returns {Promise<{detections:Array, annotated:string|null, width:number, height:number}>}
   */
  async detect(imagePath, saveDir) {
    // 串行队列：busy 为真时先排队，避免并发压满 CPU
    if (this.busy) {
      return new Promise((resolve, reject) => {
        this.queue.push({ imagePath, saveDir, resolve, reject });
      });
    }

    this.busy = true;
    try {
      const ok = await this.start();
      if (!ok) throw new Error(this.lastError || 'YOLO 不可用');

      const result = await this.send({ cmd: 'detect', image: imagePath, save_dir: saveDir || undefined });

      return {
        detections: result.detections || [],
        annotated: result.annotated || null,
        width: result.width || null,
        height: result.height || null,
        inferenceMs: result.inference_ms || null,
      };
    } finally {
      this.busy = false;

      // 处理下一个排队任务
      const next = this.queue.shift();
      if (next) {
        this.detect(next.imagePath, next.saveDir).then(next.resolve, next.reject);
      }
    }
  }

  /** 供 /status 接口和前端显示的简要状态 */
  info() {
    return {
      status: this.status,
      ready: this.status === 'ready',
      model: this.modelPath,
      error: this.lastError,
      queued: this.queue.length,
    };
  }

  /** 进程退出时清理 */
  stop() {
    this.status = 'stopped';

    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (this.child) {
      try {
        this.child.stdin.end();
        this.child.kill();
      } catch {
        // 已经退出了，忽略
      }
      this.child = null;
    }
  }
}

module.exports = { YoloDetector };
