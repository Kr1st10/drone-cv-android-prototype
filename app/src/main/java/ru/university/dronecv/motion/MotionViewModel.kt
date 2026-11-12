package ru.university.dronecv.motion

import android.app.Application
import android.os.SystemClock
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import ru.university.dronecv.journals.JournalArchive
import ru.university.dronecv.journals.JournalArchives
import ru.university.dronecv.journals.JournalKind

class MotionViewModel(app: Application) : AndroidViewModel(app) {
    val journal = MotionJournal(SystemClock::elapsedRealtimeNanos, requiresReservation = true)
    private val archive = JournalArchives.get(app)
    private val mutableStarting = MutableStateFlow(false)
    val starting = mutableStarting.asStateFlow()
    private val mutableIssue = MutableStateFlow<String?>(null)
    val issue = mutableIssue.asStateFlow()

    fun start(activate: () -> Unit) {
        if (mutableStarting.value || journal.ui.value.recording) return
        mutableStarting.value = true; mutableIssue.value = null
        val revision = journal.preparationToken()
        viewModelScope.launch(Dispatchers.IO) {
            var reservation: JournalArchive.Recording? = null
            try {
                reservation = archive.reserve(JournalKind.MOTION)
                val selected = reservation
                withContext(Dispatchers.Main.immediate) {
                    if (journal.prepareRecording(selected, revision)) {
                        try { activate() } finally { journal.cancelPreparation() }
                    }
                }
            } catch (e: Exception) { mutableIssue.value = "Запись не началась: ${e.message}" }
            finally { reservation?.close(); mutableStarting.value = false }
        }
    }
    override fun onCleared() { journal.stop("ViewModel destroyed"); super.onCleared() }
}
