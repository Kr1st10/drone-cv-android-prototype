package ru.university.dronecv.detection.yolo

import kotlin.math.min
import kotlin.math.round

/**
 * Геометрия letterbox: изображение `srcWidth x srcHeight` вписывается с сохранением пропорций
 * в квадрат `inputSize x inputSize` и дополняется серыми полями.
 *
 * Округления повторяют `ultralytics.data.augment.LetterBox` и эталон `ml/scripts/drone_detector.py`
 * (Python `round` — банковское округление, поэтому здесь [round] (ties to even)).
 */
data class Letterbox(
    val srcWidth: Int,
    val srcHeight: Int,
    val inputSize: Int,
    /** resized = original * scale. */
    val scale: Float,
    val resizedWidth: Int,
    val resizedHeight: Int,
    /** Левое поле в пикселях входа модели. */
    val padLeft: Int,
    /** Верхнее поле в пикселях входа модели. */
    val padTop: Int,
) {
    /** X во входе модели -> X в исходном изображении (без обрезки). */
    fun toSourceX(inputX: Float): Float = (inputX - padLeft) / scale

    /** Y во входе модели -> Y в исходном изображении (без обрезки). */
    fun toSourceY(inputY: Float): Float = (inputY - padTop) / scale

    companion object {
        fun compute(srcWidth: Int, srcHeight: Int, inputSize: Int): Letterbox {
            require(srcWidth > 0 && srcHeight > 0) { "Invalid image size ${srcWidth}x$srcHeight" }
            require(inputSize > 0) { "Invalid input size $inputSize" }
            val r = min(inputSize.toDouble() / srcHeight, inputSize.toDouble() / srcWidth)
            val newW = round(srcWidth * r).toInt().coerceIn(1, inputSize)
            val newH = round(srcHeight * r).toInt().coerceIn(1, inputSize)
            val dw = (inputSize - newW) / 2.0
            val dh = (inputSize - newH) / 2.0
            return Letterbox(
                srcWidth = srcWidth,
                srcHeight = srcHeight,
                inputSize = inputSize,
                scale = r.toFloat(),
                resizedWidth = newW,
                resizedHeight = newH,
                padLeft = round(dw - 0.1).toInt(),
                padTop = round(dh - 0.1).toInt(),
            )
        }
    }
}
