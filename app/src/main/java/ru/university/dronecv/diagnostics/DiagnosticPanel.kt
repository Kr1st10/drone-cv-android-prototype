package ru.university.dronecv.diagnostics

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.util.Locale
import ru.university.dronecv.BuildConfig
import ru.university.dronecv.R
import ru.university.dronecv.camera.LiveController

@Composable
internal fun DiagnosticPanel(
    model: DiagnosticViewModel,
    liveReady: Boolean,
    dryRunAvailable: Boolean,
    controller: LiveController<*>,
    stopAllowed: Boolean = true,
    onStart: (Boolean) -> Unit,
) {
    val ui by model.ui.collectAsStateWithLifecycle()
    val showDryRun = BuildConfig.DEBUG && dryRunAvailable
    var dryRun by remember(showDryRun) { mutableStateOf(false) }
    Text("Запись диагностики", style = MaterialTheme.typography.titleSmall)
    if (ui.recording) {
        Button(onClick = { model.stop() }, enabled = stopAllowed, modifier = Modifier.fillMaxWidth().testTag("diagnostic-stop")) { Text("Завершить сессию") }
    } else {
        if (showDryRun) {
            Row(
                Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("diagnostic-dry-run")
                    .toggleable(dryRun, enabled = !ui.starting, role = Role.Checkbox) { dryRun = it },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Checkbox(dryRun, onCheckedChange = null, enabled = !ui.starting, modifier = Modifier.padding(end = 8.dp))
                Text(stringResource(R.string.diagnostic_dry_run), style = MaterialTheme.typography.bodySmall)
            }
        }
        Button(onClick = { onStart(showDryRun && dryRun) }, enabled = liveReady && !ui.starting,
            modifier = Modifier.fillMaxWidth().testTag("diagnostic-start")) { Text("Начать сессию") }
        Text("Для записи запустите детекцию и дождитесь кадра.", style = MaterialTheme.typography.bodySmall)
    }
    DjiAttitudePanel()
    CenteringSimulationPanel(controller, liveReady && !dryRunAvailable)
}

@Composable
internal fun DiagnosticReadings(model: DiagnosticViewModel, warmupFrames: Long) {
    val ui by model.ui.collectAsStateWithLifecycle()
    if (ui.recording) {
        Text("Сессия: ${ui.elapsedSeconds} с. При фоне или выключении экрана она будет помечена прерванной.",
            style = MaterialTheme.typography.bodySmall)
    } else {
        Text("Прогрев до записи: $warmupFrames обработанных кадров", style = MaterialTheme.typography.bodySmall)
    }
    ui.report?.let { report ->
        val f = report.frames
        val fps = f.processedFps?.let { String.format(Locale.US, "%.2f", it) } ?: "—"
        Text("${if (f.interrupted) "Прервана: ${f.reason}" else "Завершена"} · ${f.completedFrames} кадров · $fps FPS\nДлительность: ${f.durationNanos / 1_000_000_000} с; отброшенные камерой неизвестны.",
            style = MaterialTheme.typography.bodySmall)
        ui.pipeline?.let { stat ->
            Text("Цикл: среднее ${fmt(stat.mean)}, медиана ${fmt(stat.median)}, p95 ${stat.p95?.let(::fmt) ?: "—"} мс",
                style = MaterialTheme.typography.bodySmall)
        }
        ui.ort?.let { Text("ORT: среднее ${fmt(it.mean)}, медиана ${fmt(it.median)} мс", style = MaterialTheme.typography.bodySmall) }
    }
    if (ui.starting) Text("Подготовка записи…", style = MaterialTheme.typography.bodySmall)
    ui.recordingIssue?.let { Text("Запись неполна: $it", style = MaterialTheme.typography.bodySmall) }
    ui.exportStatus?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
}

private fun fmt(value: Double) = String.format(Locale.US, "%.1f", value)
