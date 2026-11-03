package ru.university.dronecv.detection.onnx

/** Worker-confined, at most one owned session. Close before opening its replacement. */
internal class ThreadSessionManager<T : AutoCloseable>(
    initialThreads: Int = 2,
    private val open: (Int) -> T,
) : AutoCloseable {
    var threads: Int = initialThreads
        private set
    private var session: T? = null

    init { require(initialThreads in ALLOWED_THREADS) }

    fun session(): T = session ?: open(threads).also { session = it }

    /** Failure leaves the old setting selected, and attempts to reconstruct the old session. */
    fun switchTo(next: Int) {
        require(next in ALLOWED_THREADS)
        if (next == threads) return
        val previous = threads
        close() // An unsuccessful close must not be followed by creating another session.
        try {
            session = open(next)
            threads = next
        } catch (failure: Exception) {
            restore(previous, failure)
            throw failure
        } catch (failure: OutOfMemoryError) {
            restore(previous, failure)
            throw failure
        }
    }

    private fun restore(previous: Int, failure: Throwable) {
        try { session = open(previous) } catch (rollback: Exception) { failure.addSuppressed(rollback) }
        catch (rollback: OutOfMemoryError) { failure.addSuppressed(rollback) }
    }

    override fun close() {
        session?.close()
        session = null
    }

    companion object { val ALLOWED_THREADS = setOf(1, 2, 4) }
}
