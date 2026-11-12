package ru.university.dronecv

import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import ru.university.dronecv.journals.JournalArchiveScreen
import ru.university.dronecv.journals.JournalArchiveViewModel
import ru.university.dronecv.camera.CameraScreen
import ru.university.dronecv.photo.PhotoScreen
import ru.university.dronecv.photo.PhotoViewModel

@Composable
fun DroneApp() {
    var mode by rememberSaveable { mutableIntStateOf(0) }
    var cameraConfidence by rememberSaveable { mutableFloatStateOf(0.5f) }
    var cameraThreads by rememberSaveable { mutableIntStateOf(2) }
    val photos: PhotoViewModel = viewModel()
    val archive: JournalArchiveViewModel = viewModel()
    Scaffold(topBar = {
        Column(Modifier.statusBarsPadding()) {
            Text(stringResource(R.string.app_name), Modifier.padding(horizontal = 20.dp, vertical = 12.dp),
                style = MaterialTheme.typography.titleLarge)
            TabRow(selectedTabIndex = mode) {
                Tab(selected = mode == 0, onClick = { mode = 0 }, text = { Text(stringResource(R.string.mode_photo)) })
                Tab(selected = mode == 1, onClick = { mode = 1 }, text = { Text(stringResource(R.string.mode_camera)) })
                Tab(selected = mode == 2, onClick = { mode = 2 }, text = { Text("Журналы") })
            }
        }
    }) { insets ->
        androidx.compose.foundation.layout.Box(Modifier.fillMaxSize().padding(insets).consumeWindowInsets(insets)) {
            when (mode) {
                0 -> PhotoScreen(photos)
                1 -> CameraScreen(cameraConfidence, cameraThreads, { cameraThreads = it },
                    onOpenJournals = { mode = 2 }) { cameraConfidence = it }
                else -> JournalArchiveScreen(archive)
            }
        }
    }
}
