#!/usr/bin/env python3
"""Render ml/results/SUMMARY.md from the JSON results of real runs (no hand-typed numbers)."""
import json
from pathlib import Path

R = Path(__file__).resolve().parents[1] / "results"


def f(x, n=3):
    return "—" if x is None else f"{x:.{n}f}"


def main() -> None:
    e = json.loads((R / "eval_onnx.json").read_text())
    L, P, N, env = e["labelled"], e["parity"], e["negatives"], e["env"]
    uv_p = R / "ultralytics_val_yolo11s-drone-640.json"
    ov_p = R / "split_overlap.json"
    out = ["# Результаты проверок модели (этап 2.1)", "",
           "_Сгенерировано `ml/scripts/make_summary.py` из JSON реально выполненных запусков в этой папке._", "",
           f"Среда: Python {env['python']}, onnxruntime {env['onnxruntime']}, torch {env['torch']}, "
           f"ultralytics {env['ultralytics']}, CPU sandbox (2 vCPU). ONNX SHA-256 `{env['onnx_sha256']}`.", "",
           "## 1. Labelled test (pathikg test split) — НЕ независимый набор", "",
           "Набор, вероятно, видела модель при обучении/валидации (см. `ml/MODEL.md` §6). Числа — оптимистичная оценка.", "",
           "| Метрика | Значение |", "|---|---|",
           f"| Изображений / GT-рамок | {L['images']} / {L['gt_boxes']} |",
           f"| conf / NMS IoU / IoU сопоставления | {L['conf']} / {L['iou_nms']} / {L['match_iou']} |",
           f"| TP / FP / FN | {L['tp']} / {L['fp']} / {L['fn']} |",
           f"| Precision | {f(L['precision'])} |", f"| Recall | {f(L['recall'])} |", f"| F1 | {f(L['f1'])} |",
           f"| AP50 (101 точка, conf ≥ 0.001) | {f(L['ap50_101pt'])} |",
           f"| Средний IoU у TP | {f(L['mean_iou_tp'])} |",
           f"| Изображений без предсказаний (conf 0.25) | {L['images_without_predictions']} |",
           f"| Задержка ONNX Runtime CPU sandbox, мс (mean / p50) | {f(L['onnx_latency_ms_cpu_sandbox']['mean'],1)} / "
           f"{f(L['onnx_latency_ms_cpu_sandbox']['p50'],1)} — не телефон |", "",
           "Recall по размеру GT (√площади, px исходного кадра 640×480):", "",
           "| Размер | GT | Recall |", "|---|---|---|"]
    out += [f"| {k} | {v['n_gt']} | {f(v['recall'])} |" for k, v in L["recall_by_gt_size_sqrt_area"].items()]
    if uv_p.exists():
        u = json.loads(uv_p.read_text())
        out += ["", "Перекрёстная проверка валидатором Ultralytics (ONNX, тот же набор; P/R — при conf, максимизирующем F1):", "",
                "| P | R | mAP50 | mAP50-95 |", "|---|---|---|---|",
                f"| {f(u['metrics/precision(B)'])} | {f(u['metrics/recall(B)'])} | {f(u['metrics/mAP50(B)'])} | "
                f"{f(u['metrics/mAP50-95(B)'])} |"]
    neg_sw = N.get("threshold_sweep_images_with_detections", {})
    nh, nr = N["hard"]["images"], N["random"]["images"]
    out += ["", "## 2. Развёртка порога (labelled test и негативы COCO)", "",
            f"Негативы: COCO val2017, {nh} «сложных» (есть bird/airplane/kite) + {nr} случайных без этих классов; "
            "класса drone в COCO нет, отсутствие дронов предполагается (ложные срабатывания просмотрены выборочно вручную).", "",
            "| conf > | Precision | Recall | Негативы hard: изобр. с детекцией | Негативы random: изобр. с детекцией |",
            "|---|---|---|---|---|"]
    for t, v in L.get("threshold_sweep", {}).items():
        ns = neg_sw.get(t, {})
        out.append(f"| {t} | {f(v['precision'])} | {f(v['recall'])} | {ns.get('hard','—')}/{nh} | {ns.get('random','—')}/{nr} |")
    rt, ub = P["raw_tensor_pt_fp32_vs_onnx"], P["ultralytics_pt_predict_vs_onnx_pipeline"]
    out += ["", f"## 3. Паритет (первые {P['images']} изображений test)", "",
            "| Проверка | Результат |", "|---|---|",
            f"| Сырой выход PyTorch FP32 vs ONNX Runtime, тот же вход: max \\|Δ\\| координат, px | {rt['max_abs_diff_box_px']:.2e} |",
            f"| то же, max \\|Δ\\| score | {rt['max_abs_diff_score']:.2e} |",
            f"| `YOLO('best.pt').predict` vs наш ONNX-пайплайн: рамок ref / onnx / совпало (IoU>0.9) | "
            f"{ub['ref_boxes']} / {ub['onnx_boxes']} / {ub['matched_iou_gt_0.9']} |",
            f"| то же, max \\|Δ\\| координат, px / score | {ub['max_abs_coord_diff_px']:.2e} / {ub['max_abs_score_diff']:.2e} |"]
    if ov_p.exists():
        o = json.loads(ov_p.read_text())
        out += ["", "## 4. Пересечение train ↔ test датасета", "",
                f"- train {o['train_images']}, test {o['test_images']}; совпадающих имён: {o['test_names_also_in_train']}, "
                f"побайтовых дублей: {o['test_exact_byte_duplicates_in_train']}.",
                f"- Почти дубликаты (dHash, Хэмминг ≤ {o['test_near_duplicates_dhash']['max_hamming']}): "
                f"{o['test_near_duplicates_dhash']['count']} ({100*o['test_near_duplicates_dhash']['fraction']:.1f} %)."]
    out += ["", "## 5. Выводы", "",
            "- Модель воспроизводимо получается, экспортируется и даёт реальные рамки; ONNX численно эквивалентен PyTorch.",
            "- Ложные срабатывания на сценах без дронов частые; ни один порог их не исключает. "
            "Отсутствие false positives не обещается.",
            "- Метрики на pathikg test не характеризуют работу в поле: нужен независимый набор с нашей камеры.", ""]
    (R / "SUMMARY.md").write_text("\n".join(out))
    print("\n".join(out))


if __name__ == "__main__":
    main()
