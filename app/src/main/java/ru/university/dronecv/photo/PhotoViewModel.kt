package ru.university.dronecv.photo

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import ru.university.dronecv.detection.DetectorWorker

/** Activity ownership retains the photo/results across rotation and mode switches. */
class PhotoViewModel(application: Application) : AndroidViewModel(application) {
    private val controller = PhotoController(AndroidPhotoBackend(application), DetectorWorker.dispatcher)
    val state = controller.state
    fun select(uri: String) = controller.select(uri)
    fun recognize() = controller.recognize()

    override fun onCleared() {
        controller.close()
    }
}
