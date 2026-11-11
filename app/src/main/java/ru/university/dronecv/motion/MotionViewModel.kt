package ru.university.dronecv.motion

import android.os.SystemClock
import androidx.lifecycle.ViewModel

class MotionViewModel : ViewModel() {
    val journal = MotionJournal(SystemClock::elapsedRealtimeNanos)
    var pendingExport: String? = null
}
