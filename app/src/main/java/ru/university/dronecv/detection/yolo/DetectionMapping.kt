package ru.university.dronecv.detection.yolo

import ru.university.dronecv.detection.Detection
import ru.university.dronecv.detection.NormalizedBox

/** Пиксельное обнаружение -> нормализованное (относительно изображения [width] x [height]). */
fun YoloDetection.toDetection(width: Int, height: Int): Detection {
    val l = (box.left / width).coerceIn(0f, 1f)
    val t = (box.top / height).coerceIn(0f, 1f)
    val r = (box.right / width).coerceIn(l, 1f)
    val b = (box.bottom / height).coerceIn(t, 1f)
    return Detection(label = label, confidence = confidence, box = NormalizedBox(l, t, r, b), classId = classId)
}
