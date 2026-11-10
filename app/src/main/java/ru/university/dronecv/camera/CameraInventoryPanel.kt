package ru.university.dronecv.camera

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.json.JSONArray

@Composable
internal fun CameraInventoryPanel(probe: CameraProbeState) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var json by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri: Uri? ->
        val data = json?.let { saved -> exportCameraInventory(saved, probe) }
        if (uri != null && data != null) scope.launch {
            error = try { withContext(Dispatchers.IO) {
                context.contentResolver.openOutputStream(uri)?.bufferedWriter()?.use { it.write(data) }
                    ?: error("Файл недоступен")
            }; "Инвентарь сохранён" } catch (e: Exception) { "Ошибка экспорта: ${e.message}" }
        }
    }
    Text("Камеры устройства", style = MaterialTheme.typography.titleSmall)
    Button(enabled = !busy, onClick = { scope.launch {
        busy = true
        try { json = withContext(Dispatchers.IO) { CameraInventory.collect(context).toString(2) }; error = null }
        catch (e: Exception) { json = null; error = "Не удалось получить камеры: ${e.message}" }
        finally { busy = false }
    } }, modifier = Modifier.fillMaxWidth().testTag("camera-inventory-refresh")) { Text(if (busy) "Получение…" else "Обновить список камер") }
    json?.let { data ->
        Text("Инвентаризация завершена; характеристики ниже. При экспорте текущий zoom и активный ID снимаются в момент сохранения.", style = MaterialTheme.typography.bodySmall)
        Text(data, style = MaterialTheme.typography.bodySmall)
        Button(onClick = { save.launch("camera-inventory.json") }, modifier = Modifier.fillMaxWidth().testTag("camera-inventory-export")) { Text("Экспорт камер JSON") }
    }
    error?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
}

/** Capture current state at export; null means unreported, not an absent lens. */
internal fun exportCameraInventory(saved: String, probe: CameraProbeState): String =
    JSONObject(saved).put("current_camera", JSONObject()
        .put("logical_id", probe.logicalId ?: JSONObject.NULL)
        .put("requested_physical_id", probe.physicalId ?: JSONObject.NULL)
        .put("active_physical_id", probe.activePhysicalId ?: JSONObject.NULL)
        .put("physical_ids", JSONArray(probe.physicalIds))
        .put("requested_zoom_ratio", probe.requestedZoom)
        .put("current_zoom_ratio", probe.actualZoom ?: JSONObject.NULL)
        .put("capture_zoom_ratio", probe.captureZoom ?: JSONObject.NULL)
        .put("switching", probe.loading)
        .put("warning", probe.warning ?: JSONObject.NULL)).toString(2)
