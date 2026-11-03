package ru.university.dronecv.diagnostics

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
    return "{\"count\":${s.count},\"mean\":${s.mean},\"median\":${s.median},\"p95_nearest_rank\":${s.p95},\"min\":${s.min},\"max\":${s.max}}"
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
    append("\"timing_summary_ms\":{")
    append("\"conversion\":${summary(f.frames.map { it.conversionMs })},\"preprocessing\":${summary(f.frames.map { it.preprocessMs })},")
    append("\"ort_including_tensor_copy\":${summary(f.frames.map { it.inferenceMs })},\"postprocessing_nms\":${summary(f.frames.map { it.postprocessMs })},\"analyzer_pipeline\":${summary(f.frames.map { it.pipelineMs })}},")
    append("\"notes\":[\"CameraX KEEP_ONLY_LATEST upstream drops are not observable and are not inferred from callback counts.\",\"Pipeline excludes camera acquisition and UI display; ORT timing includes input/output copies.\",\"Summaries cover stored samples only; unstored_frames reports truncation.\",\"PSS is process proportional set size in kB; battery temperature is not CPU temperature.\"],")
    val pss = resources.mapNotNull { it.pssKb }
    val delta = if (pss.size >= 2) pss.last() - pss.first() else null
    append("\"pss_first_to_last_sample_delta_kb\":${num(delta)},")
    append("\"frames\":[")
    f.frames.forEachIndexed { i, x ->
        if (i > 0) append(',')
        append("{\"offset_ms\":${x.offsetNanos / 1_000_000.0},\"conversion_ms\":${x.conversionMs},\"preprocess_ms\":${x.preprocessMs},\"ort_ms\":${x.inferenceMs},\"postprocess_ms\":${x.postprocessMs},\"pipeline_ms\":${x.pipelineMs}}")
    }
    append("],\"resources\":[")
    resources.forEachIndexed { i, x ->
        if (i > 0) append(',')
        append("{\"offset_ms\":${x.offsetNanos / 1_000_000.0},\"pss_kb\":${num(x.pssKb)},\"thermal_status\":${num(x.thermalStatus)},\"battery_percent\":${num(x.batteryPercent)},\"battery_status\":${num(x.batteryStatus)},\"battery_temperature_c\":${num(x.batteryTemperatureC)}}")
    }
    append("]}")
}
