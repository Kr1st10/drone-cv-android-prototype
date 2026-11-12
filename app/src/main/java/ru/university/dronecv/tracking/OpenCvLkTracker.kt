package ru.university.dronecv.tracking

import org.opencv.android.OpenCVLoader
import org.opencv.core.CvType
import org.opencv.core.Mat
import org.opencv.core.MatOfByte
import org.opencv.core.MatOfFloat
import org.opencv.core.MatOfPoint
import org.opencv.core.MatOfPoint2f
import org.opencv.core.Point
import org.opencv.core.Scalar
import org.opencv.core.Size
import org.opencv.core.TermCriteria
import org.opencv.imgproc.Imgproc
import org.opencv.video.Video
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

object LkParameters {
    const val MAX_POINTS = 32
    const val CORNER_QUALITY = .02
    const val CORNER_DISTANCE = 2.0
    const val WINDOW = 15.0
    const val PYRAMID_LEVELS = 2
    const val ITERATIONS = 20
    const val EPSILON = .03
    const val FORWARD_BACK_ERROR = 1.0
    const val INLIER_DISTANCE = 1.5
    const val RETAINED_FRACTION = .5
    const val MIN_CORRELATION = .6
    const val MIN_POINTS = 4
}

/** Translation-only LK prototype. Native state is confined to its owner; never invoke on the UI thread. */
class OpenCvLkTracker : VisualTracker {
    private var previous: Mat? = null
    private var points = emptyList<Point>()
    private var initialPoints = 0
    private var box: TrackBox? = null
    private var frame: GrayFrame? = null
    private var template: DoubleArray? = null

    init { check(OpenCVLoader.initLocal()) { "Cannot load packaged OpenCV" } }

    override fun initialize(frame: GrayFrame, box: TrackBox): TrackEstimate? {
        close()
        if (!box.fits(frame) || box.width < 8 || box.height < 8) return null
        val patch = patch(frame, box) ?: return null
        val mats = NativeMats()
        try {
            val image = mats.own(mat(frame))
            val mask = mats.own(Mat.zeros(frame.height, frame.width, CvType.CV_8UC1))
            val corners = mats.own(MatOfPoint())
            // Features outside the detector's box would track the background instead of the candidate.
            val roi = mask.submat(ceil(box.top + 1).toInt(), floor(box.bottom - 1).toInt(),
                ceil(box.left + 1).toInt(), floor(box.right - 1).toInt())
            try { roi.setTo(Scalar(255.0)) } finally { roi.release() }
            Imgproc.goodFeaturesToTrack(image, corners, LkParameters.MAX_POINTS, LkParameters.CORNER_QUALITY, LkParameters.CORNER_DISTANCE, mask, 3)
            val found = corners.toList()
            if (found.size < LkParameters.MIN_POINTS) return null
            previous = mats.take(image)
            points = found
            initialPoints = found.size
            this.box = box
            this.frame = frame
            template = patch
            return TrackEstimate(box, TrackQuality(found.size, found.size, 0.0, 1.0))
        } catch (e: Exception) {
            close()
            throw e
        } catch (e: OutOfMemoryError) {
            close()
            throw e
        } finally {
            mats.close()
        }
    }

    override fun update(frame: GrayFrame): TrackEstimate? {
        val oldFrame = this.frame ?: return null
        val oldBox = box ?: return null
        if (frame.key.generation != oldFrame.key.generation || frame.key.source != oldFrame.key.source ||
            frame.key.sequence <= oldFrame.key.sequence || !frame.sameGeometry(oldFrame) ||
            invalidGap(oldFrame, frame) ||
            frame.stamp.ageAt(frame.stamp.analyzerEntryNs)?.let { it > MAX_FRAME_AGE_MS } == true) {
            close(); return null
        }
        val mats = NativeMats()
        try {
            val image = mats.own(mat(frame))
            val old = mats.own(MatOfPoint2f(*points.toTypedArray()))
            val next = mats.own(MatOfPoint2f())
            val back = mats.own(MatOfPoint2f())
            val forwardStatus = mats.own(MatOfByte())
            val backwardStatus = mats.own(MatOfByte())
            val forwardError = mats.own(MatOfFloat())
            val backwardError = mats.own(MatOfFloat())
            val window = Size(LkParameters.WINDOW, LkParameters.WINDOW)
            val criteria = TermCriteria(TermCriteria.COUNT or TermCriteria.EPS, LkParameters.ITERATIONS, LkParameters.EPSILON)
            Video.calcOpticalFlowPyrLK(checkNotNull(previous), image, old, next, forwardStatus,
                forwardError, window, LkParameters.PYRAMID_LEVELS, criteria)
            Video.calcOpticalFlowPyrLK(image, checkNotNull(previous), next, back, backwardStatus,
                backwardError, window, LkParameters.PYRAMID_LEVELS, criteria)
            val candidates = next.toList()
            val returned = back.toList()
            val ok = forwardStatus.toArray()
            val backOk = backwardStatus.toArray()
            val errors = points.indices.map { i -> hypot(points[i].x - returned[i].x, points[i].y - returned[i].y) }
            val valid = points.indices.filter { i ->
                ok[i].toInt() != 0 && backOk[i].toInt() != 0 && errors[i].isFinite() && errors[i] <= LkParameters.FORWARD_BACK_ERROR &&
                    candidates[i].x in 0.0..(frame.width - 1).toDouble() &&
                    candidates[i].y in 0.0..(frame.height - 1).toDouble()
            }
            if (valid.size < LkParameters.MIN_POINTS) { close(); return null }
            val dx = median(valid.map { candidates[it].x - points[it].x })
            val dy = median(valid.map { candidates[it].y - points[it].y })
            val inliers = valid.filter { i -> hypot(candidates[i].x - points[i].x - dx,
                candidates[i].y - points[i].y - dy) <= LkParameters.INLIER_DISTANCE }
            if (inliers.size < max(LkParameters.MIN_POINTS, ceil(initialPoints * LkParameters.RETAINED_FRACTION).toInt())) { close(); return null }
            val moved = oldBox.translated(dx, dy, frame.width, frame.height)
            if (moved == null) { close(); return null }
            val patch = patch(frame, moved)
            val correlation = patch?.let { correlation(checkNotNull(template), it) }
            if (correlation == null || correlation < LkParameters.MIN_CORRELATION) { close(); return null }
            val quality = TrackQuality(inliers.size, initialPoints, median(inliers.map { errors[it] }), correlation)
            previous?.release()
            previous = mats.take(image)
            points = inliers.map { candidates[it] }
            box = moved
            this.frame = frame
            return TrackEstimate(moved, quality)
        } catch (e: Exception) {
            close()
            throw e
        } catch (e: OutOfMemoryError) {
            close()
            throw e
        } finally {
            mats.close()
        }
    }

    override fun close() {
        previous?.release()
        previous = null
        points = emptyList()
        initialPoints = 0
        box = null
        frame = null
        template = null
    }

    private fun mat(frame: GrayFrame): Mat {
        val image = Mat(frame.height, frame.width, CvType.CV_8UC1)
        try { image.put(0, 0, frame.copyPixels()); return image }
        catch (e: Throwable) { image.release(); throw e }
    }

    private fun patch(frame: GrayFrame, box: TrackBox): DoubleArray? {
        val w = min(24, floor(box.width).toInt())
        val h = min(24, floor(box.height).toInt())
        if (w < 2 || h < 2) return null
        val samples = DoubleArray(w * h) { i ->
            val x = box.left + ((i % w) + .5) * box.width / w
            val y = box.top + ((i / w) + .5) * box.height / h
            return@DoubleArray frame.sample(x, y)
        }
        val mean = samples.average()
        val norm = sqrt(samples.sumOf { (it - mean) * (it - mean) })
        if (norm / sqrt(samples.size.toDouble()) < 5) return null
        return DoubleArray(samples.size) { (samples[it] - mean) / norm }
    }

    private fun correlation(a: DoubleArray, b: DoubleArray): Double? =
        if (a.size != b.size) null else a.indices.sumOf { a[it] * b[it] }.coerceIn(-1.0, 1.0)

    private fun median(values: List<Double>): Double {
        val sorted = values.sorted()
        return (sorted[(sorted.size - 1) / 2] + sorted[sorted.size / 2]) * .5
    }

    companion object {
    }
}

private class NativeMats : AutoCloseable {
    private val mats = ArrayList<Mat>()
    fun <T : Mat> own(mat: T): T {
        try { mats.add(mat); return mat }
        catch (e: Throwable) { mat.release(); throw e }
    }
    fun <T : Mat> take(mat: T): T = mat.also { check(mats.remove(mat)) }
    override fun close() { while (mats.isNotEmpty()) mats.removeAt(mats.lastIndex).release() }
}
