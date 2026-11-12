package ru.university.dronecv.motion

import android.app.Application
import android.os.SystemClock
import androidx.lifecycle.AndroidViewModel
import java.io.File
import java.util.UUID

class MotionViewModel(app: Application) : AndroidViewModel(app) {
    val journal = MotionJournal(SystemClock::elapsedRealtimeNanos, fileFactory = {
        File(app.filesDir, "motion-${UUID.randomUUID()}.ndjson")
    })
    var pendingExport: File? = null
}
