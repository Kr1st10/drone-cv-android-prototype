package ru.university.dronecv.diagnostics

import ru.university.dronecv.camera.FrameStamp
import ru.university.dronecv.camera.TrackingSampleKind
import ru.university.dronecv.camera.TrackingSignal
import ru.university.dronecv.camera.toJson
import ru.university.dronecv.timeline.TimelineWriter

/** Resource samples use the same monotonic origin as frame offsets. Battery temperature is not CPU temperature. */
data class ResourceSample(val offsetNanos: Long, val pssKb: Long?, val thermalStatus: Int?,
                          val batteryPercent: Int?, val batteryStatus: Int?, val batteryTemperatureC: Double?)

data class DiagnosticReport(val startEpochMs: Long, val device: String, val androidRelease: String,
                            val sdk: Int, val appVersion: String, val modelAsset: String, val modelSha256: String, val confidence: Float,
                            val frames: DiagnosticFrameSnapshot, val resources: List<ResourceSample>,
                            val intraOpThreads: Int = 2, val buildType: String = "unknown",
                            val warmupCompletedFrames: Long = 0) {
    init { require(intraOpThreads in setOf(1, 2, 4) && warmupCompletedFrames >= 0) }
}

/** Persist this session's immutable snapshot before the footer; serialization never runs on the UI. */
fun TimelineWriter.finishDiagnostic(report: DiagnosticReport, stopNs: Long) =
    finish(stopNs, report.frames.interrupted, report.frames.reason, "diagnostic_report" to report::toJson)

private fun q(s: String): String = buildString {
    append('"')
    for (c in s) when (c) {
        '"' -> append("\\\""); '\\' -> append("\\\\"); '\n' -> append("\\n"); '\r' -> append("\\r"); '\t' -> append("\\t")
        else -> if (c.code < 32) append("\\u%04x".format(c.code)) else append(c)
    }
    append('"')
}
private fun num(value: Number?): String = value?.toString() ?: "null"
private fun summary(values: List<Double>): String {
    val s = durationSummary(values) ?: return "null"
    return "{\"count\":${s.count},\"mean\":${s.mean},\"median\":${s.median},\"p50\":${s.median},\"p95_nearest_rank\":${s.p95},\"min\":${s.min},\"max\":${s.max}}"
}

/** Build only on a background thread: the report can contain thousands of frame samples. */
fun DiagnosticReport.toJson(): String = buildString {
    val f = frames
    append("{\"schema_version\":1,\"started_epoch_ms\":$startEpochMs,\"device\":${q(device)},\"android_release\":${q(androidRelease)},\"android_sdk\":$sdk,\"app_version\":${q(appVersion)},")
    append("\"build_type\":${q(buildType)},\"warmup\":{\"method\":\"manual\",\"completed_frames_before_session\":$warmupCompletedFrames},")
    append("\"model\":{\"name\":\"YOLO11s\",\"asset\":${q(modelAsset)},\"sha256\":${q(modelSha256)},\"input_width\":640,\"input_height\":640,\"backend\":\"ONNX Runtime CPU, intra-op $intraOpThreads, inter-op 1\",\"intra_op_threads\":$intraOpThreads,\"inter_op_threads\":1,\"execution_mode\":\"SEQUENTIAL\",\"execution_provider\":\"CPU\",\"confidence\":$confidence,\"nms_iou\":0.7},")
    append("\"duration_ms\":${f.durationNanos / 1_000_000.0},\"interrupted\":${f.interrupted},\"reason\":${f.reason?.let(::q) ?: "null"},")
    append("\"analyzer_callbacks_accepted\":${f.analyzerCallbacks},\"completed_frames\":${f.completedFrames},\"unstored_frames\":${f.unstoredFrames},\"processed_fps_session\":${num(f.processedFps)},")
    append("\"accepted_callbacks_not_completed\":${f.analyzerCallbacks - f.completedFrames},\"camera_frames_dropped\":null,\"frame_to_display_latency_ms\":null,")
    append("\"application_stale_frames_discarded\":${f.staleFramesDiscarded},\"target_signal_schema_version\":2,")
    val input = f.cameraInput
    val inputFps = if (f.durationNanos > 0) input.received * 1_000_000_000.0 / f.durationNanos else null
    append("\"camera_input\":{\"received_frames\":${input.received},\"copied_frames\":${input.copied},\"superseded_frames\":${input.superseded},")
    append("\"no_buffer_frames\":${input.noBuffer},\"stale_frames\":${input.stale},\"invalidated_frames\":${input.invalidated},\"copy_errors\":${input.errors},")
    append("\"copy_mean_ms\":${num(input.copyMeanMs)},\"copy_max_ms\":${if (input.copied > 0) input.copyMaxMs else "null"},\"fps_session\":${num(inputFps)}},")
    append("\"timing_summary_ms\":{")
    append("\"conversion\":${summary(f.frames.map { it.conversionMs })},\"preprocessing\":${summary(f.frames.map { it.preprocessMs })},")
    append("\"ort_including_tensor_copy\":${summary(f.frames.map { it.inferenceMs })},\"postprocessing_nms\":${summary(f.frames.map { it.postprocessMs })},\"analyzer_pipeline\":${summary(f.frames.map { it.pipelineMs })},")
    append("\"capture_to_signal\":${summary(f.frames.mapNotNull { it.targetSignal?.captureToSignalMs })},\"capture_to_analyzer\":${summary(f.frames.mapNotNull { it.targetSignal?.captureToAnalyzerMs })},")
    append("\"analyzer_to_signal\":${summary(f.frames.mapNotNull { it.targetSignal?.analyzerToSignalMs })}},")
    val available = f.frames.count { it.targetSignal?.captureToSignalMs != null }
    val signalCount = f.frames.count { it.targetSignal != null }
    val fraction = if (f.frames.isEmpty()) null else available.toDouble() / f.frames.size
    append("\"capture_timing_availability\":{\"scope\":\"stored_frames\",\"stored_frames\":${f.frames.size},\"signals_recorded\":$signalCount,\"available_frames\":$available,\"unavailable_frames\":${f.frames.size - available},\"available_fraction\":${num(fraction)}},")
    append("\"notes\":[\"CameraX KEEP_ONLY_LATEST upstream drops are not observable and are not inferred from callback counts.\",\"Pipeline is copy plus ML processing, excluding inter-worker waiting, camera acquisition and display; analyzer_to_signal includes waiting. ORT timing includes tensor copies.\",\"Summaries cover stored samples only; unstored_frames reports truncation.\",\"PSS is process proportional set size in kB; battery temperature is not CPU temperature.\"],")
    val pss = resources.mapNotNull { it.pssKb }
    val delta = if (pss.size >= 2) pss.last() - pss.first() else null
    append("\"pss_first_to_last_sample_delta_kb\":${num(delta)},")
    f.tracking?.let { append("\"tracking\":"); appendTracking(it, f.durationNanos); append(',') }
    append("\"frames\":[")
    f.frames.forEachIndexed { i, x ->
        if (i > 0) append(',')
        append("{\"offset_ms\":${x.offsetNanos / 1_000_000.0},\"conversion_ms\":${x.conversionMs},\"preprocess_ms\":${x.preprocessMs},\"ort_ms\":${x.inferenceMs},\"postprocess_ms\":${x.postprocessMs},\"pipeline_ms\":${x.pipelineMs},\"target_signal\":${x.targetSignal?.toJson() ?: "null"}")
        x.detectionCount?.let { append(",\"detection_count\":$it") }
        append('}')
    }
    append("],\"resources\":[")
    resources.forEachIndexed { i, x ->
        if (i > 0) append(',')
        append("{\"offset_ms\":${x.offsetNanos / 1_000_000.0},\"pss_kb\":${num(x.pssKb)},\"thermal_status\":${num(x.thermalStatus)},\"battery_percent\":${num(x.batteryPercent)},\"battery_status\":${num(x.batteryStatus)},\"battery_temperature_c\":${num(x.batteryTemperatureC)}}")
    }
    append("]}")
}


private fun FrameStamp.stampJson(): String =
    "{\"capture_ns\":$captureNs,\"timestamp_source\":\"${timebase.name.lowercase()}\",\"analyzer_entry_ns\":$analyzerEntryNs}"

private fun StringBuilder.appendTracking(snapshot: TrackingSnapshot, durationNs: Long) {
    val updates = snapshot.samples.map { it.signal }.filter {
        it.kind == TrackingSampleKind.FRAME && it.observation.estimate != null
    }
    val corrections = snapshot.samples.map { it.signal }.filter { it.kind == TrackingSampleKind.CORRECTION }
    val fps = if (durationNs > 0) snapshot.trackUpdates * 1e9 / durationNs else null
    append("{\"schema_version\":1,\"observed_frames\":${snapshot.observedFrames},\"track_updates\":${snapshot.trackUpdates},")
    append("\"corrections\":${snapshot.corrections},\"loss_events\":${snapshot.lossEvents},\"unstored_samples\":${snapshot.unstoredSamples},")
    append("\"updates_fps_session\":$fps,\"timing_summary_ms\":{")
    append("\"update_work\":${summary(updates.map { it.workMs })},")
    append("\"update_capture_to_signal\":${summary(updates.mapNotNull { it.captureToSignalMs })},")
    append("\"update_capture_to_analyzer\":${summary(updates.mapNotNull { it.captureToAnalyzerMs })},")
    append("\"update_analyzer_to_signal\":${summary(updates.mapNotNull { it.analyzerToSignalMs })},")
    append("\"correction_work\":${summary(corrections.map { it.workMs })}},")
    val timed = updates.count { it.captureToSignalMs != null }
    append("\"stored_updates\":${updates.size},\"updates_with_capture_timing\":$timed,\"samples\":[")
    snapshot.samples.forEachIndexed { index, sample ->
        if (index > 0) append(',')
        appendTrackingSample(sample.offsetNanos / 1e6, sample.signal)
    }
    append("]}")
}

internal fun StringBuilder.appendTrackingSample(offsetMs: Double, signal: TrackingSignal) {
    val o = signal.observation
    val box = signal.box
    val quality = o.estimate?.quality
    val center = signal.center
    append("{\"offset_ms\":$offsetMs,\"kind\":\"${signal.kind.name.lowercase()}\",\"sequence\":${o.key.sequence},")
    append("\"generation\":${o.key.generation},\"source_id\":${o.key.source},\"status\":\"${o.phase.name.lowercase()}\",")
    append("\"track_id\":${o.trackId},\"reason\":${o.reason?.let(::q) ?: "null"},")
    append("\"coordinate_space\":\"upright_crop_pixels\",\"width\":${signal.width},\"height\":${signal.height},")
    append("\"tracking_width\":${signal.trackingWidth},\"tracking_height\":${signal.trackingHeight},")
    append("\"center\":${center?.let { "{\"x\":${it.x},\"y\":${it.y}}" }},")
    append("\"pixel\":${center?.let { "{\"x\":${it.x.toInt()},\"y\":${it.y.toInt()}}" }},")
    append("\"box\":${box?.let { "{\"left\":${it.left},\"top\":${it.top},\"right\":${it.right},\"bottom\":${it.bottom}}" }},")
    append("\"quality\":${quality?.let { "{\"points\":${it.points},\"initial_points\":${it.initialPoints},\"retained_fraction\":${it.retainedFraction},\"median_fb_error_px\":${it.medianFbErrorPx},\"correlation\":${it.correlation}}" }},")
    append("\"classification\":\"${o.classification.name.lowercase()}\",\"last_yolo_confidence\":${o.lastYoloConfidence},")
    append("\"last_yolo_frame\":${o.lastYoloStamp?.stampJson()},\"confirmation_age_ms\":${signal.confirmationAgeMs},")
    append("\"frame\":${o.stamp.stampJson()},\"signal_dispatch_ns\":${signal.dispatchNs},\"work_ms\":${signal.workMs},")
    append("\"timing_issue\":${signal.timingIssue?.let(::q) ?: "null"},\"capture_to_signal_ms\":${signal.captureToSignalMs},")
    append("\"capture_to_analyzer_ms\":${signal.captureToAnalyzerMs},\"analyzer_to_signal_ms\":${signal.analyzerToSignalMs}}")
}

/** Streaming resource payload; unavailable measurements remain JSON null. */
fun ResourceSample.toTimelineJson(): String =
    "{\"offset_ns\":\"$offsetNanos\",\"pss_kb\":$pssKb,\"thermal_status\":$thermalStatus," +
        "\"battery_percent\":$batteryPercent,\"battery_status\":$batteryStatus,\"battery_temperature_c\":$batteryTemperatureC}"
