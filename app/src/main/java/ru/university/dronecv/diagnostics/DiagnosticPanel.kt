package ru.university.dronecv.diagnostics

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.util.Locale

@Composable
fun DiagnosticPanel(model: DiagnosticViewModel, liveReady: Boolean, confidence: Float) {
    val ui by model.ui.collectAsStateWithLifecycle()
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
        if (uri != null) model.export(uri)
    }
    Text("Диагностика", style = MaterialTheme.typography.titleSmall)
    if (ui.recording) {
        Text("Сессия идёт. При фоне или выключении экрана она будет помечена прерванной.", style = MaterialTheme.typography.bodySmall)
        Button(onClick = { model.stop() }, modifier = Modifier.fillMaxWidth().testTag("diagnostic-stop")) { Text("Завершить сессию") }
    } else {
        Button(onClick = { model.start(confidence) }, enabled = liveReady,
            modifier = Modifier.fillMaxWidth().testTag("diagnostic-start")) { Text("Начать сессию") }
        if (!liveReady) Text("Сначала запустите детекцию и дождитесь кадра.", style = MaterialTheme.typography.bodySmall)
    }
    ui.report?.let { report ->
        val f = report.frames
        val fps = f.processedFps?.let { String.format(Locale.US, "%.2f", it) } ?: "—"
        Text("${if (f.interrupted) "Прервана: ${f.reason}" else "Завершена"} · ${f.completedFrames} кадров · $fps FPS\nДлительность: ${f.durationNanos / 1_000_000_000} с; отброшенные камерой неизвестны.",
            style = MaterialTheme.typography.bodySmall)
        Button(onClick = { save.launch("drone-performance-${report.startEpochMs}.json") },
            modifier = Modifier.fillMaxWidth().testTag("diagnostic-export")) { Text("Экспорт JSON") }
    }
    ui.exportStatus?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
}
