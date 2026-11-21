package ru.university.dronecv.qnn

import android.app.Application
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.dp
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import ru.university.dronecv.detection.DetectorWorker

internal data class BenchmarkUiState(
    val mode: BenchmarkMode = BenchmarkMode.CPU,
    val sustained: Boolean = false,
    val sustainedBackend: BenchmarkProvider = BenchmarkProvider.CPU,
    val targetFps: Int = 2,
    val photos: List<Uri> = emptyList(),
    val progress: String? = null,
    val report: BenchmarkReport? = null,
    val exportMessage: String? = null,
)

internal class QnnBenchmarkViewModel(private val app: Application) : AndroidViewModel(app) {
    private val mutableState = MutableStateFlow(BenchmarkUiState())
    val state = mutableState.asStateFlow()
    private val runner = QnnBenchmark.Runner(app)
    private var runJob: Job? = null
    private var sustainedStop: AtomicBoolean? = null

    fun selectMode(mode: BenchmarkMode) = mutableState.update { it.copy(mode = mode) }
    fun selectSustained(value: Boolean) = mutableState.update { it.copy(sustained = value) }
    fun selectBackend(backend: BenchmarkProvider) = mutableState.update { it.copy(sustainedBackend = backend) }
    fun selectRate(fps: Int) = mutableState.update { it.copy(targetFps = fps) }

    fun selectPhotos(uris: List<Uri>) {
        if (uris.isNotEmpty()) mutableState.update { it.copy(photos = uris.distinct()) }
    }

    fun start(coldHtp: Boolean = false) {
        val current = state.value
        if (current.progress != null || current.photos.isEmpty()) return
        if (current.sustained && current.photos.size > MAX_SUSTAINED_PHOTOS) return
        val stop = if (current.sustained) AtomicBoolean() else null
        sustainedStop = stop
        mutableState.update { it.copy(progress = "Подготовка", exportMessage = null) }
        runJob = viewModelScope.launch {
            try {
                val report = withContext(DetectorWorker.dispatcher) {
                    val progress: (String) -> Unit = { message ->
                        mutableState.update { if (stop?.get() == true) it else it.copy(progress = message) }
                    }
                    if (stop != null) {
                        runner.runSustained(current.photos, current.sustainedBackend, current.targetFps, stop::get,
                            checkActive = { ensureActive() }, progress = progress)
                    } else {
                        runner.run(current.photos, current.mode, coldHtp,
                            checkActive = { ensureActive() }, progress = progress)
                    }
                }
                mutableState.update { it.copy(report = report) }
            } catch (e: CancellationException) {
                withContext(NonCancellable) {
                    val failure = withContext(DetectorWorker.dispatcher) { runner.releaseHtp() }
                    mutableState.update { it.copy(exportMessage = failure ?: "Прогон отменён.") }
                }
                throw e
            } finally {
                sustainedStop = null
                mutableState.update { it.copy(progress = null) }
            }
        }
    }

    fun cancel() {
        val running = runJob ?: return
        if (!running.isActive) return
        val stop = sustainedStop
        if (stop == null) running.cancel() else stop.set(true)
        mutableState.update { it.copy(progress = "Отмена…") }
    }

    fun releaseHtp() {
        DetectorWorker.executor.execute { runner.releaseHtp() }
    }

    override fun onCleared() {
        releaseHtp()
    }

    fun export(uri: Uri) {
        val report = state.value.report ?: return
        viewModelScope.launch {
            val message = try {
                withContext(Dispatchers.IO) {
                    val stream = app.contentResolver.openOutputStream(uri, "wt")
                        ?: throw IOException("Не удалось открыть файл")
                    stream.bufferedWriter(Charsets.UTF_8).use { it.write(report.json) }
                }
                "Отчёт сохранён."
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                "Ошибка экспорта. ${e.message.orEmpty()}"
            }
            mutableState.update { it.copy(exportMessage = message) }
        }
    }
}

@Composable
internal fun QnnBenchmarkScreen(model: QnnBenchmarkViewModel) {
    val state by model.state.collectAsStateWithLifecycle()
    val picker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(),
        model::selectPhotos,
    )
    val export = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) {
        if (it != null) model.export(it)
    }
    val idle = state.progress == null
    val sustainedRunning = state.sustained && !idle
    val view = LocalView.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    if (sustainedRunning) {
        DisposableEffect(view, lifecycle) {
            val wasKeepingScreenOn = view.keepScreenOn
            view.keepScreenOn = true
            val observer = LifecycleEventObserver { _, event ->
                if (event == Lifecycle.Event.ON_STOP) model.cancel()
            }
            lifecycle.addObserver(observer)
            onDispose {
                lifecycle.removeObserver(observer)
                view.keepScreenOn = wasKeepingScreenOn
            }
        }
    }
    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        item {
            Column(Modifier.padding(top = 12.dp)) {
                Text("Сравнение на сохранённых кадрах", style = MaterialTheme.typography.titleMedium)
                Text("YOLO11s · 640×640 · порог > 0,50")
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(!state.sustained, { model.selectSustained(false) }, { Text("Короткий") }, enabled = idle)
                    FilterChip(state.sustained, { model.selectSustained(true) }, { Text("15 минут") }, enabled = idle)
                }
                if (state.sustained) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        BenchmarkProvider.entries.forEach { backend ->
                            FilterChip(state.sustainedBackend == backend, { model.selectBackend(backend) },
                                { Text(backend.title) }, enabled = idle)
                        }
                    }
                    Text("Заданная частота, кадр/с")
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        SUSTAINED_RATES.forEach { fps ->
                            FilterChip(state.targetFps == fps, { model.selectRate(fps) },
                                { Text(fps.toString()) }, enabled = idle)
                        }
                    }
                } else {
                    BenchmarkMode.entries.forEach { mode ->
                        FilterChip(state.mode == mode, { model.selectMode(mode) }, { Text(mode.title) }, enabled = idle)
                    }
                }
                Text("Выбрано кадров: ${state.photos.size}")
                val withinLimit = !state.sustained || state.photos.size <= MAX_SUSTAINED_PHOTOS
                if (!withinLimit) Text("Для длительного прогона выберите до $MAX_SUSTAINED_PHOTOS кадров.")
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(
                        onClick = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                        enabled = idle,
                    ) { Text("Выбрать кадры") }
                    Button(onClick = { model.start() }, enabled = idle && state.photos.isNotEmpty() && withinLimit) {
                        Text("Запустить")
                    }
                }
                if (!state.sustained && BenchmarkProvider.HTP in state.mode.providers) {
                    OutlinedButton(onClick = { model.start(coldHtp = true) }, enabled = idle && state.photos.isNotEmpty()) {
                        Text("Холодный запуск HTP")
                    }
                }
            }
        }
        state.progress?.let { progress ->
            item {
                Text(progress)
                OutlinedButton(onClick = model::cancel) { Text("Отменить прогон") }
            }
        }
        if (idle) state.exportMessage?.let { message -> item { Text(message) } }
        state.report?.takeIf { idle }?.let { report ->
            item {
                OutlinedButton(onClick = { export.launch(report.fileName) }) { Text("Сохранить JSON") }
            }
            items(report.sections) { section ->
                Text(section)
                HorizontalDivider(Modifier.padding(top = 8.dp))
            }
        }
    }
}
