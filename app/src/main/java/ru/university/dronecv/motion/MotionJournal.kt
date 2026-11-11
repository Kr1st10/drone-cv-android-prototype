package ru.university.dronecv.motion

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import ru.university.dronecv.camera.CaptureTimebase
import ru.university.dronecv.camera.FrameStamp
import ru.university.dronecv.detection.Detection
import ru.university.dronecv.detection.NormalizedBox

/** Bounded, session-tokened journal. Calls may arrive from UI, vision and ML workers. */
class MotionJournal(private val clock: () -> Long, private val limit: Int = 20_000) {
    data class Ui(val mode: String = "yolo_lk", val recording: Boolean = false, val report: String? = null)
    private val mutableUi = MutableStateFlow(Ui())
    val ui = mutableUi.asStateFlow()
    private var epoch = 0L
    private var start = 0L
    private var geometry: Pair<Int, Int>? = null
    private var image: String? = null
    private val frames = mutableListOf<String>()
    private val detections = mutableListOf<String>()
    private val publications = mutableListOf<String>()
    private var truncated = false

    @Synchronized fun mode(mode: String): Boolean {
        require(mode in setOf("yolo", "yolo_lk"))
        if (mutableUi.value.recording) return false
        mutableUi.value = mutableUi.value.copy(mode = mode)
        return true
    }
    @Synchronized fun start() {
        if (mutableUi.value.recording) return
        epoch++; start = clock(); geometry = null; image = null
        frames.clear(); detections.clear(); publications.clear(); truncated = false
        mutableUi.value = mutableUi.value.copy(recording = true, report = null)
    }
    @Synchronized fun token(): Long? = epoch.takeIf { mutableUi.value.recording }
    @Synchronized fun needsImage(token: Long): Boolean = valid(token) && image == null
    @Synchronized internal fun frame(token: Long, stamp: FrameStamp, width: Int, height: Int, marker: MotionMarker?, calibration: String?): Long? {
        if (!valid(token)) return null
        if (geometry != null && geometry != (width to height)) { stop("Geometry changed"); return null }
        geometry = width to height
        if (image == null && marker != null && calibration != null) image = calibration
        if (frames.size >= limit) { truncated = true; return null }
        val id = frames.size.toLong() + 1
        val capture = if (stamp.timebase == CaptureTimebase.ELAPSED_REALTIME && stamp.captureNs != null && stamp.captureNs > 0 && stamp.captureNs <= stamp.analyzerEntryNs) stamp.captureNs - start else null
        val m = marker?.let { "{\"run_id\":\"${it.runId}\",\"step_id\":${it.stepId}}" } ?: "null"
        frames += "{\"frame_id\":$id,\"analyzer_ns\":${stamp.analyzerEntryNs - start},\"capture_ns\":$capture,\"marker\":$m}"
        return id
    }
    @Synchronized fun detection(token: Long?, frame: Long?, value: Detection, now: Long) {
        if (token == null || frame == null || !valid(token)) return
        add(detections, "{\"frame_id\":$frame,\"published_ns\":${now-start},\"bbox\":${box(value.box)},\"confidence\":${value.confidence}}")
    }
    @Synchronized fun publication(token: Long?, frame: Long?, value: NormalizedBox?, source: String, now: Long) {
        if (token == null || !valid(token)) return
        add(publications, "{\"frame_id\":$frame,\"published_ns\":${now-start},\"bbox\":${value?.let(::box) ?: "null"},\"source\":\"$source\"}")
    }
    @Synchronized fun stop(reason: String? = null) {
        if (!mutableUi.value.recording) return
        val now = clock()
        val g = geometry?.let { "{\"width\":${it.first},\"height\":${it.second}}" } ?: "null"
        val cal = image?.let { "{\"width\":${geometry!!.first},\"height\":${geometry!!.second},\"data_url\":\"$it\"}" } ?: "null"
        val safeReason = reason?.let(::escapeJson)
        val report = "{\"schema\":\"dronecv-motion-android-1\",\"mode\":\"${mutableUi.value.mode}\",\"complete\":${reason == null && !truncated},\"abort_reason\":${safeReason?.let { "\"$it\"" } ?: "null"},\"truncated\":$truncated,\"stop_ns\":${now-start},\"geometry\":$g,\"calibration_image\":$cal,\"frames\":[${frames.joinToString()}],\"detections\":[${detections.joinToString()}],\"publications\":[${publications.joinToString()}]}"
        epoch++
        mutableUi.value = mutableUi.value.copy(recording = false, report = report)
    }
    private fun valid(token: Long) = mutableUi.value.recording && token == epoch
    private fun add(list: MutableList<String>, item: String) { if (list.size < limit) list += item else truncated = true }
    private fun escapeJson(value: String): String = buildString {
        value.forEach { char ->
            when {
                char == '"' -> append("\\\"")
                char == '\\' -> append("\\\\")
                char.code < 0x20 -> append("\\u").append(char.code.toString(16).padStart(4, '0'))
                else -> append(char)
            }
        }
    }
    private fun box(b: NormalizedBox) = "[${b.left},${b.top},${b.right},${b.bottom}]"
}
