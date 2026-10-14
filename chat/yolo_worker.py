"""
YOLO 检测常驻进程。

为什么不用「每次检测都起一个新进程」：
    ultralytics 加载权重（约 5.5MB 的 best.pt）到 torch 就绪大约要 2~4 秒，
    如果每张图都重新起进程，用户发一张图就要等好几秒，体验很差。
    所以这里的做法是：进程只起一次，模型只加载一次，
    之后通过 stdin/stdout 按「一行一个 JSON」的方式反复收发请求。

通信协议（每行一个 JSON，UTF-8）：
    启动成功  -> {"type":"ready","model":"...","classes":80}
    启动失败  -> {"type":"fatal","error":"..."}      然后进程退出

    收到请求  -> {"id":1,"cmd":"detect","image":"C:\\...\\a.jpg","save_dir":"...","conf":0.25}
    返回结果  -> {"id":1,"ok":true,"detections":[...],"annotated":"a.jpg","inference_ms":6.1,...}
             或 {"id":1,"ok":false,"error":"..."}

    收到请求  -> {"id":2,"cmd":"ping"}
    返回结果  -> {"id":2,"ok":true,"pong":true}

设计上刻意做到「一个请求出错不影响后续请求」：
    所有异常都在 handle() 里被捕获，转成 {"ok":false} 返回，
    主循环不会因为某张图片损坏、格式不支持而退出。
"""

import os
import sys
import json
import time

# Windows 下 stdout 默认可能是 GBK，中文类别名/错误信息会乱码或抛异常。
# 括号里是标准做法：强制把入出的编码都换成 UTF-8。
for _stream in (sys.stdin, sys.stdout):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        # reconfigure 在极老的 Python 上不存在，忽略即可
        pass


def log(message):
    """日志统一走 stderr：stdout 被协议独占，混进日志会破坏 JSON 行解析。"""
    print("[yolo] " + str(message), file=sys.stderr, flush=True)


def resolve_default_model():
    """找一个能用的权重文件，按优先级依次尝试。

    用 __file__ 推算而不是写死 C:\\Users\\... 绝对路径，
    因为项目换电脑、换目录、传给别人之后，写死的路径立刻失效
    （历史上这份脚本就踩过这个坑）。

    依次尝试（a 是本脚本所在目录，b 是它的上一级目录）：
      1. b/train/...   两个作业并列的布局，即 chat/ 和 train/ 同级
      2. a/train/...   训练作业被拷进聊天室目录里的布局
      3. 官方权重 yolo26n.pt / yolo11n.pt 兜底
    """
    a = os.path.dirname(os.path.abspath(__file__))
    b = os.path.dirname(a)

    rel = os.path.join("runs", "detect", "train", "weights", "best.pt")

    candidates = [
        # 训练作业作为同级目录叫 train/（整合后的仓库布局）
        os.path.join(b, "train", rel),
        os.path.join(a, "train", rel),
        # 用别的名字时也能找到，避免目录一改名就失效
        os.path.join(b, "yolo-train", rel),
        os.path.join(a, "yolo-train", rel),
        # 官方预训练权重兜底
        os.path.join(a, "weights", "yolo26n.pt"),
        os.path.join(b, "train", "weights", "yolo26n.pt"),
        os.path.join(a, "yolo11n.pt"),
        os.path.join(b, "train", "yolo11n.pt"),
    ]

    for path in candidates:
        if os.path.isfile(path):
            return path

    # 一个都没有：返回首选路径，让上层报出「找不到」的具体位置，方便排查
    return candidates[0]


# 允许用环境变量覆盖：YOLO_MODEL=其他权重 YOLO_CONF=0.5 YOLO_IMGSZ=960
MODEL_PATH = os.environ.get("YOLO_MODEL") or resolve_default_model()
CONF_DEFAULT = float(os.environ.get("YOLO_CONF", "0.25"))
IMGSZ = int(os.environ.get("YOLO_IMGSZ", "640"))

# 需要「画框」时用到的字体相关参数，只设置一次
LINE_WIDTH = int(os.environ.get("YOLO_LINE_WIDTH", "2"))


def load_model():
    """加载模型。放在 main() 里调用，方便把异常统一处理成 fatal 消息。"""
    from ultralytics import YOLO  # 延迟导入：让缺依赖的报错也能被我方捕获后回传

    if not os.path.isfile(MODEL_PATH):
        raise FileNotFoundError(
            "找不到模型权重文件：%s\n"
            "请确认 train/ 目录存在，或用环境变量 YOLO_MODEL 指定 .pt 文件。" % MODEL_PATH
        )

    model = YOLO(MODEL_PATH)
    return model


def handle(model, req):
    """处理一条请求，永远返回一个可 JSON 序列化的 dict（不抛异常）。"""
    cmd = req.get("cmd")

    if cmd == "ping":
        # 心跳：用来确认进程还活着
        return {"ok": True, "pong": True}

    if cmd != "detect":
        return {"ok": False, "error": "未知命令：%s" % cmd}

    image_path = req.get("image")
    if not image_path or not os.path.isfile(image_path):
        return {"ok": False, "error": "图片不存在：%s" % image_path}

    save_dir = req.get("save_dir")
    if save_dir:
        os.makedirs(save_dir, exist_ok=True)

    conf = float(req.get("conf", CONF_DEFAULT))
    imgsz = int(req.get("imgsz", IMGSZ))

    # predict 是同步阻塞的；推理只要几毫秒，直接跑在当前进程里即可。
    results = model.predict(
        source=image_path,
        conf=conf,
        imgsz=imgsz,
        verbose=False,
        save=bool(save_dir),      # 顺手把画好框的图保存下来
        project=save_dir,         # 指定保存根目录
        name="",                  # name 传空字符串 -> 直接存在 save_dir 下，不再套一层子目录
        exist_ok=True,
        line_width=LINE_WIDTH,
    )

    detections = []
    speed = {}
    annotated_url = None
    width = height = None

    for r in results:
        if r.speed:
            speed = r.speed

        # 原图尺寸，前端要用来算宽高比、数据库里也留一份
        shape = getattr(r, "orig_shape", None)
        if shape and len(shape) >= 2:
            height, width = int(shape[0]), int(shape[1])

        names = r.names  # 注意用 r.names，兼容模型自带类别表的情况

        if r.boxes is not None:
            for box in r.boxes:
                cls_id = int(box.cls[0])
                detections.append({
                    "class": names.get(cls_id, str(cls_id)) if isinstance(names, dict) else names[cls_id],
                    "confidence": round(float(box.conf[0]), 3),
                    # 坐标保留 1 位小数，减少 JSON 体积
                    "bbox": [round(float(v), 1) for v in box.xyxy[0].tolist()],
                })

        # 标注图：ultralytics 会把画好框的图存到 r.save_dir 下
        save_path = getattr(r, "save_dir", None)
        if save_dir and save_path:
            base = os.path.basename(image_path)
            # 扩展名统一成 .jpg：ultralytics 保存时用的是 jpg 编码
            stem = os.path.splitext(base)[0]
            candidate = os.path.join(str(save_path), stem + ".jpg")
            if os.path.isfile(candidate):
                # 返回「相对于 save_dir」的路径。
                # 注意：即使 name 传空串，ultralytics 仍可能套一层 predict/ 子目录，
                # 所以这里不能只返回文件名，必须把子目录一起带上，
                # 由调用方（Node）负责把它移动到最终想放的位置。
                annotated_url = os.path.relpath(candidate, save_dir).replace("\\", "/")

    # 按置信度从高到低排，前端展示更符合直觉
    detections.sort(key=lambda d: d["confidence"], reverse=True)

    return {
        "ok": True,
        "detections": detections,
        "annotated": annotated_url,
        "width": width,
        "height": height,
        "conf": conf,
        "inference_ms": round(float(speed.get("inference", 0.0)), 1),
        "total_ms": round(float(sum(speed.values())), 1) if speed else None,
    }


def emit(obj):
    """输出一行 JSON 并立刻 flush，保证 Node 侧能及时收到。"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    try:
        model = load_model()
    except Exception as exc:
        # 加载失败属于致命错误：直接把原因告诉 Node，方便在界面上提示用户
        emit({"type": "fatal", "error": "%s: %s" % (type(exc).__name__, exc)})
        return 1

    emit({
        "type": "ready",
        "model": MODEL_PATH,
        "classes": len(model.names),
        "names": model.names if isinstance(model.names, dict) else None,
    })

    # 主循环：按行读请求。readline 返回空串表示 stdin 被关闭（Node 进程退出）
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            req = json.loads(line)
        except Exception as exc:
            log("收到非法 JSON，已忽略：%s" % exc)
            continue

        req_id = req.get("id")

        try:
            result = handle(model, req)
        except Exception as exc:
            # 单张图失败（损坏、格式怪、尺寸异常等）只影响这一条请求
            result = {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}

        result["id"] = req_id
        emit(result)

    return 0


if __name__ == "__main__":
    sys.exit(main())
