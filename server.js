const WebSocket = require('ws');
const Database = require('better-sqlite3');

// ============ Dify 配置 ============

const DIFY_API_KEY = 'app-7SBxaviWWUGcz0Ua8jPzf1fY';;
const DIFY_API_URL = 'http://localhost/v1/chat-messages';

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
  'INSERT INTO messages (room, nickname, content) VALUES (?, ?, ?)'
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

    // 存进数据库
    const info = stmtInsert.run(room, 'AI', answer);
    const aiRow = stmtSelectById.get(info.lastInsertRowid);

    // 广播给同房间
    const clients = rooms.get(room);
    if (clients) {
      const payload = JSON.stringify(aiRow);
      clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(payload);
        }
      });
    }
  } catch (err) {
    console.error('调用 Dify 失败：', err.message);
  }
}

// ============ WebSocket 服务器 ============

// 启动 WebSocket 服务器，监听 3000 端口
const wss = new WebSocket.Server({ port: 3000 });

// 房间名 -> 客户端集合
const rooms = new Map();

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

    // 插入消息 + 查完整记录
    let row;
    try {
      const info = stmtInsert.run(room, senderNickname, content);
      row = stmtSelectById.get(info.lastInsertRowid);
    } catch (err) {
      console.error('插入消息失败：', err.message);
      return;
    }

    // 只广播给同房间
    const clients = rooms.get(room);
    if (clients) {
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

    // 异步调用 AI，不阻塞广播
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

console.log('服务器在 3000 端口跑起来了');

// ============ 优雅关闭 ============

let isShuttingDown = false;

function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`收到 ${signal} 信号，正在关闭服务器...`);

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