package ru.university.dronecv.diagnostics

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import java.util.Locale

@Composable
internal fun DjiAttitudePanel(model: DjiAttitudeViewModel = viewModel()) {
    DisposableEffect(model) { onDispose { model.cancelTurn() } }
    val ui by model.ui.collectAsStateWithLifecycle()
    val idle = ui.action == null
    Button(onClick = model::readOnce, enabled = idle, modifier = Modifier.fillMaxWidth()) {
        Text("Прочитать углы DJI")
    }
    OutlinedButton(onClick = model::turnOnce, enabled = idle, modifier = Modifier.fillMaxWidth()) {
        Text("Один поворот DJI")
    }
    ui.firmware?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
    Column(modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }) {
        ui.turn?.let { turn ->
            val delta = turn.yawDelta?.let {
                String.format(Locale.getDefault(), if (it == 0.0) "%.1f°" else "%+.1f°", it)
            } ?: "Не измерен"
            Text("Передача WeAct: ${turn.transmission}", style = MaterialTheme.typography.bodySmall)
            Text("Команда DJI: ${turn.confirmation}", style = MaterialTheme.typography.bodySmall)
            Text("Фактический поворот (yaw): $delta", style = MaterialTheme.typography.bodySmall)
        }
        val status = if (ui.cancelling) "Завершаем обмен с DJI…" else ui.status ?: ui.action?.progress
        status?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
    }
}
