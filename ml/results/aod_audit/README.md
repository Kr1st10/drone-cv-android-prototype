# Этап 4.4: воспроизведение

Запуск из корня после установки закреплённых зависимостей `ml/requirements.txt`; веса и фотографии не коммитятся. По [`../independent/README.md`](../independent/README.md) получить проверенный AOD 4 и подготовить изображения через `independent_prepare.py --archive /path/to/AOD4.zip`; веса 640 воспроизвести по `ml/README.md` и `../resolution/README.md` из того же проверенного `best.pt`. SHA-256: архив `fac56b9c0494312bcd4c63dfefcbcd8ed07ab55d4b00584131c0b55273d24518`, ONNX `b4867481a3b3277f7b17e69b7b45077567d6929157e72dd5d48542dd34f19eb7`. Лицензия AOD по карточке CC BY 4.0, но исходные видео могут иметь отдельные права; overlays остаются локальными.

```bash
export OPENBLAS_NUM_THREADS=1
python ml/scripts/independent_prepare.py --archive /path/to/AOD4.zip
python ml/scripts/aod_audit_integrity.py --archive /path/to/AOD4.zip
# Повторить анализ порогов без инференса из сохранённых неокруглённых результатов:
python ml/scripts/aod_audit_thresholds.py --from-shards
# Или повторить инференс на том же наборе и заново записать shards:
python ml/scripts/aod_audit_thresholds.py
# 101 локальный frame_*.jpg и 75 fp_*.jpg в игнорируемой папке visuals/:
python ml/scripts/aod_audit_review.py
python -m pytest ml/tests -q
```

`integrity.json` сверяет аннотации, хеши и сохранённые TP/FP/FN 640; `thresholds.json` и `missed_gt.json` — результаты порогов и ограниченная информация о кандидатах FN; `low_conf_metadata.json` + четыре `low_conf_records_*.json` — все детекции >0.05 после NMS, без изображений, для пересчёта без инференса. `review.json` хранит визуальные замечания, `review_fps.json` все 75 FP с IoU, `review_examples.json` выбранные кадры. В overlay зелёный — drone GT, голубой — GT других классов, жёлтый — TP, красный — FP. Номера `frame_NNN`, `fp_NN` связываются с указанными JSON и манифестом 4.3. Исходные изображения и размеченные JPEG не публикуются. Частоту причин нельзя экстраполировать с ручного просмотра, неоднозначности не заменяют оригинальную разметку.
