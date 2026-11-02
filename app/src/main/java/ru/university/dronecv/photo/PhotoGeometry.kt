package ru.university.dronecv.photo

import kotlin.math.min
import kotlin.math.roundToInt
import ru.university.dronecv.detection.NormalizedBox

/** Image rectangle for a centred ContentScale.Fit viewport, in screen pixels. */
class PhotoViewport private constructor(
    val left: Float,
    val top: Float,
    val width: Float,
    val height: Float,
) {
    /** Uses exactly the same rectangle as the image, including the letterboxed screen margins. */
    fun map(box: NormalizedBox): PhotoScreenBox = PhotoScreenBox(
        left + box.left * width,
        top + box.top * height,
        left + box.right * width,
        top + box.bottom * height,
    )

    companion object {
        fun fit(imageWidth: Int, imageHeight: Int, viewWidth: Float, viewHeight: Float): PhotoViewport {
            require(imageWidth > 0 && imageHeight > 0) { "Image size must be positive" }
            require(viewWidth.isFinite() && viewHeight.isFinite() && viewWidth > 0f && viewHeight > 0f) {
                "Viewport size must be finite and positive"
            }
            val scale = min(viewWidth.toDouble() / imageWidth, viewHeight.toDouble() / imageHeight)
            val width = (imageWidth * scale).toFloat()
            val height = (imageHeight * scale).toFloat()
            return PhotoViewport((viewWidth - width) / 2f, (viewHeight - height) / 2f, width, height)
        }
    }
}

data class PhotoScreenBox(val left: Float, val top: Float, val right: Float, val bottom: Float)

/** Bounded decode dimensions: no full-resolution allocation is needed for a large source photo. */
data class PhotoDecodeSize(val width: Int, val height: Int) {
    companion object {
        fun fit(width: Int, height: Int, maxSide: Int = 2048): PhotoDecodeSize {
            require(width > 0 && height > 0 && maxSide > 0) { "Decode sizes must be positive" }
            val scale = min(1.0, maxSide.toDouble() / maxOf(width, height))
            return PhotoDecodeSize(
                (width * scale).roundToInt().coerceIn(1, maxSide),
                (height * scale).roundToInt().coerceIn(1, maxSide),
            )
        }

        /**
         * BitmapFactory rounds sampled dimensions up on some formats. Account for that rounding so
         * even odd source sizes are bounded. A Long intermediate avoids overflow on large headers.
         */
        fun sampleSize(width: Int, height: Int, maxSide: Int = 2048): Int {
            require(width > 0 && height > 0 && maxSide > 0) { "Decode sizes must be positive" }
            val largest = maxOf(width, height).toLong()
            var sample = 1L
            while ((largest + sample - 1L) / sample > maxSide) {
                sample *= 2L
                require(sample <= Int.MAX_VALUE) { "Required sample size exceeds BitmapFactory limits" }
            }
            return sample.toInt()
        }
    }
}
