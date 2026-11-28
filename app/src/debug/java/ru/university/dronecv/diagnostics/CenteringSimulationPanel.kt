package ru.university.dronecv.diagnostics

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlin.math.roundToInt
import ru.university.dronecv.camera.LiveController

@Composable
internal fun CenteringSimulationPanel(
    controller: LiveController<*>,
    yoloReady: Boolean,
    model: CenteringSimulationViewModel = viewModel(),
) {
    val ui by model.ui.collectAsStateWithLifecycle()
    LifecycleResumeEffect(model) {
        onPauseOrDispose { model.stop() }
    }

    Text("Симуляция DJI", style = MaterialTheme.typography.titleSmall)
    Button(
        onClick = { model.start(controller) },
        enabled = yoloReady && !ui.running,
        modifier = Modifier.fillMaxWidth().testTag("centering-simulation-start"),
    ) { Text("Автоцентрирование") }

    if (!yoloReady && !ui.running) {
        Text("Запустите детекцию в режиме A: YOLO и дождитесь кадра.",
            style = MaterialTheme.typography.bodySmall)
    }
    if (ui.running) {
        OutlinedButton(
            onClick = model::stop,
            modifier = Modifier.fillMaxWidth().testTag("centering-simulation-stop"),
        ) { Text("Остановить симуляцию") }
    }
    if (ui.phase != CenteringSimulationPhase.IDLE) {
        SimulationTarget(ui.offsetPercent)
        Text(ui.offsetPercent?.let { "Смещение по горизонтали ${it.roundToInt()}%" } ?: "Координаты цели недоступны",
            style = MaterialTheme.typography.bodySmall)
        Text("Шаги ${ui.completedSteps} / ${model.stepLimit}",
            style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("centering-simulation-steps"))
        val status = if (ui.reason == CenteringStop.ERROR) "Ошибка сеанса или записи журнала"
        else ui.reason?.label() ?: when (ui.phase) {
            CenteringSimulationPhase.STEPPING -> "Выполняется шаг"
            else -> "Ожидается свежий кадр"
        }
        Text("Симуляция · $status", style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.testTag("centering-simulation-status").semantics { liveRegion = LiveRegionMode.Polite })
    }
    ui.journalIssue?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
}

@Composable
private fun SimulationTarget(offsetPercent: Double?) {
    val zone = MaterialTheme.colorScheme.secondaryContainer
    val marker = MaterialTheme.colorScheme.onSurface
    Canvas(Modifier.fillMaxWidth().height(56.dp)) {
        val centerX = size.width / 2
        val halfZone = size.width * SIMULATION_DEAD_ZONE_PERCENT / 100f
        drawRect(zone, Offset(centerX - halfZone, 0f), Size(2 * halfZone, size.height))
        drawLine(marker, Offset(centerX, 0f), Offset(centerX, size.height), strokeWidth = 1.dp.toPx())
        offsetPercent?.let { offset ->
            val width = size.width * 0.12f
            val height = size.height * 0.6f
            val x = centerX + size.width * offset.toFloat() / 100f
            drawRect(marker, Offset(x - width / 2, (size.height - height) / 2),
                Size(width, height), style = Stroke(2.dp.toPx()))
        }
    }
}

internal fun CenteringStop.label(): String = when (this) {
    CenteringStop.CENTERED -> "По горизонтали в центре"
    CenteringStop.TARGET_LOST -> "Цель потеряна"
    CenteringStop.FRAME_TIMEOUT -> "Истекло время ожидания кадра"
    CenteringStop.STEP_TIMEOUT -> "Истекло время ожидания шага"
    CenteringStop.STEP_LIMIT -> "Достигнут лимит шагов"
    CenteringStop.SOURCE_CHANGED -> "Источник или настройки камеры изменились"
    CenteringStop.STOPPED -> "Остановлено"
    CenteringStop.STALE_FRAME -> "Кадр устарел"
    CenteringStop.FRAME_CLOCK -> "Часы камеры не сопоставимы"
    CenteringStop.CAMERA_LEFT -> "Выход из камеры"
    CenteringStop.SOURCE_BUSY -> "Кадры YOLO заняты другим сеансом"
    CenteringStop.FRAME_OVERFLOW -> "Слишком много необработанных кадров"
    CenteringStop.ERROR -> "Ошибка сеанса"
}
