from ultralytics import YOLO

model = YOLO("runs/detect/train-2/weights/best.pt")
results = model.predict(source="datasets/coco8/images/val", save=True, conf=0.25)
print("结果保存在 runs/detect/predict/")