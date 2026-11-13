package ru.university.dronecv.photo

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import ru.university.dronecv.detection.Detection
import ru.university.dronecv.detection.visibleDetections
import ru.university.dronecv.detection.yolo.ModelIntegrityException
import ru.university.dronecv.detection.yolo.ModelNotFoundException

/** No Android dependencies: request ownership and UI transitions are tested on the JVM. */
enum class PhotoPhase { IDLE, LOADING, READY, RUNNING, DETECTIONS, EMPTY, ERROR }
enum class PhotoError { ACCESS, IMAGE, MEMORY, MODEL_MISSING, MODEL_INTEGRITY, INFERENCE }

data class PhotoInference(val detections: List<Detection>, val inferenceMs: Double)

data class PhotoState<Image : Any>(
    val phase: PhotoPhase = PhotoPhase.IDLE,
    val image: Image? = null,
    val result: PhotoInference? = null,
    val error: PhotoError? = null,
) {
    val canRecognize: Boolean get() = image != null && phase != PhotoPhase.RUNNING
}

/** All calls, including close, are serialized on the worker. */
interface PhotoBackend<Image : Any> : AutoCloseable {
    fun load(uri: String): Image
    fun infer(image: Image): PhotoInference
    /** Only for a decoded image that was NEVER published to the renderer. */
    fun discard(image: Image)
}

/**
 * One worker and one conflated pending request bound memory and native ORT work.
 * Cancellation cannot interrupt a native inference; generation checks reject its late result instead.
 * Published images use GC ownership: recycling while the render thread still uses them is unsafe.
 */
class PhotoController<Image : Any>(
    private val backend: PhotoBackend<Image>,
    dispatcher: CoroutineDispatcher,
) : AutoCloseable {
    private val lock = Any()
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private val commands = Channel<Command<Image>>(Channel.CONFLATED)
    private val mutableState = MutableStateFlow(PhotoState<Image>())
    val state = mutableState.asStateFlow()
    private var generation = 0L
    private var closed = false

    // Enter try/finally before the first receive: close also works before the worker's first dispatch.
    private val worker = scope.launch(start = CoroutineStart.UNDISPATCHED) {
        try {
            for (command in commands) {
                if (!isCurrent(command.id)) continue
                try {
                    when (command) {
                        is Command.Load -> {
                            val image = backend.load(command.uri)
                            val published = publish(command.id, PhotoState(PhotoPhase.READY, image))
                            if (!published) backend.discard(image)
                        }
                        is Command.Infer -> {
                            val rawResult = backend.infer(command.image)
                            val result = rawResult.copy(detections = rawResult.detections.visibleDetections())
                            publish(command.id, PhotoState(
                                if (result.detections.isEmpty()) PhotoPhase.EMPTY else PhotoPhase.DETECTIONS,
                                command.image, result,
                            ))
                        }
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    fail(command, when (e) {
                        is SecurityException -> PhotoError.ACCESS
                        is ModelNotFoundException -> PhotoError.MODEL_MISSING
                        is ModelIntegrityException -> PhotoError.MODEL_INTEGRITY
                        else -> if (command is Command.Load) PhotoError.IMAGE else PhotoError.INFERENCE
                    })
                } catch (_: OutOfMemoryError) {
                    fail(command, PhotoError.MEMORY)
                }
            }
        } finally {
            backend.close()
        }
    }

    fun select(uri: String) = synchronized(lock) {
        if (closed) return@synchronized
        val id = ++generation
        mutableState.value = PhotoState(phase = PhotoPhase.LOADING)
        commands.trySend(Command.Load(id, uri))
        Unit
    }

    fun recognize() = synchronized(lock) {
        if (closed || !mutableState.value.canRecognize) return@synchronized
        val image = mutableState.value.image ?: return@synchronized
        val id = ++generation
        mutableState.value = PhotoState(PhotoPhase.RUNNING, image)
        commands.trySend(Command.Infer(id, image))
        Unit
    }

    private fun isCurrent(id: Long) = synchronized(lock) { !closed && generation == id }

    private fun publish(id: Long, value: PhotoState<Image>): Boolean = synchronized(lock) {
        if (closed || generation != id) false else {
            mutableState.value = value
            true
        }
    }

    private fun fail(command: Command<Image>, error: PhotoError) {
        val image = (command as? Command.Infer)?.image
        publish(command.id, PhotoState(PhotoPhase.ERROR, image, error = error))
    }

    override fun close() {
        synchronized(lock) {
            if (closed) return
            closed = true
            generation++
            mutableState.value = PhotoState()
        }
        commands.cancel()
        scope.cancel() // finally waits for any blocking native call, without blocking the UI thread.
    }

    private sealed class Command<Image : Any>(val id: Long) {
        class Load<Image : Any>(id: Long, val uri: String) : Command<Image>(id)
        class Infer<Image : Any>(id: Long, val image: Image) : Command<Image>(id)
    }
}
