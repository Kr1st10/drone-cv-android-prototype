package ru.university.dronecv.camera

import java.util.concurrent.Executors

/** Camera copying stays independent of the process-wide ORT worker. No frame queue is added here. */
object VisionWorker {
    val executor = Executors.newSingleThreadExecutor { task ->
        Thread(task, "drone-camera-input").apply { isDaemon = true }
    }
}
