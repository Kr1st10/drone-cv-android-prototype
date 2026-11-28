package ru.university.dronecv.camera

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import ru.university.dronecv.BuildConfig
import ru.university.dronecv.PackagedBuild
import ru.university.dronecv.detection.highestConfidenceVisibleDetection
import ru.university.dronecv.diagnostics.DiagnosticPanel
import ru.university.dronecv.diagnostics.DiagnosticReadings
import ru.university.dronecv.diagnostics.DiagnosticViewModel
import ru.university.dronecv.diagnostics.PhysicalCenteringControls
import ru.university.dronecv.diagnostics.PhysicalCenteringReadings
import ru.university.dronecv.motion.MotionViewModel
import ru.university.dronecv.oneturn.OneTurnPhase
import ru.university.dronecv.oneturn.OneTurnViewModel
import ru.university.dronecv.tracking.ClassConfirmation
import ru.university.dronecv.tracking.VisualPhase

@Composable
internal fun LiveCameraContent(
    controller: LiveController<CameraFrameSnapshot>,
    threadState: ThreadConfiguration,
    probe: CameraProbeState,
    diagnostics: DiagnosticViewModel,
    oneTurn: OneTurnViewModel,
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
        val sectionState = remember { mutableStateOf<CameraSection?>(null) }
        val expandedState = remember { mutableStateOf(false) }
        val section by sectionState
        val panelExpanded by expandedState
        val landscape = maxWidth > maxHeight
        val panelHeight = minOf(320.dp, maxHeight * 0.55f)
        val panelWidth = minOf(240.dp, maxWidth * 0.45f)
        val camera: @Composable (Modifier) -> Unit = { modifier ->
            Box(modifier.testTag("live-preview-region").background(Color.Black)) {
                CameraPreview(controller, running, confidence, probe, Modifier.fillMaxSize(),
                    onError = onCameraError, onRecoverableIssue = onCameraIssue,
                    onInterruption = { diagnostics.stop(true, "Camera paused, rebound or interrupted"); controller.motion?.stop("Camera interrupted or rebound") })
                LiveOverlay(state, controller.motion?.ui?.collectAsStateWithLifecycle()?.value?.mode == "yolo", Modifier.fillMaxSize())
            }
        }
        val controls: @Composable (Modifier) -> Unit = { modifier ->
            LiveControls(state, running, confidence, onRunningChange, onConfidenceChange,
                recoverableIssue, diagnostics, motionModel, threadState, controller::requestThreads, probe, controller, oneTurn, modifier, sectionState, expandedState)
        }
        if (landscape) {
            Row(Modifier.fillMaxSize()) {
                camera(Modifier.weight(1f).fillMaxHeight())
                Spacer(Modifier.width(panelWidth).fillMaxHeight())
            }
        } else {
            Column(Modifier.fillMaxSize()) {
                camera(Modifier.weight(1f).fillMaxWidth())
                Spacer(Modifier.fillMaxWidth().height(panelHeight))
            }
        }
        val panelModifier = if (panelExpanded && section != null) {
            Modifier.fillMaxSize()
        } else if (landscape) {
            Modifier.width(panelWidth).fillMaxHeight()
        } else {
            Modifier.fillMaxWidth().height(panelHeight)
        }
        controls(panelModifier.align(Alignment.BottomEnd))
    }
}

internal enum class CameraSection(val title: String, val tag: String) {
    SETTINGS("Настройки", "camera-settings"),
    DIAGNOSTICS("Диагностика", "camera-diagnostics"),
}

@Composable
internal fun LiveControls(
    state: LiveState,
    running: Boolean,
    confidence: Float,
    onRunningChange: (Boolean) -> Unit,
    onConfidenceChange: (Float) -> Unit,
    issue: String?,
    diagnostics: DiagnosticViewModel,
    motionModel: MotionViewModel,
    threadState: ThreadConfiguration,
    onThreadsChange: (Int) -> Boolean,
    probe: CameraProbeState,
    controller: LiveController<CameraFrameSnapshot>,
    oneTurn: OneTurnViewModel,
    modifier: Modifier,
    sectionState: MutableState<CameraSection?> = remember { mutableStateOf(null) },
    expandedState: MutableState<Boolean> = remember { mutableStateOf(false) },
) {
    val section by sectionState
    val panelExpanded by expandedState
    val diagnosticUi by diagnostics.ui.collectAsStateWithLifecycle()
    val motion = checkNotNull(controller.motion)
    val motionUi by motion.ui.collectAsStateWithLifecycle()

    fun changeCamera(zoom: Float, physical: String?) {
        controller.configure(false, confidence, "camera_configuration_changed")
        diagnostics.stop(true, "Camera zoom or physical camera changed")
        probe.activePhysicalId = null
        probe.actualZoom = null
        probe.captureZoom = null
        probe.warning = null
        probe.loading = true
        probe.physicalId = physical
        probe.requestedZoom = zoom
        probe.selectionEpoch++
    }

    Column(
        modifier.background(MaterialTheme.colorScheme.surface).padding(horizontal = 12.dp, vertical = 4.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Button(
            onClick = { onRunningChange(!running) },
            enabled = !threadState.switching,
            modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("camera-detection-toggle"),
        ) {
            Text(if (running) "Остановить детекцию" else "Начать детекцию")
        }
        PhysicalCenteringControls(controller, running && state.phase == LivePhase.RUNNING &&
            motionUi.mode == "yolo" && !threadState.switching)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            CameraSection.entries.forEach { item ->
                val expanded = section == item
                OutlinedButton(
                    onClick = { sectionState.value = if (expanded) null else item; if (sectionState.value == null) expandedState.value = false },
                    modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag(item.tag).semantics {
                        stateDescription = if (expanded) "Развёрнуто" else "Свёрнуто"
                    },
                    contentPadding = PaddingValues(horizontal = 4.dp, vertical = 8.dp),
                ) { Text(item.title) }
            }
        }

        if (section != null) {
            var drag by remember { mutableStateOf(0f) }
            OutlinedButton(
                onClick = { expandedState.value = !panelExpanded },
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("camera-panel-expand")
                    .pointerInput(panelExpanded) {
                        detectVerticalDragGestures(
                            onDragStart = { drag = 0f },
                            onDragEnd = { if (drag < -30f) expandedState.value = true else if (drag > 30f) expandedState.value = false },
                            onVerticalDrag = { change, amount -> drag += amount; change.consume() },
                        )
                    },
            ) { Text(if (panelExpanded) "Свернуть" else "Развернуть") }
        }
        when (section) {
            CameraSection.SETTINGS -> {
                LiveReadings(state, running, issue, motionUi.mode == "yolo", false,
                    controller, diagnostics, probe, Modifier.height(60.dp), scrollable = true)
                HorizontalDivider()
                Column(
                    Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    CameraSettings(running, confidence, onConfidenceChange, threadState, onThreadsChange,
                        diagnosticUi.recording, motionUi.mode, motionUi.recording,
                        onModeChange = { mode -> if (controller.setTrackingEnabled(mode == "yolo_lk")) motion.mode(mode) },
                        probe = probe, onCameraChange = ::changeCamera)
                }
            }
            CameraSection.DIAGNOSTICS -> {
                HorizontalDivider()
                Column(
                    Modifier.weight(1f).fillMaxWidth().testTag("diagnostics-scroll").verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    LiveReadings(state, running, issue, motionUi.mode == "yolo", true,
                        controller, diagnostics, probe, Modifier, scrollable = false)
                    CameraDiagnostics(state, running, confidence, diagnostics, motionModel,
                        threadState, probe, controller, oneTurn, ::changeCamera)
                }
            }
            null -> LiveReadings(state, running, issue, motionUi.mode == "yolo", false,
                controller, diagnostics, probe, Modifier.weight(1f), scrollable = true)
        }
    }
}

@Composable
private fun CameraSettings(
    running: Boolean,
    confidence: Float,
    onConfidenceChange: (Float) -> Unit,
    threadState: ThreadConfiguration,
    onThreadsChange: (Int) -> Boolean,
    diagnosticRecording: Boolean,
    currentMode: String,
    motionRecording: Boolean,
    onModeChange: (String) -> Unit,
    probe: CameraProbeState,
    onCameraChange: (Float, String?) -> Unit,
) {
    Text("Режим: ${if (currentMode == "yolo") "A: YOLO" else "B: YOLO + LK"}",
        style = MaterialTheme.typography.bodySmall)
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        listOf("yolo" to "A: YOLO", "yolo_lk" to "B: YOLO + LK").forEach { (mode, label) ->
            Button(onClick = { onModeChange(mode) },
                enabled = !running && !motionRecording && mode != currentMode,
                modifier = Modifier.weight(1f)) { Text(label) }
        }
    }
    Text("Порог уверенности: ${(confidence * 100).toInt()}%", style = MaterialTheme.typography.bodyMedium)
    Slider(value = confidence, onValueChange = onConfidenceChange, valueRange = 0.1f..0.95f,
        modifier = Modifier.semantics { contentDescription = "Порог уверенности детектора" })
    Text("Потоки ORT: ${threadState.threads}" + if (threadState.switching) " · загрузка…" else "", style = MaterialTheme.typography.bodySmall)
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        listOf(1, 2, 4).forEach { threads ->
            Button(onClick = { onThreadsChange(threads) },
                enabled = !running && !diagnosticRecording && !threadState.switching && threads != threadState.threads,
                modifier = Modifier.weight(1f).testTag("ort-threads-$threads")) { Text("$threads") }
        }
    }
    threadState.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
    Text("Зум камеры · ${probe.requestedZoom}×", style = MaterialTheme.typography.titleSmall)
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Button(enabled = !probe.loading, onClick = { onCameraChange(1f, null) }, modifier = Modifier.weight(1f).testTag("zoom-one")) { Text("1×") }
        Button(enabled = !probe.loading, onClick = {
            when (val decision = zoomRequest(5f, probe.zoomRange)) {
                is ZoomDecision.Request -> onCameraChange(decision.ratio, null)
                is ZoomDecision.Unavailable -> probe.warning = decision.reason
            }
        }, modifier = Modifier.weight(1f).testTag("zoom-five")) { Text("5× (запрос)") }
    }
    if (probe.loading) Text("Переключение камеры…", style = MaterialTheme.typography.bodySmall)
    probe.warning?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
}

@Composable
private fun CameraDiagnostics(
    state: LiveState,
    running: Boolean,
    confidence: Float,
    diagnostics: DiagnosticViewModel,
    motionModel: MotionViewModel,
    threadState: ThreadConfiguration,
    probe: CameraProbeState,
    controller: LiveController<CameraFrameSnapshot>,
    oneTurn: OneTurnViewModel,
    onCameraChange: (Float, String?) -> Unit,
) {
    val diagnosticUi by diagnostics.ui.collectAsStateWithLifecycle()
    val turnState by oneTurn.state.collectAsStateWithLifecycle(context = Dispatchers.Main.immediate)
    val motion = motionModel.journal
    val motionUi by motion.ui.collectAsStateWithLifecycle()
    val mode = motionUi.mode
    val motionStarting by motionModel.starting.collectAsStateWithLifecycle(context = Dispatchers.Main.immediate)
    val motionStartIssue by motionModel.issue.collectAsStateWithLifecycle(context = Dispatchers.Main.immediate)

    Text("Стенд движения", style = MaterialTheme.typography.titleSmall)
    if (motionUi.recording) Button(onClick = { motion.stop() }, modifier = Modifier.fillMaxWidth()) { Text("Завершить запись стенда") }
    else {
        Button(onClick = { motionModel.start { diagnostics.stop(true, "Motion recording started"); controller.startRecording(cameraContext(probe)) } }, enabled = running && state.phase == LivePhase.RUNNING && !motionStarting,
            modifier = Modifier.fillMaxWidth()) { Text("Начать запись стенда") }
    }
    motionUi.issue?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
    if (motionStarting) Text("Подготовка записи…", style = MaterialTheme.typography.bodySmall)
    motionStartIssue?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    DiagnosticPanel(diagnostics, running && state.phase == LivePhase.RUNNING && !threadState.switching,
        dryRunAvailable = motionUi.mode == "yolo_lk", controller = controller,
        stopAllowed = turnState.phase != OneTurnPhase.SENDING) { dryRun ->
        diagnostics.start(confidence, threadState.threads, state.completedFrames, dryRun = dryRun,
            activate = { start -> controller.startDiagnostics(cameraContext(probe), start) })
    }
    if (BuildConfig.DEBUG) {
        Text("Пробный поворот DJI · один шаг вправо 3°", style = MaterialTheme.typography.titleSmall)
        Button(onClick = { controller.withActiveYoloSource { source -> oneTurn.arm(source, diagnostics.frames) } },
            enabled = oneTurn.configured && running && state.phase == LivePhase.RUNNING &&
                !threadState.switching && mode == "yolo" && diagnosticUi.recording &&
                turnState.phase == OneTurnPhase.IDLE,
            modifier = Modifier.fillMaxWidth().testTag("one-turn-arm")) { Text("Разрешить один поворот") }
        Text(turnState.message, style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.testTag("one-turn-status"))
        if (turnState.phase == OneTurnPhase.ARMED) {
            Button(onClick = oneTurn.controller::invalidate, modifier = Modifier.fillMaxWidth()) { Text("Снять разрешение") }
        }
        Text(if (!oneTurn.configured) "Тестовый канал не настроен в этой сборке"
            else "Нужны A: YOLO и запись диагностики. Новый кадр справа, возраст до 2,5 с. После запроса повторов нет.",
            style = MaterialTheme.typography.bodySmall)
    }
    if (probe.physicalIds.isEmpty()) Text("Прямой выбор физической камеры не доступен или не раскрыт API.", style = MaterialTheme.typography.bodySmall)
    else {
        Text("Запросить физическую камеру (поддержка комбинации потоков не гарантирована):", style = MaterialTheme.typography.bodySmall)
        probe.physicalIds.forEach { id ->
            Button(enabled = !probe.loading, onClick = { onCameraChange(1f, id) }, modifier = Modifier.fillMaxWidth()) { Text("Физический ID $id") }
        }
    }
    CameraInventoryPanel(probe) { controller.exportMetadata(cameraContext(probe)) }
}

@Composable
private fun LiveReadings(
    state: LiveState,
    running: Boolean,
    issue: String?,
    yoloOnly: Boolean,
    showDetails: Boolean,
    controller: LiveController<CameraFrameSnapshot>,
    diagnostics: DiagnosticViewModel,
    probe: CameraProbeState,
    modifier: Modifier,
    scrollable: Boolean,
) {
    val problem = issue ?: if (state.phase == LivePhase.ERROR) {
        "Ошибка обработки: ${state.error}. Остановите и запустите снова."
    } else null
    val scroll = rememberScrollState()
    val readingModifier = if (scrollable) modifier.verticalScroll(scroll) else modifier
    Column(
        readingModifier.fillMaxWidth().testTag("camera-readings"),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        val target = state.tracking?.let { signal ->
            signal.box?.let { box -> frameOffset((box.left + box.right) / (2.0 * signal.width), (box.top + box.bottom) / (2.0 * signal.height)) }
        } ?: if (yoloOnly && state.tracking == null) state.result?.detections?.highestConfidenceVisibleDetection()?.box?.let { box ->
            frameOffset((box.left + box.right) / 2.0, (box.top + box.bottom) / 2.0)
        } else null
        target?.let { (x, y) -> Text("Смещение X ${format(x)}% · Y ${format(y)}%", modifier = Modifier.testTag("target-offset"), style = MaterialTheme.typography.bodySmall) }
        PhysicalCenteringReadings()
        Text(problem ?: when {
            !running -> "Детекция остановлена"
            state.phase == LivePhase.STARTING -> "Подготовка YOLO11s…"
            state.phase == LivePhase.STOPPED -> "Ожидание камеры…"
            state.tracking?.observation?.phase == VisualPhase.TRACKING -> "Сопровождение цели"
            state.tracking?.observation?.phase == VisualPhase.LOST -> "Цель потеряна · повторный поиск"
            yoloOnly && state.result?.detections?.highestConfidenceVisibleDetection() != null -> "Цель обнаружена"
            state.tracking == null && state.result == null -> "Ожидание свежего кадра…"
            else -> "Поиск цели"
        }, color = if (problem != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
            style = MaterialTheme.typography.bodyMedium)
        if (showDetails) {
            LiveStatistics(state, controller, probe)
            DiagnosticReadings(diagnostics, state.completedFrames)
            Text(PackagedBuild.identity.label(), style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.testTag("build-identity"))
        }
    }
}

@Composable
private fun LiveStatistics(state: LiveState, controller: LiveController<*>, probe: CameraProbeState) {
    val input by controller.input.collectAsStateWithLifecycle(context = Dispatchers.Main.immediate)
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
        Text("Экспозиция → публикация state ($signalLabel): $latency", style = MaterialTheme.typography.bodySmall,
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
    Text("Камера ID: ${probe.logicalId ?: "неизвестно"}; физический запрос: ${probe.physicalId ?: "авто"} · запрошено ${probe.requestedZoom}× · текущий zoomRatio ${probe.actualZoom ?: "неизвестен"}", style = MaterialTheme.typography.bodySmall)
    Text("Последний Camera2 zoomRatio: ${probe.captureZoom ?: "не сообщён"} (не оптическая кратность)",
        style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("camera-capture-zoom"))
    Text(sensorEvidence(probe.activePhysicalId, probe.physicalIds.toSet()), style = MaterialTheme.typography.bodySmall)
    Text("Физический ID не доказывает тип объектива; 5× может быть цифровым.", style = MaterialTheme.typography.bodySmall)
    probe.warning?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
}

@Composable
private fun LiveOverlay(state: LiveState, yoloOnly: Boolean, modifier: Modifier) {
    Canvas(modifier.semantics { contentDescription = "Рамка сопровождаемой цели" }) {
        val signal = state.tracking
        if (signal == null) {
            if (!yoloOnly) return@Canvas
            val box = state.result?.detections?.highestConfidenceVisibleDetection()?.box ?: return@Canvas
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

internal fun frameOffset(centerX: Double, centerY: Double): Pair<Double, Double> =
    (centerX - 0.5) * 100 to (centerY - 0.5) * 100

private fun format(value: Double) = String.format(Locale.US, "%.1f", value)

internal fun cameraContext(probe: CameraProbeState): String {
    fun q(value: String?): String = value?.let { ru.university.dronecv.timeline.quote(it) } ?: "null"
    return "{\"logical_id\":${q(probe.logicalId)},\"requested_physical_id\":${q(probe.physicalId)}," +
        "\"latest_active_physical_id\":${q(probe.activePhysicalId)},\"requested_zoom\":${probe.requestedZoom}," +
        "\"confirmed_zoom\":${probe.actualZoom},\"latest_capture_zoom\":${probe.captureZoom}," +
        "\"scope\":\"latest_context_not_frame_bound\",\"requested_af\":${probe.requestedAf},\"actual_af\":${probe.actualAf},\"available_af\":${probe.availableAf},\"requested_ae\":${probe.requestedAe},\"actual_ae\":${probe.actualAe},\"available_ae\":${probe.availableAe},\"requested_stabilization\":${probe.requestedStabilization},\"actual_stabilization\":${probe.actualStabilization},\"available_stabilization\":${probe.availableStabilization}, " +
        "\"sources\":{\"logical_id\":\"Camera2CameraInfo\",\"requested_physical_id\":\"UI selection; null means auto\",\"requested_zoom\":\"UI selection\",\"confirmed_zoom\":\"CameraX ZoomState; null means not observed\",\"latest_capture_zoom\":\"latest Camera2 CaptureResult CONTROL_ZOOM_RATIO; null means unavailable or unreported\",\"latest_active_physical_id\":\"latest Camera2 CaptureResult; null means unavailable or unreported\",\"requested_modes\":\"latest Camera2 CaptureRequest; null means not observed\",\"actual_modes\":\"latest Camera2 CaptureResult; null means unavailable or unreported\",\"available_modes\":\"CameraCharacteristics of requested physical ID or bound logical ID; null means unavailable\"}," +
        "\"device\":${q(android.os.Build.MODEL)},\"android_release\":${q(android.os.Build.VERSION.RELEASE)}}"
}
