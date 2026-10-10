"""
单张图片的 YOLO 检测脚本（命令行版）。

用法：
    py detect.py <图片路径> [输出目录]

输出：一行 JSON，方便被别的程序（比如 server.js）直接解析。
    成功 -> {"detections":[{"class":"person","confidence":0.91,"bbox":[...]}], ...}
    失败 -> {"error":"原因"}

说明：
    这个脚本每次运行都要重新加载模型，适合手动测试或偶尔跑一次。
    聊天室里那种「发图就要马上出结果」的场景用的是 yolo_worker.py，
    它是常驻进程，模型只加载一次。

模型路径可以通过环境变量 YOLO_MODEL 指定；不指定就用
train/runs/detect/train-2/weights/best.pt（相对本文件，不写死绝对路径）。
"""

import os
import sys
import json

# Windows 下 out 的编码问题：统一成 UTF-8，避免中文报错乱码
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def resolve_default_model():
    """找一个能用的权重文件，按优先级依次尝试（和 yolo_worker.py 保持一致）。"""
    a = os.path.dirname(os.path.abspath(__file__))
    b = os.path.dirname(a)
    rel = os.path.join("runs", "detect", "train-2", "weights", "best.pt")

    candidates = [
        # 训练作业作为同级目录叫 train/（整合后的仓库布局）
        os.path.join(b, "train", rel),
        os.path.join(a, "train", rel),
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

    return candidates[0]


MODEL_PATH = os.environ.get("YOLO_MODEL") or resolve_default_model()
CONF = float(os.environ.get("YOLO_CONF", "0.25"))
IMGSZ = int(os.environ.get("YOLO_IMGSZ", "640"))


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "用法: py detect.py <图片路径> [输出目录]"}, ensure_ascii=False))
        return 1

    image_path = sys.argv[1]
    save_dir = sys.argv[2] if len(sys.argv) > 2 else None

    if not os.path.isfile(image_path):
        print(json.dumps({"error": "图片不存在：%s" % image_path}, ensure_ascii=False))
        return 1

    if not os.path.isfile(MODEL_PATH):
        print(json.dumps({"error": "找不到模型权重：%s" % MODEL_PATH}, ensure_ascii=False))
        return 1

    try:
        from ultralytics import YOLO

        if save_dir:
            os.makedirs(save_dir, exist_ok=True)

        model = YOLO(MODEL_PATH)
        results = model.predict(
            source=image_path,
            conf=CONF,
            imgsz=IMGSZ,
            verbose=False,
            save=bool(save_dir),
            project=save_dir,
            name="",
            exist_ok=True,
        )

        detections = []
        annotated = None
        width = height = None
        speed = {}

        for r in results:
            if r.speed:
                speed = r.speed

            shape = getattr(r, "orig_shape", None)
            if shape and len(shape) >= 2:
                height, width = int(shape[0]), int(shape[1])

            names = r.names
            if r.boxes is not None:
                for box in r.boxes:
                    cls_id = int(box.cls[0])
                    label = names.get(cls_id, str(cls_id)) if isinstance(names, dict) else names[cls_id]
                    detections.append({
                        "class": label,
                        "confidence": round(float(box.conf[0]), 3),
                        "bbox": [round(float(v), 1) for v in box.xyxy[0].tolist()],
                    })

            save_path = getattr(r, "save_dir", None)
            if save_dir and save_path:
                candidate = os.path.join(str(save_path), os.path.splitext(os.path.basename(image_path))[0] + ".jpg")
                if os.path.isfile(candidate):
                    # 带上 predict/ 之类的子目录，调用方才能找到文件
                    annotated = os.path.relpath(candidate, save_dir).replace("\\", "/")

        detections.sort(key=lambda d: d["confidence"], reverse=True)

        print(json.dumps({
            "detections": detections,
            "annotated": annotated,
            "width": width,
            "height": height,
            "inference_ms": round(float(speed.get("inference", 0.0)), 1),
        }, ensure_ascii=False))
        return 0

    except Exception as exc:
        print(json.dumps({"error": "%s: %s" % (type(exc).__name__, exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
