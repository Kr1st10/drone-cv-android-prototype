# Stage 6.5 — useful small-drone data (statistics, leak-free splits)

Script: `ml/scripts/data65.py` (`build`, `stats`, `predict`, `evaluate`, `train`, `compare`); tests: `ml/tests/test_data65.py`.
Images, annotations, manifests with local paths and weights are **not** committed. Raw sources, licences and SHA-256: `sources.json`.

## Rules

* Size = √(w·h) of the box **after the 640 letterbox** the model sees (`·640/max(W,H)`); native sizes are in `stats.json`.
* Split units are independence groups, never frames: UAVDB = flight, Anti-UAV300 = recording day, UAV-CB = whole site,
  VDD = whole site, Halmstad negatives = Stage 6.4 groups. Details: `split_summary.json`.
* Sealed and not opened: Stage 6.4 sealed test (Halmstad sealed groups dropped at import, 98 frames; Flying Object unused),
  UAVDB official test cameras (d2c0, d3c4, d4c0, d4c6; not extracted), Anti-UAV300 official test (10 sessions, not decoded).
* Bootstrap units ("scenes"): UAVDB camera, Anti-UAV session, UAV-CB background×part, Halmstad group.
  DUT val and pathikg have no sequence ids: their "scenes" are hash buckets (pseudo-scenes), so their CIs are optimistic.

## Real statistics of the selected data (drone boxes by size at 640)

| Набор / split | Изобр. | С дроном | Без дрона | Рамок | <8 | 8–16 | 16–24 | 24–30 | ≥30 | Групп | Сцен | Сцен с <16 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| antiuav300/train | 1167 | 1119 | 48 | 1119 | 6 | 109 | 433 | 253 | 318 | 1 | 15 | 9 |
| antiuav300/validation | 985 | 919 | 66 | 919 | 1 | 41 | 147 | 229 | 501 | 1 | 12 | 3 |
| dut/eval_only | 600 | 600 | 0 | 600 | 321 | 242 | 23 | 6 | 8 | 1 | 45 | 45 |
| halmstad/train | 1007 | 0 | 924 | 0 | 0 | 0 | 0 | 0 | 0 | 37 | 37 | 0 |
| halmstad/validation | 110 | 0 | 109 | 0 | 0 | 0 | 0 | 0 | 0 | 7 | 7 | 0 |
| halmstad/eval_only | 528 | 0 | 528 | 0 | 0 | 0 | 0 | 0 | 0 | 48 | 48 | 0 |
| pathikg/train | 500 | 500 | 0 | 510 | 8 | 80 | 59 | 47 | 316 | 1 | 228 | 74 |
| pathikg/eval_only | 300 | 300 | 0 | 303 | 7 | 39 | 45 | 29 | 183 | 1 | 181 | 44 |
| uavcb/validation | 3393 | 3393 | 0 | 3393 | 70 | 1012 | 1145 | 377 | 789 | 1 | 10 | 9 |
| uavdb/train | 1300 | 1300 | 0 | 1300 | 562 | 631 | 99 | 4 | 4 | 3 | 13 | 13 |
| uavdb/validation | 400 | 400 | 0 | 400 | 29 | 234 | 132 | 2 | 3 | 1 | 4 | 4 |
| vdd/eval_only | 717 | 717 | 0 | 719 | 0 | 0 | 33 | 75 | 611 | 1 | 1 | 0 |

Not used for training or evaluation: Cranfield synthetic `multi_drone_no_birds_40m_small` — 749 synthetic images,
7050 objects from fragmented masks (<8: 3638, 8–16: 1439, 16–24: 687, 24–30: 318, ≥30: 968).

### What the numbers mean

* Small targets (<16 px at 640) in **real, independently recorded** data: UAVDB train 1193 (13 cameras, 3 flights, one site),
  UAVDB validation 263 (4 cameras, 1 flight, same site), Anti-UAV train 115 / validation 42 (one site), UAV-CB 1082
  (one site, camouflage; partly invisible in RGB), DUT val 563. There is no new *site* with small drones that could be both
  trained and validated: every train source has its validation part at the same site.
* Anti-UAV and UAV-CB boxes are large in native 1920×1080 (≥30 px for 99 %/93 % of boxes) and become small only through the 640 letterbox.
* VDD: one site, almost only ≥30 px, 717 unique of 2145 files — a sensitivity check on another scene, not a small-drone set.

## Leakage checks (`stats.json`)

* Exact byte duplicates across splits: 0 (11007 images, 11006 unique files).
* dHash ≤ 6 + normalised thumbnail MAD ≤ 0.12: 17320 similar train↔held-out pairs, of which 16236 Anti-UAV 25→26 Sep (same
  camera, site, OSD), 370 UAVDB d2–d4→d1 (same static camera position), 678 Halmstad, 23 Halmstad↔pathikg, 13 pathikg.
  Agent visual review of sampled pairs (`visual_review_agent.json`): plain-sky frames and same-site backgrounds, no copied
  frames. Consequence: Anti-UAV and UAVDB validation measure a new day/flight at the same site, not a new site.

## Licences (most restrictive applied)

UAVDB CC BY-NC-SA 4.0 (via CenekAlbl source); UAV-CB CC BY-NC 4.0; Anti-UAV300 no image licence (research only);
VDD Roboflow "Private" (eval only); Halmstad CC0 (YouTube clips eval only); DUT Apache-2.0 per repo, no image licence;
pathikg MIT; Cranfield CC-BY-4.0. Any model trained on UAVDB/Anti-UAV is research-only and non-commercial.

## Baseline vs small controlled fine-tune (`baseline_eval.json`, `candidate_eval.json`, `compare.json`)

Fine-tune (`finetune_config.json`): 1600 train images (UAVDB d2–d4 600, Anti-UAV 25 Sep 400, Halmstad 6.4-train negatives 300,
pathikg replay 300; 1296 drone boxes, 627 of them <16 px at 640), frozen backbone (`freeze=10`), AdamW lr0 1e-4, no warmup,
no mosaic, 2 epochs, final `last.pt` (SHA `e2877070…`, not committed), 0.66 h CPU. Validation/eval sets were never used for
training or checkpoint selection. Values: recall at IoU 0.3, conf 0.25, baseline → candidate, paired scene-bootstrap 95 % CI of Δ.

| Set (role) | GT | Recall@0.3 | Δ CI95 | Response | <16 px recall@0.3 | FP-frame share on drone-free frames |
|---|---|---|---|---|---|---|
| Anti-UAV 26 Sep (same site, next day) | 919 | 0.626 → 0.936 | +0.15…+0.50 | 0.630 → 0.954 | 0/42 → 28/42 | 0.09 → 0.30 (66 frames) |
| UAVDB d1 (same site, other flight) | 400 | 0.995 → 0.998 | 0…+0.01 | 0.998 → 1.000 | 0.992 → 0.996 | — |
| UAV-CB (new site, camouflage) | 3393 | 0.310 → 0.355 | +0.03…+0.08 | 0.329 → 0.408 | 0.316 → 0.380 | — (precision on drone frames 0.57 → 0.36) |
| DUT val (other scenes) | 600 | 0.513 → 0.483 | −0.09…+0.02 | 0.540 → 0.575 | 0.513 → 0.483 | — |
| VDD (other site, 1 scene) | 719 | 0.680 → 0.476 | one site, no CI | 0.707 → 0.490 | — | — |
| pathikg check (forgetting) | 303 | 0.987 → 0.960 | −0.045…−0.010 | 0.987 → 0.964 | 0.957 → 0.826 | — |
| Halmstad validation negatives | — | — | — | — | — | 0.98 → 0.71 (Δ −0.52…−0.13) |
| Halmstad eval_only (YouTube) negatives | — | — | — | — | — | 1.00 → 0.67 (Δ −0.41…−0.26) |

At conf 0.5 the losses grow: DUT 0.458 → 0.327 (Δ −0.21…−0.06), VDD 0.595 → 0.253, pathikg 0.974 → 0.858; UAV-CB gain vanishes.
At conf 0.1 VDD still drops 0.737 → 0.558 (median top score 0.645 → 0.266), so the loss is not only calibration.

**Decision: candidate rejected.** The large gain is on the same site/camera as the training data (Anti-UAV next day); on other
scenes sensitivity drops (VDD, DUT at 0.5, forgetting check), FP on drone-free Anti-UAV frames triples, and the Halmstad FP
reduction comes with lower confidences overall. UAVDB validation is not informative: the baseline already finds 99 % there
(clear sky, high contrast, same cameras' site), including <8 px.

Reproduce (local raw files per `sources.json`):
```
PYTHONPATH=. python ml/scripts/data65.py build --output /data/d65/manifest65.json
PYTHONPATH=. python ml/scripts/data65.py stats --manifest /data/d65/manifest65.json --output ml/results/data65/stats.json
PYTHONPATH=. python ml/scripts/data65.py predict --manifest /data/d65/manifest65.json --weights best.pt --model-id baseline --output baseline.json
PYTHONPATH=. python ml/scripts/data65.py train --manifest /data/d65/manifest65.json --weights best.pt --workdir ft65
PYTHONPATH=. python ml/scripts/data65.py evaluate|compare ...
```
