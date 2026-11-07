package ru.university.dronecv.tracking

import ru.university.dronecv.detection.NormalizedBox
import kotlin.math.max
import kotlin.math.min

data class TrackBox(val left: Double, val top: Double, val right: Double, val bottom: Double) {
    init {
        require(listOf(left, top, right, bottom).all { it.isFinite() })
        require(left >= 0 && top >= 0 && right > left && bottom > top)
    }
    val width: Double get() = right - left
    val height: Double get() = bottom - top
    val centerX: Double get() = (left + right) * .5
    val centerY: Double get() = (top + bottom) * .5
    fun fits(frame: GrayFrame): Boolean = right <= frame.width && bottom <= frame.height
    fun translated(dx: Double, dy: Double, width: Int, height: Int): TrackBox? {
        if (!dx.isFinite() || !dy.isFinite() || left + dx < 0 || top + dy < 0 ||
            right + dx > width || bottom + dy > height) return null
        return TrackBox(left + dx, top + dy, right + dx, bottom + dy)
    }
    fun iou(other: TrackBox): Double {
        val intersection = max(0.0, min(right, other.right) - max(left, other.left)) *
            max(0.0, min(bottom, other.bottom) - max(top, other.top))
        return intersection / (width * height + other.width * other.height - intersection)
    }
    companion object {
        fun from(box: NormalizedBox, width: Int, height: Int): TrackBox? =
            if (box.left == box.right || box.top == box.bottom) null else
                TrackBox(box.left.toDouble() * width, box.top.toDouble() * height,
                    box.right.toDouble() * width, box.bottom.toDouble() * height)
    }
}

/** Flow consistency and appearance agreement; none of these values is a class probability. */
data class TrackQuality(val points: Int, val initialPoints: Int, val medianFbErrorPx: Double, val correlation: Double) {
    init {
        require(points in 1..initialPoints)
        require(medianFbErrorPx.isFinite() && medianFbErrorPx >= 0)
        require(correlation.isFinite() && correlation in -1.0..1.0)
    }
    val retainedFraction: Double get() = points.toDouble() / initialPoints
}

data class TrackEstimate(val box: TrackBox, val quality: TrackQuality)

/** One instance, one owner thread. Null means lost/untrackable; it must clear the previous position. */
interface VisualTracker : AutoCloseable {
    fun initialize(frame: GrayFrame, box: TrackBox): TrackEstimate?
    fun update(frame: GrayFrame): TrackEstimate?
    override fun close()
}
