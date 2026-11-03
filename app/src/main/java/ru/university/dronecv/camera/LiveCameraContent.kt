package ru.university.dronecv.camera

import android.graphics.Paint
import androidx.camera.core.ImageProxy
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
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import ru.university.dronecv.diagnostics.DiagnosticViewModel
import ru.university.dronecv.diagnostics.DiagnosticPanel

@Composable
fun LiveCameraContent(
    controller: LiveController<ImageProxy>,
    threadState: ThreadConfiguration,
    diagnostics: DiagnosticViewModel,
    running: Boolean,
    confidence: Float,
    onRunningChange: (Boolean) -> Unit,
    onConfidenceChange: (Float) -> Unit,
    recoverableIssue: String?,
    onCameraError: (Throwable) -> Unit,
    onCameraIssue: (Int?) -> Unit,
) {
    val state by controller.state.collectAsStateWithLifecycle(context = Dispatchers.Main.immediate)
    // A camera that silently stalls must not leave boxes on screen indefinitely.
    LaunchedEffect(state.revision) {
        if (state.result != null) {
            delay(1500)
            controller.expire(state.revision)
        }
    }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val landscape = maxWidth > maxHeight
        val panelHeight = minOf(280.dp, maxHeight * 0.5f)
        val panelWidth = minOf(240.dp, maxWidth * 0.45f)
        val camera: @Composable (Modifier) -> Unit = { modifier ->
            Box(modifier.background(Color.Black)) {
                CameraPreview(controller, running, confidence, Modifier.fillMaxSize(),
                    onError = onCameraError, onRecoverableIssue = onCameraIssue,
                    onInterruption = { diagnostics.stop(true, "Camera paused, rebound or interrupted") })
                LiveOverlay(state, Modifier.fillMaxSize())
            }
        }
        val controls: @Composable (Modifier) -> Unit = { modifier ->
            LiveControls(state, running, confidence, onRunningChange, onConfidenceChange,
                recoverableIssue, diagnostics, threadState, controller::requestThreads, modifier)
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
    issue: String?, diagnostics: DiagnosticViewModel, threadState: ThreadConfiguration,
    onThreadsChange: (Int) -> Boolean, modifier: Modifier,
) {
    val diagnosticUi by diagnostics.ui.collectAsStateWithLifecycle()
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
            state.phase == LivePhase.ERROR -> "Ошибка модели: ${state.error}. Остановите и запустите снова."
            state.phase == LivePhase.STARTING -> "Подготовка YOLO11s…"
            state.phase == LivePhase.STOPPED -> "Ожидание камеры…"
            state.result == null -> "Ожидание свежего кадра…"
            state.result.detections.isEmpty() -> "На обработанном кадре дроны не обнаружены"
            else -> "Обнаружений: ${state.result.detections.size}"
        }, color = if (state.phase == LivePhase.ERROR) MaterialTheme.colorScheme.error
            else MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodyMedium)
        val fps = state.fps?.let { format(it) } ?: "—"
        val inference = state.result?.inferenceMs?.let { format(it) } ?: "—"
        val pipeline = state.pipelineMs?.let { format(it) } ?: "—"
        Text("Обработка: $fps FPS · ORT: $inference мс\nПолный цикл: $pipeline мс · кадров: ${state.completedFrames}",
            modifier = Modifier.testTag(if (state.result != null) "live-frame-ready" else "live-frame-waiting"),
            style = MaterialTheme.typography.bodySmall)
        state.result?.let {
            Text("YOLO11s · CPU / ${threadState.threads} потока · ${it.width}×${it.height}", style = MaterialTheme.typography.bodySmall)
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
        DiagnosticPanel(diagnostics, running && state.phase == LivePhase.RUNNING && !threadState.switching,
            confidence, threadState.threads, state.completedFrames)
    }
}

@Composable
private fun LiveOverlay(state: LiveState, modifier: Modifier) {
    val paint = remember { Paint(Paint.ANTI_ALIAS_FLAG).apply { typeface = android.graphics.Typeface.DEFAULT_BOLD } }
    Canvas(modifier.semantics { contentDescription = "Рамки обнаружений камеры" }) {
        val result = state.result ?: return@Canvas
        paint.textSize = 14.dp.toPx()
        val stroke = 2.dp.toPx()
        result.detections.forEach { detection ->
            val box = CameraGeometry.map(detection.box, size.width, size.height)
            drawRect(Color.Green, Offset(box[0], box[1]), Size(box[2] - box[0], box[3] - box[1]),
                style = Stroke(stroke))
            val text = "${detection.label} ${(detection.confidence * 100).toInt()}%"
            val textWidth = paint.measureText(text) + 8.dp.toPx()
            val labelHeight = 20.dp.toPx()
            val x = box[0].coerceIn(0f, (size.width - textWidth).coerceAtLeast(0f))
            val y = (box[1] - labelHeight).coerceAtLeast(0f)
            drawRect(Color.Black.copy(alpha = 0.8f), Offset(x, y), Size(textWidth, labelHeight))
            paint.color = android.graphics.Color.GREEN
            drawContext.canvas.nativeCanvas.drawText(text, x + 4.dp.toPx(), y + 15.dp.toPx(), paint)
        }
    }
}

private fun format(value: Double) = String.format(Locale.US, "%.1f", value)
