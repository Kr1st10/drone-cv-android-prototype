package ru.university.dronecv.camera

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.ui.platform.LocalContext
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import ru.university.dronecv.motion.MotionViewModel
import ru.university.dronecv.tracking.ClassConfirmation
import ru.university.dronecv.tracking.VisualPhase
import ru.university.dronecv.diagnostics.DiagnosticViewModel
import ru.university.dronecv.diagnostics.DiagnosticPanel

@Composable
internal fun LiveCameraContent(
    controller: LiveController<CameraFrameSnapshot>,
    threadState: ThreadConfiguration,
    probe: CameraProbeState,
    diagnostics: DiagnosticViewModel,
    motionModel: MotionViewModel,
    running: Boolean,
    confidence: Float,
    onRunningChange: (Boolean) -> Unit,
    onConfidenceChange: (Float) -> Unit,
    recoverableIssue: String?,
    onCameraError: (Throwable) -> Unit,
    onCameraIssue: (Int?) -> Unit,
) {
    val state by controller.state.collectAsStateWithLifecycle(context = Dispatchers.Main.immediate)
    val observation = state.tracking
    val observationRevision = state.revision
    LaunchedEffect(observationRevision) {
        if (observation != null) {
            val remainingNs = (observation.displayUntilNs - android.os.SystemClock.elapsedRealtimeNanos()).coerceAtLeast(0L)
            delay((remainingNs + 999_999L) / 1_000_000L)
            controller.expire(observationRevision)
        } else if (state.result != null) {
            delay(250)
            controller.expire(observationRevision)
        }
    }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val landscape = maxWidth > maxHeight
        val panelHeight = minOf(280.dp, maxHeight * 0.5f)
        val panelWidth = minOf(240.dp, maxWidth * 0.45f)
        val camera: @Composable (Modifier) -> Unit = { modifier ->
            Box(modifier.background(Color.Black)) {
                CameraPreview(controller, running, confidence, probe, Modifier.fillMaxSize(),
                    onError = onCameraError, onRecoverableIssue = onCameraIssue,
                    onInterruption = { diagnostics.stop(true, "Camera paused, rebound or interrupted"); controller.motion?.stop("Camera interrupted or rebound") })
                LiveOverlay(state, controller.motion?.ui?.collectAsStateWithLifecycle()?.value?.mode == "yolo", Modifier.fillMaxSize())
            }
        }
        val controls: @Composable (Modifier) -> Unit = { modifier ->
            LiveControls(state, running, confidence, onRunningChange, onConfidenceChange,
                recoverableIssue, diagnostics, motionModel, threadState, controller::requestThreads, probe, controller, modifier)
        }
        if (landscape) {
            Row(Modifier.fillMaxSize()) {
                camera(Modifier.weight(1f).fillMaxHeight())
                controls(Modifier.width(panelWidth).fillMaxHeight())
            }
        } else {
            Column(Modifier.fillMaxSize()) {
                camera(Modifier.weight(1f).fillMaxWidth())
                controls(Modifier.fillMaxWidth().height(panelHeight))
            }
        }
    }
}

@Composable
private fun LiveControls(
    state: LiveState, running: Boolean, confidence: Float,
    onRunningChange: (Boolean) -> Unit, onConfidenceChange: (Float) -> Unit,
    issue: String?, diagnostics: DiagnosticViewModel, motionModel: MotionViewModel, threadState: ThreadConfiguration,
    onThreadsChange: (Int) -> Boolean, probe: CameraProbeState, controller: LiveController<CameraFrameSnapshot>, modifier: Modifier,
) {
    val diagnosticUi by diagnostics.ui.collectAsStateWithLifecycle()
    val motion = checkNotNull(controller.motion)
    val motionUi by motion.ui.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var exportStatus by remember { mutableStateOf<String?>(null) }
    val saveMotion = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
        val report = motionModel.pendingExport
        if (uri != null && report != null) scope.launch {
            exportStatus = try {
                withContext(Dispatchers.IO) {
                    checkNotNull(context.contentResolver.openOutputStream(uri)).use { it.write(report.toByteArray(Charsets.UTF_8)) }
                }
                "Журнал сохранён"
            } catch (e: Exception) { "Не удалось сохранить журнал: ${e.message ?: e.javaClass.simpleName}" }
        }
        motionModel.pendingExport = null
    }
    val input by controller.input.collectAsStateWithLifecycle(context = Dispatchers.Main.immediate)
    Column(modifier.background(MaterialTheme.colorScheme.surface).verticalScroll(rememberScrollState())
        .padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Button(onClick = { onRunningChange(!running) }, enabled = !threadState.switching, modifier = Modifier.fillMaxWidth()) {
            Text(if (running) "Остановить" else "Начать детекцию")
        }
        Text("Confidence: ${(confidence * 100).toInt()}%", style = MaterialTheme.typography.bodyMedium)
        Slider(value = confidence, onValueChange = onConfidenceChange, valueRange = 0.1f..0.95f,
            modifier = Modifier.semantics { contentDescription = "Порог уверенности детектора" })
        Text(issue ?: when {
            !running -> "Детекция остановлена"
            state.phase == LivePhase.ERROR -> "Ошибка обработки: ${state.error}. Остановите и запустите снова."
            state.phase == LivePhase.STARTING -> "Подготовка YOLO11s…"
            state.phase == LivePhase.STOPPED -> "Ожидание камеры…"
            state.tracking?.observation?.phase == VisualPhase.TRACKING -> "Сопровождение цели"
            state.tracking?.observation?.phase == VisualPhase.LOST -> "Цель потеряна · повторный поиск"
            state.tracking == null -> "Ожидание свежего кадра…"
            else -> "Поиск цели"
        }, color = if (state.phase == LivePhase.ERROR) MaterialTheme.colorScheme.error
            else MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodyMedium)
        val fps = state.fps?.let { format(it) } ?: "—"
        val inference = state.result?.inferenceMs?.let { format(it) } ?: "—"
        val pipeline = state.pipelineMs?.let { format(it) } ?: "—"
        Text("YOLO: $fps FPS · ORT: $inference мс\nОбработка YOLO: $pipeline мс · кадров: ${state.completedFrames}",
            modifier = Modifier.testTag(if (state.result != null) "live-frame-ready" else "live-frame-waiting"),
            style = MaterialTheme.typography.bodySmall)
        Text("Вход: ${input.fps?.let(::format) ?: "—"} FPS · кадров: ${input.received}\n" +
            "Заменено: ${input.superseded} · без буфера: ${input.noBuffer}",
            style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("camera-input-stats"))
        state.result?.let {
            Text("Последний YOLO: ${it.detections.size} кандидатов · ${it.width}×${it.height}", style = MaterialTheme.typography.bodySmall)
        }
        state.tracking?.let { signal ->
            val latency = signal.captureToSignalMs?.let { "${format(it)} мс" } ?: when (signal.timingIssue) {
                "missing_capture_timestamp" -> "неизвестно: нет метки экспозиции"
                "capture_after_analyzer" -> "неизвестно: метка экспозиции позже входа"
                "non_monotonic_dispatch_clock" -> "неизвестно: нарушен порядок часов приложения"
                else -> "неизвестно: часы камеры не сопоставлены"
            }
            val signalLabel = if (signal.kind == TrackingSampleKind.CORRECTION) "коррекция LK" else "наблюдение LK"
            Text("Экспозиция → $signalLabel: $latency", style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.testTag("capture-to-signal"))
            signal.center?.let { point ->
                val observation = signal.observation
                val quality = checkNotNull(observation.estimate).quality
                Text("Цель: (${point.x.toInt()}, ${point.y.toInt()}) · ${signal.width}×${signal.height} px",
                    style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("target-coordinates"))
                Text("LK: ${state.trackingFps?.let(::format) ?: "—"} обновл./с · ${quality.points}/${quality.initialPoints} точек · NCC ${format(quality.correlation)}",
                    style = MaterialTheme.typography.bodySmall)
                val score = observation.lastYoloConfidence?.let { "${format(it * 100.0)}%" } ?: "—"
                val age = signal.confirmationAgeMs?.let { "${format(it)} мс" } ?: "неизвестен"
                Text("Подтверждение YOLO: $score · возраст $age", style = MaterialTheme.typography.bodySmall)
                if (observation.classification == ClassConfirmation.MISSED) {
                    Text("Последняя проверка не подтвердила цель", style = MaterialTheme.typography.bodySmall)
                }
            }
        }
        Text("Потоки ORT: ${threadState.threads}" + if (threadState.switching) " · загрузка…" else "", style = MaterialTheme.typography.bodySmall)
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            listOf(1, 2, 4).forEach { threads ->
                Button(onClick = { onThreadsChange(threads) },
                    enabled = !running && !diagnosticUi.recording && !threadState.switching && threads != threadState.threads,
                    modifier = Modifier.weight(1f).testTag("ort-threads-$threads")) { Text("$threads") }
            }
        }
        threadState.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        Text("Стенд движения", style = MaterialTheme.typography.titleSmall)
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            listOf("yolo" to "A: YOLO", "yolo_lk" to "B: YOLO + LK").forEach { (mode, label) ->
                Button(onClick = { if (controller.setTrackingEnabled(mode == "yolo_lk")) motion.mode(mode) },
                    enabled = !running && !motionUi.recording && mode != motionUi.mode,
                    modifier = Modifier.weight(1f)) { Text(label) }
            }
        }
        Text("Режим: ${if (motionUi.mode == "yolo") "A: YOLO" else "B: YOLO + LK"}", style = MaterialTheme.typography.bodySmall)
        if (motionUi.recording) Button(onClick = { motion.stop() }, modifier = Modifier.fillMaxWidth()) { Text("Завершить запись стенда") }
        else {
            Button(onClick = { diagnostics.stop(true, "Motion recording started"); controller.configure(false, confidence); motion.start(); controller.configure(true, confidence) }, enabled = running && state.phase == LivePhase.RUNNING,
                modifier = Modifier.fillMaxWidth()) { Text("Начать запись стенда") }
            if (motionUi.report != null) Button(onClick = { motionModel.pendingExport = motionUi.report; saveMotion.launch("drone-motion.json") }, modifier = Modifier.fillMaxWidth()) { Text("Экспорт стенда JSON") }
        }
        exportStatus?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        DiagnosticPanel(diagnostics, running && state.phase == LivePhase.RUNNING && !threadState.switching,
            confidence, threadState.threads, state.completedFrames)
        Text("Камера ID: ${probe.logicalId ?: "неизвестно"}; физический запрос: ${probe.physicalId ?: "авто"} · запрошено ${probe.requestedZoom}× · текущий zoomRatio ${probe.actualZoom ?: "неизвестен"}", style = MaterialTheme.typography.bodySmall)
        Text("Последний Camera2 zoomRatio: ${probe.captureZoom ?: "не сообщён"} (не оптическая кратность)",
            style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("camera-capture-zoom"))
        Text(sensorEvidence(probe.activePhysicalId, probe.physicalIds.toSet()), style = MaterialTheme.typography.bodySmall)
        Text("Физический ID не доказывает тип объектива; 5× может быть цифровым.", style = MaterialTheme.typography.bodySmall)
        fun change(zoom: Float, physical: String?) {
            diagnostics.stop(true, "Camera zoom or physical camera changed")
            controller.configure(false, confidence)
            probe.activePhysicalId = null; probe.actualZoom = null; probe.captureZoom = null; probe.warning = null; probe.loading = true
            probe.physicalId = physical; probe.requestedZoom = zoom; probe.selectionEpoch++
        }
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Button(enabled = !probe.loading, onClick = { change(1f, null) }, modifier = Modifier.weight(1f).testTag("zoom-one")) { Text("1×") }
            Button(enabled = !probe.loading, onClick = {
                when (val decision = zoomRequest(5f, probe.zoomRange)) {
                    is ZoomDecision.Request -> change(decision.ratio, null)
                    is ZoomDecision.Unavailable -> probe.warning = decision.reason
                }
            }, modifier = Modifier.weight(1f).testTag("zoom-five")) { Text("5× (запрос)") }
        }
        if (probe.physicalIds.isEmpty()) Text("Прямой выбор физической камеры не доступен или не раскрыт API.", style = MaterialTheme.typography.bodySmall)
        else {
            Text("Запросить физическую камеру (поддержка комбинации потоков не гарантирована):", style = MaterialTheme.typography.bodySmall)
            probe.physicalIds.forEach { id ->
                Button(enabled = !probe.loading, onClick = { change(1f, id) }, modifier = Modifier.fillMaxWidth()) { Text("Физический ID $id") }
            }
        }
        if (probe.loading) Text("Переключение камеры…", style = MaterialTheme.typography.bodySmall)
        probe.warning?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        CameraInventoryPanel(probe)
    }
}

@Composable
private fun LiveOverlay(state: LiveState, yoloOnly: Boolean, modifier: Modifier) {
    Canvas(modifier.semantics { contentDescription = "Рамка сопровождаемой цели" }) {
        val signal = state.tracking
        if (signal == null) {
            if (!yoloOnly) return@Canvas
            val box = state.result?.detections?.maxByOrNull { it.confidence }?.box ?: return@Canvas
            val topLeft = Offset(box.left * size.width, box.top * size.height)
            drawRect(Color.Green, topLeft, Size((box.right - box.left) * size.width, (box.bottom - box.top) * size.height), style = Stroke(2.dp.toPx()))
            return@Canvas
        }
        val box = signal.box ?: return@Canvas
        fun screen(x: Double, y: Double) = Offset((x / signal.width * size.width).toFloat(),
            (y / signal.height * size.height).toFloat())
        val topLeft = screen(box.left, box.top)
        val bottomRight = screen(box.right, box.bottom)
        drawRect(Color.Green, topLeft, Size(bottomRight.x - topLeft.x, bottomRight.y - topLeft.y),
            style = Stroke(2.dp.toPx()))
        signal.center?.let { drawCircle(Color.Yellow, 4.dp.toPx(), screen(it.x, it.y)) }
    }
}

private fun format(value: Double) = String.format(Locale.US, "%.1f", value)
