const WebSocket = require('ws');
const Database = require('better-sqlite3');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { YoloDetector } = require('./detector');

// ============ Dify 配置 ============

const DIFY_API_KEY = 'app-7SBxaviWWUGcz0Ua8jPzf1fY';;
const DIFY_API_URL = 'http://localhost/v1/chat-messages';

// ============ YOLO 配置 ============

// 图片和标注图的存放目录
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const ORIGINAL_DIR = path.join(UPLOAD_DIR, 'original');    // 用户上传的原图
const ANNOTATED_DIR = path.join(UPLOAD_DIR, 'annotated');  // YOLO 画好框的图

// 允许上传的图片类型 -> 扩展名
const ALLOWED_IMAGE_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
};

// 图片各类型对应的识别「魔数」，防止改扩展名绕过检查
const IMAGE_MAGIC = [
  { ext: '.jpg', bytes: [0xFF, 0xD8, 0xFF] },
  { ext: '.png', bytes: [0x89, 0x50, 0x4E, 0x47] },
  { ext: '.gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { ext: '.webp', bytes: [0x52, 0x49, 0x46, 0x46], extra: { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] } },
  { ext: '.bmp', bytes: [0x42, 0x4D] },
];

// 图片访问地址前缀用的端口
const PORT = Number(process.env.PORT) || 3000;

// 单张图片最大 10MB（原图也要发给别的客户端，太大容易卡）
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

// 为了防止有人疯狂发图把磁盘和 CPU 打满，做个体积不大的频率限制
const MAX_IMAGE_PER_MINUTE = 20;
const UPLOAD_RATE_WINDOW = 60 * 1000;

// JSON 请求体上限（正常用不到，防一手）
const MAX_JSON_BYTES = 1024 * 1024;

// 允许跨域访问本服务的来源（前端跑在 8080 的静态服务器上，属于跨域）
const ALLOWED_ORIGINS = new Set([
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost:3000',
  'http://127.0.0.1:3000',]);

// 检测结果本身也是聊天消息，由这个固定身份发出
const YOLO_BOT_NAME = 'YOLO';

// ============ 启动时准备目录 ============

for (const dir of [UPLOAD_DIR, ORIGINAL_DIR, ANNOTATED_DIR]) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.error(`创建目录失败 ${dir}：`, err.message);
    process.exit(1);
  }
}

// ============ 配置 ============

// 房间名和昵称允许的字符：字母、数字、下划线、短横线、中文，长度 1~20
const ROOM_PATTERN = /^[a-zA-Z0-9_\-\u4e00-\u9fa5]{1,20}$/;
const NICK_PATTERN = /^[a-zA-Z0-9_\-\u4e00-\u9fa5]{1,20}$/;

// 连接数限制
const MAX_CONNECTIONS = 1000;   // 全局最多 1000 个连接
//const MAX_PER_IP = 100;           //测试时提高限制数量
const MAX_PER_IP = 5;           // 每个 IP 最多 5 个连接
const MAX_PER_ROOM = 100;       // 每个房间最多 100 人

// 首次连接时最多拉多少条历史
const HISTORY_LIMIT = 100;

// 单条消息最大长度
const MAX_MESSAGE_LENGTH = 500;

// ============ 数据库 ============

// 连接数据库（文件不存在会自动创建）
const db = new Database('chat.db');

// 开启 WAL 模式，读写不互相阻塞
db.pragma('journal_mode = WAL');
// WAL 下 NORMAL 够用，性能好
db.pragma('synchronous = NORMAL');
// 开启外键约束（现在没用，以后有用）
db.pragma('foreign_keys = ON');
// 数据库被锁时等 5 秒
db.pragma('busy_timeout = 5000');

// 建表 + 加索引
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room TEXT NOT NULL DEFAULT 'general',
      nickname TEXT NOT NULL DEFAULT '匿名',
      content TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 迁移：老库升级。messages 表原来只有 content 一个字段，
  // 现在要区分「文本 / 图片 / YOLO 结果」三种消息，所以补一个 type 列。
  // ALTER TABLE ... ADD COLUMN 在列已存在时会报错，所以先查一下表结构。
  const columns = db.prepare('PRAGMA table_info(messages)').all();
  const hasType = columns.some((col) => col.name === 'type');

  if (!hasType) {
    db.exec(`ALTER TABLE messages ADD COLUMN type TEXT NOT NULL DEFAULT 'text'`);
    console.log('数据库迁移完成：messages 表新增 type 列');
  }

  // 加联合索引，加速 WHERE room = ? AND id > ? 查询
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_room_id
    ON messages (room, id)
  `);
} catch (err) {
  console.error('初始化数据库失败：', err.message);
  process.exit(1);
}

// ============ 预编译 SQL ============

// 插入消息
const stmtInsert = db.prepare(
  'INSERT INTO messages (room, nickname, content, type) VALUES (?, ?, ?, ?)'
);

// 按 id 查单条
const stmtSelectById = db.prepare(
  'SELECT * FROM messages WHERE id = ?'
);

// 首次连接：拿最近 N 条（倒序）
const stmtHistoryRecent = db.prepare(
  'SELECT * FROM messages WHERE room = ? ORDER BY id DESC LIMIT ?'
);

// 重连：拿 lastId 之后的所有新消息
const stmtHistoryAfter = db.prepare(
  'SELECT * FROM messages WHERE room = ? AND id > ? ORDER BY id ASC'
);

// 更新某条消息的内容（用于把图片消息从「检测中」改成最终状态）
const stmtUpdateContent = db.prepare(
  'UPDATE messages SET content = ? WHERE id = ?'
);

// ============ 房间与广播 ============

// 房间名 -> 客户端集合
const rooms = new Map();

// 把一条消息发给房间里的所有人
function broadcast(room, row) {
  const clients = rooms.get(room);
  if (!clients) return;

  const data = JSON.stringify(row);   // 只序列化一次

  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(data);
      } catch (err) {
        // 单个客户端发送失败，不影响其他人
        console.error(`发送给 [${room}] 的客户端失败：`, err.message);
      }
    }
  });
}

// 写一条消息进库并广播，返回完整记录
function saveAndBroadcast(room, nickname, content, type = 'text') {
  const info = stmtInsert.run(room, nickname, content, type);
  const row = stmtSelectById.get(info.lastInsertRowid);
  broadcast(room, row);
  return row;
}

// ============ YOLO 自动检测 ============

// 全局只有一个检测器实例，模型只加载一次
const detector = new YoloDetector();

// YOLO 结果消息的内容大小上限：标注图 URL + 检测列表，
// 太长会撑爆前端气泡也影响历史记录体积
const YOLO_CONTENT_LIMIT = 4000;

/**
 * 把内部错误翻译成给聊天室用户看的短句。
 *
 * 原始的报错（比如「没有找到安装了 ultralytics 的 Python 解释器…」，
 * 还带换行和绝对路径）对普通用户没有意义，而且换行会把聊天气泡撑得很难看。
 * 详细原因照旧打在服务器控制台里，界面上只说人话。
 */
function friendlyYoloError(message) {
  const text = String(message || '');

  if (text.includes('ultralytics') || text.includes('解释器')) {
    return '服务器上没有可用的 YOLO 环境，请联系管理员';
  }
  if (text.includes('超时') || text.includes('timeout')) {
    return '检测超时，请稍后重试';
  }
  if (text.includes('进程')) {
    return '检测程序异常退出，请稍后重试';
  }
  if (text.includes('找不到模型') || text.includes('模型加载失败')) {
    return '服务器上找不到模型文件，请联系管理员';
  }

  // 兜底：只取第一行，并砍掉过长的内容
  const firstLine = text.split('\n')[0].trim();
  return firstLine.length > 60 ? firstLine.slice(0, 60) + '…' : firstLine;
}

/** 把检测结果整理成前端好显示的文字，例如 "person×2, umbrella×1" */
function summarizeDetections(detections) {
  const counter = new Map();

  for (const det of detections) {
    counter.set(det.class, (counter.get(det.class) || 0) + 1);
  }

  // 按出现次数从多到少排，种类一样时按名字排，保证结果稳定
  return Array.from(counter.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => (count > 1 ? `${name}×${count}` : name))
    .join(', ');
}

/**
 * 对一张已保存的图片做检测，并把结果作为 YOLO 机器人的消息发到房间里。
 *
 * 刻意做成「异步不阻塞」：图片一上传就立刻广播出去，
 * 用户先看到自己发的图，几秒后 YOLO 的结果再作为下一条消息出现。
 * 这样体验上不会觉得界面卡住。
 *
 * @param {string} room      房间名
 * @param {string} filename  保存在 ORIGINAL_DIR 下的文件名
 * @param {number} messageId 原图片消息的 id（用于回写检测状态）
 */
async function runYoloDetection(room, filename, messageId) {
  const imagePath = path.join(ORIGINAL_DIR, filename);

  // 记录消息 id -> 原 content 对象，检测完要在它上面加状态字段
  let originalMessage = null;
  try {
    originalMessage = stmtSelectById.get(messageId);
  } catch (err) {
    console.error('读取图片消息失败：', err.message);
  }

  try {
    const result = await detector.detect(imagePath, ANNOTATED_DIR);
    const detections = result.detections || [];

    // ---------- 1. 回写原图片消息的状态 ----------
    if (originalMessage) {
      let meta;
      try {
        meta = JSON.parse(originalMessage.content);
      } catch {
        meta = null;
      }

      if (meta && typeof meta === 'object') {
        meta.status = 'done';
        meta.count = detections.length;
        try {
          const content = JSON.stringify(meta);
          stmtUpdateContent.run(content, messageId);
          broadcast(room, { ...originalMessage, content });
        } catch (err) {
          console.error('回写图片检测状态失败：', err.message);
        }
      }
    }

    // ---------- 2. 组装 YOLO 结果消息 ----------
    // 标注图被 ultralytics 存在 save_dir 下的子目录里（通常是 predict/），
    // 这里把它搬到统一的 annotated 目录，前端只需要按文件名访问。
    let annotatedName = null;

    if (result.annotated) {
      const source = path.join(ANNOTATED_DIR, result.annotated);
      const target = path.join(ANNOTATED_DIR, filename);

      try {
        if (fs.existsSync(source)) {
          fs.renameSync(source, target);
          annotatedName = filename;
          // 顺手把 predict/ 之类的空目录删掉，不然 uploads 会越积越乱
          const parent = path.dirname(source);
          if (parent !== ANNOTATED_DIR) {
            try {
              fs.rmSync(parent, { recursive: true, force: true });
            } catch {
              // 删不掉不影响功能
            }
          }
        }
      } catch (err) {
        console.error('移动标注图失败：', err.message);
      }
    }

    const summary = detections.length > 0
      ? summarizeDetections(detections)
      : '没有检测到目标';

    const payload = {
      annotated: annotatedName,
      summary,
      detections: detections,
    };

    let content = JSON.stringify(payload);
    if (content.length > YOLO_CONTENT_LIMIT) {
      // 目标数量极多时，退化成「只保留类别和置信度最高的若干条」
      payload.detections = detections.slice(0, 50);
      payload.truncated = detections.length - payload.detections.length;
      content = JSON.stringify(payload);
    }

    saveAndBroadcast(room, YOLO_BOT_NAME, content, 'yolo');

    console.log(`[YOLO] [${room}] ${filename} 检测完成：${detections.length} 个目标（${summary}）`);

  } catch (err) {
    console.error(`[YOLO] [${room}] ${filename} 检测失败：`, err.message);

    // ---------- 失败也要给用户一个交代 ----------
    try {
      if (originalMessage) {
        let meta;
        try {
          meta = JSON.parse(originalMessage.content);
        } catch {
          meta = null;
        }

        if (meta && typeof meta === 'object') {
          meta.status = 'failed';
          meta.count = 0;
          const content = JSON.stringify(meta);
          stmtUpdateContent.run(content, messageId);
          broadcast(room, { ...originalMessage, content });
        }
      }

      // 把失败原因也发出来，否则用户只看到「检测中」永远转圈会很困惑。
      // 这里用翻译过的短句，完整原因在上面已经打到控制台了。
      saveAndBroadcast(
        room,
        YOLO_BOT_NAME,
        JSON.stringify({
          annotated: null,
          summary: '检测失败：' + friendlyYoloError(err.message),
          detections: [],
          error: true,
        }),
        'yolo'
      );
    } catch (innerErr) {
      console.error('发送检测失败消息时又出错：', innerErr.message);
    }
  }
}

// ============ Dify 调用 ============

async function callDify(room, userMessage) {
  try {
    const resp = await fetch(DIFY_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DIFY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        inputs: {},
        query: userMessage,
        response_mode: 'blocking',
        user: 'chatroom-' + room
      })
    });

    if (!resp.ok) {
      console.error('Dify 返回错误状态：', resp.status);
      return;
    }

    const data = await resp.json();
    const answer = data.answer || '（AI 没有返回内容）';

    // 存进数据库并广播给同房间
    saveAndBroadcast(room, 'AI', answer, 'text');
  } catch (err) {
    console.error('调用 Dify 失败：', err.message);
  }
}

// ============ HTTP 服务器（图片上传 + 静态图片） ============
//
// WebSocket 负责传消息，HTTP 负责传图片文件本身。
// 之所以不让图片走 WebSocket：
//   1. Base64 会把体积撑大约 33%，而 WebSocket 帧越大越容易造成卡顿；
//   2. 图片是一对多的（一个房间的人都要看），用 URL + HTTP 缓存更合适；
//   3. ws 库所在的 Node 版本对「二进制 + 文本」混在一个连接里的处理比较麻烦。

/** 简单限流：同一个 IP 每分钟最多发 MAX_IMAGE_PER_MINUTE 张图 */
const uploadTimes = new Map();   // ip -> 时间戳数组

function checkUploadRate(ip) {
  const now = Date.now();
  const times = (uploadTimes.get(ip) || []).filter((t) => now - t < UPLOAD_RATE_WINDOW);

  if (times.length >= MAX_IMAGE_PER_MINUTE) {
    uploadTimes.set(ip, times);
    return false;
  }

  times.push(now);
  uploadTimes.set(ip, times);
  return true;
}

// 定期清理限流表，避免长期运行下 Map 无限增长
setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of uploadTimes) {
    const alive = times.filter((t) => now - t < UPLOAD_RATE_WINDOW);
    if (alive.length === 0) {
      uploadTimes.delete(ip);
    } else {
      uploadTimes.set(ip, alive);
    }
  }
}, UPLOAD_RATE_WINDOW).unref();

/** 按魔数判断图片真实类型，返回扩展名；不是支持的图片则返回 null */
function sniffImageType(buffer) {
  // JPEG 比较特殊：魔数后面还跟着第 4 个字节，这里只比较前 3 个即可
  for (const magic of IMAGE_MAGIC) {
    if (buffer.length < magic.bytes.length) continue;

    const headMatch = magic.bytes.every((byte, i) => buffer[i] === byte);
    if (!headMatch) continue;

    if (magic.extra) {
      const { offset, bytes } = magic.extra;
      if (buffer.length < offset + bytes.length) continue;
      if (!bytes.every((byte, i) => buffer[offset + i] === byte)) continue;
    }

    return magic.ext;
  }
  return null;
}

/** 把请求体读成 Buffer，超过上限就直接切断并返回 null */
function readBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let aborted = false;

    req.on('data', (chunk) => {
      if (aborted) return;

      size += chunk.length;
      if (size > limit) {
        aborted = true;
        resolve(null);
        // 主动断开，不再继续接收无用数据
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (!aborted) resolve(Buffer.concat(chunks));
    });

    req.on('error', () => {
      if (!aborted) resolve(null);
    });
  });
}

/** 统一的 JSON 响应 */
function sendJson(res, status, obj, origin) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');

  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };

  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }

  res.writeHead(status, headers);
  res.end(body);
}

/** 处理图片上传：POST /upload?room=xxx&nickname=yyy，请求体是图片原始字节 */
async function handleUpload(req, res, url, origin) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress
    || 'unknown';

  if (!checkUploadRate(ip)) {
    sendJson(res, 429, { error: `发图太频繁，每分钟最多 ${MAX_IMAGE_PER_MINUTE} 张` }, origin);
    return;
  }

  // 房间名和昵称要和 WebSocket 连接时用同一套规则校验
  const room = (url.searchParams.get('room') || '').trim();
  const nickname = (url.searchParams.get('nickname') || '匿名').trim().slice(0, 20);

  if (!ROOM_PATTERN.test(room)) {
    sendJson(res, 400, { error: '非法房间名' }, origin);
    return;
  }

  if (!NICK_PATTERN.test(nickname)) {
    sendJson(res, 400, { error: '非法昵称' }, origin);
    return;
  }

  const body = await readBody(req, MAX_IMAGE_BYTES);

  if (body === null) {
    sendJson(res, 413, { error: `图片太大，单张不能超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB` }, origin);
    return;
  }

  if (body.length === 0) {
    sendJson(res, 400, { error: '没有收到图片数据' }, origin);
    return;
  }

  // 不看请求头里声明的 Content-Type，只看文件内容，
  // 因为请求头是客户端说了算的，随时可以伪造
  const ext = sniffImageType(body);

  if (!ext) {
    sendJson(res, 415, { error: '不是支持的图片格式（支持 jpg / png / webp / gif / bmp）' }, origin);
    return;
  }

  // 文件名用随机串 + 时间戳，避免不同房间/不同用户重名互相覆盖
  const filename = `${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}${ext}`;
  const filePath = path.join(ORIGINAL_DIR, filename);

  try {
    fs.writeFileSync(filePath, body);
  } catch (err) {
    console.error('保存图片失败：', err.message);
    sendJson(res, 500, { error: '服务器保存图片失败' }, origin);
    return;
  }

  const meta = {
    url: `/uploads/original/${filename}`,
    name: filename,
    size: body.length,
    status: 'pending',   // pending -> done / failed，由 runYoloDetection 回写
    count: null,
  };

  let row;
  try {
    row = saveAndBroadcast(room, nickname, JSON.stringify(meta), 'image');
  } catch (err) {
    console.error('保存图片消息失败：', err.message);
    sendJson(res, 500, { error: '服务器保存消息失败' }, origin);
    return;
  }

  console.log(`[${room}] ${nickname} 发了一张图片：${filename}（${body.length} 字节）`);

  // 立刻回执，前端不用等检测完
  sendJson(res, 200, { ok: true, message: row, yolo: detector.info().ready }, origin);

  // 异步触发 YOLO 检测，不阻塞响应
  // setImmediate 让上面的响应先发出去，再开始跑检测
  setImmediate(() => {
    runYoloDetection(room, filename, row.id).catch((err) => {
      console.error('YOLO 检测流程异常：', err.message);
    });
  });
}

/** 处理静态图片请求：GET /uploads/original/xxx.jpg */
function handleStaticFile(req, res, pathname) {
  // 只允许访问 uploads 下的 original 和 annotated 两个目录
  const prefix = '/uploads/';

  if (!pathname.startsWith(prefix)) {
    sendJson(res, 404, { error: 'Not Found' });
    return;
  }

  const relative = pathname.slice(prefix.length);

  // 防目录穿越：解析后必须仍然落在 UPLOAD_DIR 里面
  const target = path.resolve(UPLOAD_DIR, relative);
  const root = path.resolve(UPLOAD_DIR);

  if (target !== root && !target.startsWith(root + path.sep)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  const allowedExt = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);

  if (!allowedExt.has(path.extname(target).toLowerCase())) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      sendJson(res, 404, { error: '图片不存在' });
      return;
    }

    const ext = path.extname(target).toLowerCase();
    const mime = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
    }[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      // 文件名是随机且唯一的，内容不会变，可以放心长缓存
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    });

    fs.createReadStream(target).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  const allowedOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : null;

  // 预检请求
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': allowedOrigin || 'null',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    });
    res.end();
    return;
  }

  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    sendJson(res, 400, { error: '非法请求' });
    return;
  }

  const pathname = decodeURIComponent(url.pathname);

  // 上传接口
  if (pathname === '/upload') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: '请用 POST 上传' }, allowedOrigin);
      return;
    }

    handleUpload(req, res, url, allowedOrigin).catch((err) => {
      console.error('处理上传请求出错：', err.message);
      if (!res.headersSent) {
        sendJson(res, 500, { error: '服务器内部错误' }, allowedOrigin);
      }
    });
    return;
  }

  // 供前端查询 YOLO 是否就绪（前端用它决定要不要提示「模型加载中」）
  if (pathname === '/yolo-status') {
    sendJson(res, 200, detector.info(), allowedOrigin);
    return;
  }

  // 静态图片
  if (req.method === 'GET' || req.method === 'HEAD') {
    handleStaticFile(req, res, pathname);
    return;
  }

  sendJson(res, 404, { error: 'Not Found' });
});

// ============ WebSocket 服务器 ============

// WebSocket 和 HTTP 共用一个端口（3000），
// 这样前端只需要知道一个地址，图片 URL 也能直接写成相对路径
const wss = new WebSocket.Server({ server });

// ============ 监听失败的处理 ============
//
// 这里有个容易踩的坑：ws 库会把它宿主 HTTP 服务器的 'error' 事件
// 重新在 WebSocketServer 上再发一次。如果只给 http server 加了监听，
// 端口被占用时仍然会抛出「未处理的 error 事件」，
// 结果是进程直接崩掉、还打印一大段堆栈，我们自己写的友好提示根本来不及显示。
// 所以这里给两边都挂上监听，并用一个标志位保证只处理一次。
let portHandled = false;

function handleListenError(err) {
  if (portHandled) return;
  portHandled = true;

  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用。`);
    console.error('请先关闭正在使用该端口的程序（很可能是上一次没关掉的 node server.js），再重新启动。');
  } else if (err.code === 'EACCES') {
    console.error(`没有权限监听端口 ${PORT}。`);
  } else {
    console.error('服务器启动失败：' + err.message);
  }

  // 用 exit 而不是继续往下跑：监听都没成功，后面的逻辑没有意义
  process.exit(1);
}

server.on('error', handleListenError);
wss.on('error', handleListenError);

// IP -> 连接数
const ipConnections = new Map();

wss.on('connection', (ws, req) => {
  // ========== 全局连接数限制 ==========
  if (wss.clients.size >= MAX_CONNECTIONS) {
    console.log('全局连接数已满，拒绝连接');
    ws.close(1013, '服务器繁忙，请稍后重试');
    return;
  }

  // ========== 获取客户端 IP ==========
  // 如果有反向代理，优先读 X-Forwarded-For
  const forwarded = req.headers['x-forwarded-for'];
  const ip = forwarded
    ? forwarded.split(',')[0].trim()
    : req.socket.remoteAddress;

  // 尽早记录 IP，方便 close 时减计数
  ws.ip = ip;

  // ========== 单 IP 连接数限制 ==========
  const ipCount = ipConnections.get(ip) || 0;
  if (ipCount >= MAX_PER_IP) {
    console.log(`IP ${ip} 连接数超限，拒绝连接`);
    ws.close(1013, '同一 IP 连接数过多');
    return;
  }
  ipConnections.set(ip, ipCount + 1);

  // ========== 解析 URL 参数 ==========
  const url = new URL(req.url, 'http://localhost');

  // 房间名：去空格，默认 general
  const room = (url.searchParams.get('room') || 'general').trim();

  // lastId：解析失败就当 0
  let lastId = parseInt(url.searchParams.get('lastId') || '0', 10);
  if (Number.isNaN(lastId) || lastId < 0) lastId = 0;

  // 连接时拿昵称
  const rawNickname = (url.searchParams.get('nickname') || '匿名').trim().slice(0, 20);
  const nickname = rawNickname === '' ? '匿名' : rawNickname;

  // ========== 校验房间名 ==========
  if (!ROOM_PATTERN.test(room)) {
    console.log('非法房间名，拒绝连接：', room);
    ws.close(1008, '非法房间名');
    return;
  }

  // ========== 校验昵称 ==========
  if (!NICK_PATTERN.test(nickname)) {
    console.log('非法昵称，拒绝连接：', nickname);
    ws.close(1008, '非法昵称');
    return;
  }

  // ========== 单房间连接数限制 ==========
  const roomClients = rooms.get(room);
  if (roomClients && roomClients.size >= MAX_PER_ROOM) {
    console.log(`房间 ${room} 人数已满，拒绝连接`);
    ws.close(1013, '房间人数已满');
    return;
  }

  // ========== 挂载属性 ==========
  ws.room = room;
  ws.nickname = nickname;

  // ========== 加入房间集合 ==========
  if (!rooms.has(room)) {
    rooms.set(room, new Set());
  }
  rooms.get(room).add(ws);

  console.log(`有人连上了，房间：${room}，昵称：${nickname}，IP：${ip}，从 id > ${lastId} 开始拉历史`);

  // ========== 拉历史 ==========
  let history = [];
  try {
    if (lastId === 0) {
      // 首次连接：取最近 N 条，翻回正序
      history = stmtHistoryRecent.all(room, HISTORY_LIMIT);
      history.reverse();
    } else {
      // 重连：取 lastId 之后的
      history = stmtHistoryAfter.all(room, lastId);
    }
  } catch (err) {
    console.error('查询历史失败：', err.message);
  }

  history.forEach((row) => {
    ws.send(JSON.stringify(row));
  });

  // ========== 收到消息 ==========
  ws.on('message', (data) => {
    const raw = data.toString();

    // 解析 JSON
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      console.log('收到非法 JSON，忽略');
      return;
    }

    // 用连接时定的昵称，改名避免和外层 nickname 重名
    const senderNickname = ws.nickname;
    let content = (payload.content || '').toString();

    // 过滤控制字符（保留 \t \n \r）
    content = content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

    if (content === '') return;
    if (content.length > MAX_MESSAGE_LENGTH) return;

    // 插入消息（文本消息的 type 固定是 text）
    let row;
    try {
      row = saveAndBroadcast(room, senderNickname, content, 'text');
    } catch (err) {
      console.error('插入消息失败：', err.message);
      return;
    }

    // 异步调用 AI，不阻塞广播
    // 注意：只有文本消息才送给 Dify。
    // 图片消息走的是 /upload 接口（图片本体不经过 WebSocket），
    // 而 YOLO 的结果消息是机器人自己发的，也不该再喂给文本 AI，
    // 否则会形成「AI 回复 AI」的循环。
    callDify(room, content);
  });

  // ========== 关闭时清理 ==========
  ws.on('close', () => {
    console.log(`有人离开了，房间：${room}，昵称：${nickname}，IP：${ip}`);

    // 从房间集合移除
    const clients = rooms.get(room);
    if (clients) {
      clients.delete(ws);
      if (clients.size === 0) {
        rooms.delete(room);
      }
    }

    // IP 连接数减 1
    const count = ipConnections.get(ws.ip) || 0;
    if (count <= 1) {
      ipConnections.delete(ws.ip);
    } else {
      ipConnections.set(ws.ip, count - 1);
    }
  });

  // ========== 错误处理 ==========
  ws.on('error', (err) => {
    console.error(`[${room}] 连接出错：`, err.message);
  });
});

server.listen(PORT, () => {
  console.log(`服务器在 ${PORT} 端口跑起来了`);
  console.log(`聊天室前端：http://localhost:8080/index.html`);
  console.log(`图片上传接口：POST http://localhost:${PORT}/upload`);
  console.log(`图片访问地址：http://localhost:${PORT}/uploads/...`);

  // 预热 YOLO：在后台提前把模型加载好。
  // 这样用户发第一张图时不用等模型加载（否则第一次要等好几秒）。
  // 放在 listen 回调里而不是顶层，是为了避免端口被占用时
  // 白白启动一个 Python 进程再退出。
  // 加载失败不影响聊天室本身，文本聊天照常可用。
  detector.start().then((ok) => {
    if (ok) {
      console.log('[YOLO] 自动检测已就绪');
    } else {
      console.warn('[YOLO] 未能启动，图片仍可正常发送，但不会自动检测。');
      console.warn('[YOLO] 原因：' + (detector.lastError || '未知'));
    }
  }).catch((err) => {
    console.warn('[YOLO] 启动异常：' + err.message);
  });
});

// 监听阶段的错误由上面的 handleListenError 统一处理

// ============ 优雅关闭 ============

let isShuttingDown = false;

function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`收到 ${signal} 信号，正在关闭服务器...`);

  // 先停掉 Python 检测进程，避免留下孤儿进程
  detector.stop();

  // 通知所有客户端
  wss.clients.forEach((client) => {
    try {
      client.close(1001, '服务器关闭中');
    } catch (err) {
      // 忽略关闭失败的连接
    }
  });

  // 关闭 WebSocket 服务器
  wss.close(() => {
    console.log('WebSocket 服务器已关闭');

    // 关闭数据库
    try {
      db.close();
      console.log('数据库已关闭');
    } catch (err) {
      console.error('关闭数据库失败：', err.message);
    }

    console.log('进程退出');
    process.exit(0);
  });

  // 兜底：5 秒内没关完，强制退出
  setTimeout(() => {
    console.error('关闭超时，强制退出');
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));