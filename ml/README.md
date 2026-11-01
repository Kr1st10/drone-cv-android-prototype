# ml/ — модельная основа (этап 2.1)

Воспроизводимый конвейер: оригинальные веса → проверка SHA-256 → ONNX → инференс ONNX Runtime → проверка.
Документация модели и тензоров — [`MODEL.md`](MODEL.md). Результаты проверок — [`results/SUMMARY.md`](results/SUMMARY.md).

Веса и датасеты **не хранятся в репозитории** (лицензия весов не выяснена, размер); всё скачивается скриптами
в `ml/weights/` и `ml/data/` (git-ignored).

## Структура
| Файл | Назначение |
|---|---|
| `model_manifest.json` | источник весов (URL, ревизия HF, SHA-256, лицензия) и параметры экспорта |
| `scripts/fetch_and_export.py` | скачивание `best.pt`, проверка SHA-256, экспорт ONNX, `weights/export_info.json` |
| `scripts/drone_detector.py` | эталонный инференс: letterbox → ONNX Runtime → декодирование → NMS → координаты исходного кадра; CLI |
| `scripts/prepare_eval_data.py` | test-сплит `pathikg/drone-detection-dataset` в формате YOLO + 200 негативов COCO val2017 |
| `scripts/evaluate.py` | P/R/F1/AP50, recall по размеру, паритет PyTorch↔ONNX, негативы, развёртка порога |
| `scripts/ultralytics_val.py` | перекрёстная проверка метрик валидатором Ultralytics |
| `scripts/check_split_overlap.py` | пересечение train↔test датасета (имена, байты, dHash) |
| `tests/test_postprocess.py` | unit-тесты пред/постобработки (без модели) |
| `results/` | JSON/логи реально выполненных запусков |

## Воспроизведение (Linux/macOS, Python 3.13, CPU)
```bash
python3 -m venv .venv && . .venv/bin/activate
pip install torch==2.6.0 torchvision==0.21.0 --index-url https://download.pytorch.org/whl/cpu
pip install -r ml/requirements.txt
# Linux без графики (сервер/CI/WSL): ultralytics тянет opencv-python, которому нужен libGL.
pip uninstall -y opencv-python && pip install --force-reinstall --no-deps opencv-python-headless==5.0.0.93

python ml/scripts/fetch_and_export.py          # ~1 мин: best.pt (SHA-256 проверяется) -> ONNX
python -m pytest ml/tests -q                    # unit-тесты постобработки
python ml/scripts/drone_detector.py some.jpg --save-dir /tmp/vis   # инференс на своём изображении

python ml/scripts/prepare_eval_data.py          # ~290 МБ test-сплит + 200 изображений COCO + аннотации COCO (~250 МБ)
python ml/scripts/evaluate.py                   # ~15 мин на 2 ядрах CPU -> ml/results/eval_onnx.json
python ml/scripts/ultralytics_val.py            # опционально, перекрёстная проверка метрик
python ml/scripts/check_split_overlap.py        # опционально, скачивает train-сплит ~4.4 ГБ
```
Проверено 2026-11-01 в чистом venv по этой инструкции: SHA-256 `best.pt` и ONNX совпали, 8 unit-тестов
прошли, детекция на `00000.jpg` идентична (лог `results/clean_env_reproduction.log`).

Ожидаемое: SHA-256 ONNX `b4867481…f19eb7` при версиях из requirements (при других версиях хеш может
отличаться — корректность проверяется паритетом в `evaluate.py`), выход `output0 [1,5,8400]`.
