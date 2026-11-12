package ru.university.dronecv.journals

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import java.text.DateFormat
import java.util.Date

/** Native Material controls, textual states and a scrollable list independent of the camera viewport. */
@Composable
fun JournalArchiveScreen(model: JournalArchiveViewModel) {
    val ui by model.ui.collectAsStateWithLifecycle(context = Dispatchers.Main.immediate)
    var deleting by rememberSaveable { mutableStateOf<String?>(null) }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/x-ndjson"), model::export)
    LaunchedEffect(model) { while (true) { model.refresh().join(); delay(1000) } }
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Сохранённые журналы", style = MaterialTheme.typography.titleLarge)
        Text("Допуск новой записи: до ${model.policy.maxRecords} журналов и ${model.policy.maxBytes / (1024 * 1024)} МиБ вместе с метаданными.",
            style = MaterialTheme.typography.bodySmall)
        ui.inventory?.let { inventory ->
            Text("${inventory.entries.size} записей · ${inventory.bytes} байт", Modifier.testTag("archive-total"))
            if (inventory.overQuota) Text("Лимит архива достигнут. Уже начатые записи не обрезаются; для новой освободите место.")
            if (inventory.entries.isEmpty()) Text("Сохранённых журналов пока нет.", Modifier.testTag("archive-empty"))
            LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(inventory.entries, key = { it.id }) { entry ->
                    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(entry.id, style = MaterialTheme.typography.bodyMedium)
                        Text("${if (entry.kind == JournalKind.DIAGNOSTIC) "Диагностика" else "Стенд движения"} · ${entry.bytes} байт")
                        Text(entry.createdEpochMs?.let { "Время создания: ${DateFormat.getDateTimeInstance().format(Date(it))}" }
                            ?: "Время создания неизвестно", style = MaterialTheme.typography.bodySmall)
                        Text(when (entry.state) {
                            JournalState.RECORDING -> "Выполняется запись"
                            JournalState.FINISHING -> "Запись завершается"
                            JournalState.COMPLETE -> "Запись завершена"
                            JournalState.INCOMPLETE_OR_UNKNOWN -> "Запись неполна или её полнота неизвестна"
                        })
                        Text(if (entry.exported) "Успешный экспорт подтверждён" else "Успешный экспорт не подтверждён")
                        if (entry.inUse) Text("Журнал используется; удаление недоступно")
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = { model.select(entry.id) { save.launch(it) } },
                                enabled = !ui.busy && entry.state !in setOf(JournalState.RECORDING, JournalState.FINISHING),
                                modifier = Modifier.weight(1f).testTag("archive-export-${entry.id}")) { Text("Экспорт") }
                            TextButton(onClick = { if (entry.exported) model.delete(entry.id, false) else deleting = entry.id },
                                enabled = !ui.busy && !entry.inUse,
                                modifier = Modifier.weight(1f).testTag("archive-delete-${entry.id}")) { Text("Удалить") }
                        }
                        HorizontalDivider()
                    }
                }
            }
        } ?: Text(if (ui.loadError == null) "Загрузка журналов…" else "Список журналов недоступен")
        ui.message?.let { Text(it) }
        (ui.error ?: ui.loadError)?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        if (ui.loadError != null) TextButton(onClick = { model.refresh() }) { Text("Обновить список") }
    }
    deleting?.let { id ->
        AlertDialog(onDismissRequest = { deleting = null }, title = { Text("Удалить неэкспортированный журнал?") },
            text = { Text("Для $id нет подтверждённого экспорта. Данные будут удалены с устройства.") },
            confirmButton = { TextButton(onClick = { deleting = null; model.delete(id, true) }) { Text("Удалить журнал") } },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("Сохранить") } })
    }
}
