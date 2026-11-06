package ru.university.dronecv.camera

data class PreparedLiveFrame<Frame : AutoCloseable>(val frame: Frame, val preparationMs: Double)

/** Transfers an owned snapshot only after closing the camera frame, including on copy/close failure. */
class LiveFrameCapture<Input : AutoCloseable, Snapshot : AutoCloseable>(
    private val controller: LiveController<Snapshot>,
    private val prepare: (Input) -> PreparedLiveFrame<Snapshot>?,
) {
    fun analyze(frame: Input, sourceId: Long, stamp: FrameStamp) {
        var token: LiveFrameToken? = null
        var prepared: PreparedLiveFrame<Snapshot>? = null
        try {
            try {
                token = controller.beginFrame(sourceId, stamp)
                if (token == null) return
                prepared = prepare(frame)
                if (prepared == null) controller.noFrameBuffer(checkNotNull(token))
            } finally {
                frame.close()
            }
            val ready = prepared ?: return
            prepared = null
            controller.offerFrame(ready.frame, checkNotNull(token), stamp, ready.preparationMs)
        } catch (e: Exception) {
            token?.let { controller.captureFailed(it, e.message ?: e.javaClass.simpleName) }
        } catch (_: OutOfMemoryError) {
            token?.let { controller.captureFailed(it, "Недостаточно памяти для копирования кадра.") }
        } finally {
            prepared?.frame?.close()
        }
    }
}
