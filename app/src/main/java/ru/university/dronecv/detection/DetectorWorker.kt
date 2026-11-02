package ru.university.dronecv.detection

import java.util.concurrent.Executors
import kotlinx.coroutines.asCoroutineDispatcher

/** One process-wide ML worker: Photo and Camera never run native inference concurrently.
 * The idle worker lives with the process; model sessions remain owned/closed by their backends.
 */
object DetectorWorker {
    val executor = Executors.newSingleThreadExecutor { task ->
        Thread(task, "drone-inference").apply { isDaemon = true }
    }
    val dispatcher = executor.asCoroutineDispatcher()
}
