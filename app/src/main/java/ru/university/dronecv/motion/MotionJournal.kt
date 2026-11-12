package ru.university.dronecv.motion

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import ru.university.dronecv.camera.CaptureTimebase
import ru.university.dronecv.camera.FrameStamp
import ru.university.dronecv.detection.Detection
import ru.university.dronecv.detection.NormalizedBox
import java.io.File
import ru.university.dronecv.journals.JournalArchive
import ru.university.dronecv.timeline.updateForSession
import ru.university.dronecv.timeline.TimelineWriter
import ru.university.dronecv.timeline.quote

/** Bounded, session-tokened journal. Calls may arrive from UI, vision and ML workers. */
class MotionJournal(private val clock: () -> Long, private val limit: Int = 20_000,
                    private val fileFactory: (() -> File)? = null,
                    private val requiresReservation: Boolean = false,
                    private val writerFactory: (File, () -> Long, (String) -> Unit) -> TimelineWriter =
                        { file, time, issue -> TimelineWriter(file, time, onIssue = issue) }) {
    private var writer: TimelineWriter? = null
    private var reservation: JournalArchive.Recording? = null
    private var preparationRevision = 0L
    @Synchronized fun preparationToken(): Long = preparationRevision
    @Synchronized fun prepareRecording(value: JournalArchive.Recording, expectedRevision: Long): Boolean {
        if (preparationRevision != expectedRevision || mutableUi.value.recording || reservation != null) return false
        reservation = value
        return true
    }
    @Synchronized fun cancelPreparation() { reservation = null }
    private var exportWriter: TimelineWriter? = null
    @Synchronized fun exportFile(): File? = writer?.file
    @Synchronized fun selectExport(): File? { exportWriter = writer; return exportWriter?.file }
    fun awaitFinished(file: File) { synchronized(this) { writer?.takeIf { it.file == file } }?.awaitFinished() }
    fun copyExport(file: File, output: java.io.OutputStream) {
        val selected = synchronized(this) { (exportWriter ?: writer)?.takeIf { it.file == file }.also { exportWriter = null } }
        if (selected != null) selected.copyTo(output) else file.inputStream().use { it.copyTo(output) }
    }
    @Synchronized fun event(token: Long?, type: String, payloadJson: String) {
        if (token != null && valid(token)) writer?.record(type, payloadJson)
    }
    data class Ui(val mode: String = "yolo_lk", val recording: Boolean = false, val report: String? = null, val issue: String? = null, val sessionId: Long = 0)
    private val mutableUi = MutableStateFlow(Ui())
    val ui = mutableUi.asStateFlow()
    private var epoch = 0L
    private var start = 0L
    private var fileFrameId = 0L
    private var geometry: Pair<Int, Int>? = null
    private var image: String? = null
    private val frames = mutableListOf<String>()
    private val detections = mutableListOf<String>()
    private val publications = mutableListOf<String>()
    private var truncated = false

    @Synchronized fun mode(mode: String): Boolean {
        require(mode in setOf("yolo", "yolo_lk"))
        if (mutableUi.value.recording) return false
        preparationRevision++
        mutableUi.update { it.copy(mode = mode) }
        return true
    }
    @Synchronized fun start() {
        if (mutableUi.value.recording) return
        val selected = reservation.also { reservation = null }
        if (requiresReservation && selected == null) {
            mutableUi.update { it.copy(issue = "Сначала подготовьте место в архиве журналов") }; return
        }
        if (writer?.isFinished() == false) { mutableUi.update { it.copy(issue = "Ожидание завершения предыдущей записи") }; return }
        epoch++; start = clock(); geometry = null; image = null; fileFrameId = 0
        frames.clear(); detections.clear(); publications.clear(); truncated = false
        val sessionId = epoch
        mutableUi.value = mutableUi.value.copy(recording = true, report = null, issue = null, sessionId = sessionId)
        writer = try {
            val issueCallback: (String) -> Unit = { issue -> mutableUi.updateForSession(sessionId, { it.sessionId }) { it.copy(issue = issue) } }
            selected?.openWriter(clock, issueCallback) ?: fileFactory?.invoke()?.let { file -> writerFactory(file, clock, issueCallback) }
        } catch (e: Exception) {
            mutableUi.value = mutableUi.value.copy(recording = false, issue = "Ошибка создания записи: ${e.message ?: e.javaClass.simpleName}")
            return
        }
        writer?.record("header", "{\"start_ns\":\"$start\",\"mode\":\"${mutableUi.value.mode}\",\"clock\":\"elapsed_realtime_ns\"}", start)
    }
    @Synchronized fun token(): Long? = epoch.takeIf { mutableUi.value.recording }
    @Synchronized fun needsImage(token: Long): Boolean = valid(token) && image == null
    @Synchronized internal fun frame(token: Long, stamp: FrameStamp, width: Int, height: Int, marker: MotionMarker?, calibration: String?): Long? {
        if (!valid(token)) return null
        if (geometry != null && geometry != (width to height)) { stop("Geometry changed"); return null }
        geometry = width to height
        if (image == null && marker != null && calibration != null) {
            image = calibration
            writer?.record("metadata", "{\"geometry\":{\"width\":$width,\"height\":$height},\"calibration_image\":{\"width\":$width,\"height\":$height,\"data_url\":${quote(calibration)}}}")
        }
        if (writer != null) {
            val id = ++fileFrameId
            val capture = stamp.captureNs?.let { "\"$it\"" } ?: "null"
            val m = marker?.let { "{\"run_id\":${quote(it.runId)},\"step_id\":${it.stepId}}" } ?: "null"
            writer?.record("frame", "{\"frame_id\":\"$id\",\"analyzer_entry_ns\":\"${stamp.analyzerEntryNs}\",\"capture_ns\":$capture,\"timebase\":\"${stamp.timebase.name.lowercase()}\",\"width\":$width,\"height\":$height,\"marker\":$m}", stamp.analyzerEntryNs)
            return id
        }
        if (frames.size >= limit) { truncated = true; return null }
        val id = frames.size.toLong() + 1
        val capture = if (stamp.timebase == CaptureTimebase.ELAPSED_REALTIME && stamp.captureNs != null && stamp.captureNs > 0 && stamp.captureNs <= stamp.analyzerEntryNs) stamp.captureNs - start else null
        val m = marker?.let { "{\"run_id\":\"${it.runId}\",\"step_id\":${it.stepId}}" } ?: "null"
        frames += "{\"frame_id\":$id,\"analyzer_ns\":${stamp.analyzerEntryNs - start},\"capture_ns\":$capture,\"marker\":$m}"
        return id
    }
    @Synchronized fun detection(token: Long?, frame: Long?, value: Detection, now: Long) {
        if (token == null || frame == null || !valid(token)) return
        if (writer != null) { writer?.record("detection", "{\"frame_id\":\"$frame\",\"published_ns\":\"$now\",\"bbox\":${box(value.box)},\"confidence\":${value.confidence}}", now); return }
        add(detections, "{\"frame_id\":$frame,\"published_ns\":${now-start},\"bbox\":${box(value.box)},\"confidence\":${value.confidence}}")
    }
    @Synchronized fun publication(token: Long?, frame: Long?, value: NormalizedBox?, source: String, now: Long) {
        if (token == null || !valid(token)) return
        if (writer != null) { writer?.record("publication", "{\"frame_id\":${frame?.let { "\"$it\"" } ?: "null"},\"published_ns\":\"$now\",\"bbox\":${value?.let(::box) ?: "null"},\"source\":${quote(source)}}", now); return }
        add(publications, "{\"frame_id\":$frame,\"published_ns\":${now-start},\"bbox\":${value?.let(::box) ?: "null"},\"source\":\"$source\"}")
    }
    @Synchronized fun stop(reason: String? = null) {
        preparationRevision++
        if (!mutableUi.value.recording) return
        val now = clock()
        if (writer != null) {
            writer?.finish(now, reason != null, reason)
            epoch++
            mutableUi.update { it.copy(recording = false, report = "file") }
            return
        }
        val g = geometry?.let { "{\"width\":${it.first},\"height\":${it.second}}" } ?: "null"
        val cal = image?.let { "{\"width\":${geometry!!.first},\"height\":${geometry!!.second},\"data_url\":\"$it\"}" } ?: "null"
        val safeReason = reason?.let(::escapeJson)
        val report = "{\"schema\":\"dronecv-motion-android-1\",\"mode\":\"${mutableUi.value.mode}\",\"complete\":${reason == null && !truncated},\"abort_reason\":${safeReason?.let { "\"$it\"" } ?: "null"},\"truncated\":$truncated,\"stop_ns\":${now-start},\"geometry\":$g,\"calibration_image\":$cal,\"frames\":[${frames.joinToString()}],\"detections\":[${detections.joinToString()}],\"publications\":[${publications.joinToString()}]}"
        epoch++
        mutableUi.update { it.copy(recording = false, report = report) }
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
