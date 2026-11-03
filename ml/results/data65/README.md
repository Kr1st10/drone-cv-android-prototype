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
