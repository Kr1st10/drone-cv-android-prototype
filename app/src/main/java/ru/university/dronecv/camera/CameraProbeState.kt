package ru.university.dronecv.camera

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/** UI-thread state. A new selection rebinds Preview and Analysis as one viewport. */
internal class CameraProbeState {
    var selectionEpoch by mutableStateOf(0L)
    var requestedZoom by mutableFloatStateOf(1f)
    var physicalId by mutableStateOf<String?>(null)
    var logicalId by mutableStateOf<String?>(null)
    var activePhysicalId by mutableStateOf<String?>(null)
    var physicalIds by mutableStateOf<List<String>>(emptyList())
    var zoomRange by mutableStateOf<ZoomRange?>(null)
    var actualZoom by mutableStateOf<Float?>(null)
    var loading by mutableStateOf(false)
    var warning by mutableStateOf<String?>(null)
}
