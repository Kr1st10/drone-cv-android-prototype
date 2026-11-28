package ru.university.dronecv.diagnostics

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import java.util.Locale
import ru.university.dronecv.camera.LiveController

@Composable
internal fun PhysicalCenteringControls(
    controller: LiveController<*>,
    yoloReady: Boolean,
    model: DjiAttitudeViewModel = viewModel(),
) {
    val usb by model.ui.collectAsStateWithLifecycle()
    val state by model.centering.collectAsStateWithLifecycle()
    DisposableEffect(model, controller) {
        onDispose { model.stopCentering(CenteringStop.CAMERA_LEFT) }
    }
    OutlinedButton(
        onClick = { if (state.running) model.stopCentering() else model.startCentering(controller) },
        enabled = if (state.running) !state.stopping else yoloReady && usb.action == null,
        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("physical-centering-toggle"),
    ) { Text(if (state.running) "Стоп автоцентрирования" else "Автоцентрирование DJI") }
}

@Composable
internal fun PhysicalCenteringReadings(model: DjiAttitudeViewModel = viewModel()) {
    val state by model.centering.collectAsStateWithLifecycle()
    if (!state.running && state.reason == null) return
    val status = when {
        state.stopping -> "Завершаем обмен с DJI…"
        state.reason == CenteringStop.SOURCE_CHANGED -> "Камера остановлена или изменился её источник"
        state.reason != null -> checkNotNull(state.reason).label()
        state.steps.lastOrNull()?.number == state.completedSteps + 1 -> "Выполняется шаг"
        else -> "Ожидается свежий кадр"
    }
    val count = "${state.completedSteps}/${PHYSICAL_CENTERING_POLICY.stepLimit}"
    Text("DJI · $status · $count", style = MaterialTheme.typography.bodySmall,
        modifier = Modifier.testTag("physical-centering-status").semantics { liveRegion = LiveRegionMode.Polite })
    state.detail?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
    state.offsetPercent?.let { Text("Смещение ${decimal(it)}%", style = MaterialTheme.typography.bodySmall) }
    state.captureToSignalMs?.let { Text("Экспозиция → YOLO ${decimal(it)} мс", style = MaterialTheme.typography.bodySmall) }
    state.frameAgeMs?.let { Text("Возраст при проверке ${decimal(it)} мс", style = MaterialTheme.typography.bodySmall) }
    for (step in state.steps.asReversed()) {
        val direction = if (step.direction == CenteringDirection.RIGHT) "вправо" else "влево"
        val movement = step.command.yawDelta?.let { "${decimal(it)}°" } ?: "не измерен"
        val verification = when {
            step.verified -> "стабилизировался"
            step.settled != null || step.recovered != null || !state.running -> "стабилизация не подтверждена"
            else -> "проверяется"
        }
        Text("Шаг ${step.number} $direction · WeAct ${step.command.transmission.lowercase()}",
            style = MaterialTheme.typography.bodySmall)
        Text("Команда DJI · ${step.command.confirmation}", style = MaterialTheme.typography.bodySmall)
        Text("Поворот yaw $movement · $verification", style = MaterialTheme.typography.bodySmall)
        val angles = listOfNotNull(
            step.before?.let { "до ${decimal(it)}°" },
            step.after?.let { "после ${decimal(it)}°" },
            step.settled?.let { "контроль ${decimal(it)}°" },
            step.recovered?.let { "после переподключения ${decimal(it)}°" },
        )
        if (angles.isNotEmpty()) Text("Yaw ${angles.joinToString(" · ")}", style = MaterialTheme.typography.bodySmall)
    }
}

private fun decimal(value: Double): String = String.format(Locale.getDefault(), "%.1f", value)
