# train —— YOLO 训练作业

用 ultralytics 训练 YOLO 目标检测模型。训练出来的权重会被
[`../chat/`](../chat/) 的聊天室自动加载，实现「发图即自动检测」。

## 环境

```bat
py -m pip install ultralytics
```

验证：

```bat
py -c "import ultralytics; print(ultralytics.__version__)"
```

PyTorch 会作为 ultralytics 的依赖自动装上。
如果有 NVIDIA 显卡并且想要 GPU 训练，建议先按 <https://pytorch.org> 的指引
装好对应 CUDA 版本的 torch，否则会退化成 CPU 训练（慢很多，但能跑）。

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `train.py` | 训练脚本 |
| `predict.py` | 对验证集做批量推理，把画框结果保存到 `runs/detect/predict/` |
| `webcam.py` | 打开摄像头做实时检测（会弹出窗口，按 `q` 退出） |

## 训练步骤

在 `train/` 目录下执行：

```bat
python train.py
```

`train.py` 的内容：

```python
from ultralytics import YOLO

model = YOLO("yolo11n.pt")
results = model.train(data="coco8.yaml", epochs=3, imgsz=640)
```

说明：

- **`yolo11n.pt`** 是官方预训练权重，第一次运行会自动下载（约 5MB）。
  用预训练权重做迁移学习，比从零训练收敛快得多。
- **`coco8.yaml`** 是 ultralytics 内置的一个 8 张图的小数据集配置。
  如果本地 `datasets/coco8/` 不存在，ultralytics 会自动把它下载下来，
  所以不需要手动准备数据。
- **`epochs=3`** 只是为了让流程能快速跑通（大概一两分钟）。
  3 个 epoch 在 8 张图上训练出来的模型精度有限，只能识别少数目标 ——
  要真正能用，应该换成自己的数据集并把 epoch 加大到几十上百。

训练产物会写到 `runs/detect/train/`。
如果这个目录已经存在，ultralytics 会自动改名成 `train-2`、`train-3`……

> **重要：请确认权重落在 `runs/detect/train-2/weights/best.pt`。**
> `predict.py`、`webcam.py` 和聊天室的自动检测都按这个路径找模型。
> 如果你的训练结果是 `train/` 或 `train-3/`，把那些脚本里的路径改一下，
> 或者用环境变量指定（见下）。

## 推理

对验证集图片批量推理并把结果存成图片：

```bat
python predict.py
```

结果在 `runs/detect/predict/`。

摄像头实时检测：

```bat
python webcam.py
```

## 和聊天室的关系

聊天室的 `chat/yolo_worker.py` 按下面的顺序寻找权重：

1. `../train/runs/detect/train-2/weights/best.pt` ← **就是这里**
2. `train/runs/detect/train-2/weights/best.pt`（训练作业被拷进 chat 目录时）
3. `weights/yolo26n.pt`、`yolo11n.pt`（官方预训练权重兜底）

所以只要训练完成、权重在上面第 1 条的位置，聊天室不需要任何配置就能用。

想用别的权重可以设环境变量：

```bat
set YOLO_MODEL=D:\somewhere\best.pt
set YOLO_CONF=0.5
set YOLO_IMGSZ=960
```

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `YOLO_MODEL` | 自动查找 | 权重文件路径 |
| `YOLO_CONF` | `0.25` | 置信度阈值，低于它的检测框会被丢弃 |
| `YOLO_IMGSZ` | `640` | 推理输入尺寸，调大可能更准但更慢 |

## 哪些文件不会被提交

`datasets/`、`runs/`、`weights/`、`*.pt` 都在 `.gitignore` 里，
因为这些是下载来的数据集和可再生的训练产物，体积大且没必要版本化。

所以 `best.pt` **不在仓库里**，克隆下来后需要先跑一次训练才能让聊天室的
自动检测生效。在此之前聊天和发图都正常，只是图片下方会显示「检测失败」。
