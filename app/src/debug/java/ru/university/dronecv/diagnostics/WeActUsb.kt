package ru.university.dronecv.diagnostics

import java.io.IOException
import kotlin.coroutines.AbstractCoroutineContextElement
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import ru.university.dronecv.weact.SerialIo

internal class UsbPermissionNotice(val show: (Boolean) -> Unit) : AbstractCoroutineContextElement(Key) {
    companion object Key : CoroutineContext.Key<UsbPermissionNotice>
}

internal suspend fun notifyUsbPermissionRequest(active: Boolean) { currentCoroutineContext()[UsbPermissionNotice]?.show?.invoke(active) }

internal enum class WeActUsbIssue { ABSENT, ACCESS_DENIED, PERMISSION_TIMEOUT, DETACHED, AMBIGUOUS }

internal class WeActUsbException(val issue: WeActUsbIssue) : IOException(issue.name)

internal class WeActConnection(
    val serial: SerialIo,
    /** Call only after detecting a detach and releasing [serial]. */
    val reopenAfterDetach: suspend () -> SerialIo,
)

internal interface WeActUsbDevice {
    val name: String
    fun permittedSerial(): String?
    suspend fun ensurePermission()
    fun open(observeAttachedCount: ((Int) -> Unit)? = null): SerialIo
}

internal class WeActUsb(private val attachedDevices: () -> List<WeActUsbDevice>) {
    suspend fun open(): WeActConnection {
        val attached = attachedDevices()
        val original = attached.minByOrNull { it.name } ?: throw WeActUsbException(WeActUsbIssue.ABSENT)
        original.ensurePermission()
        val originalSerial = original.permittedSerial()
        val peers = (attached + attachedDevices()).filter { it.name != original.name }
        val peerNames = peers.mapTo(mutableSetOf()) { it.name }
        val sharedSerial = originalSerial != null && peers.any { it.permittedSerial() == originalSerial }
        val reconnect = Reconnect(originalSerial, peerNames, sharedSerial)
        currentCoroutineContext().ensureActive()
        val observeAttached = if (originalSerial == null) reconnect::observeAttachedCount else null
        return WeActConnection(original.open(observeAttached), reconnect::open)
    }

    private inner class Reconnect(
        private val originalSerial: String?,
        private val peerNames: Set<String>,
        private val sharedSerial: Boolean,
    ) {
        private var sawMultipleWeAct = peerNames.isNotEmpty()

        fun observeAttachedCount(count: Int) {
            if (count > 1) sawMultipleWeAct = true
        }

        suspend fun open(): SerialIo {
            val attached = attachedDevices()
            if (attached.isEmpty()) throw WeActUsbException(WeActUsbIssue.ABSENT)
            observeAttachedCount(attached.size)
            val candidate = if (originalSerial == null) {
                // After a confirmed detach on a single-adapter bench, the operator returns the same adapter.
                if (sawMultipleWeAct) throw WeActUsbException(WeActUsbIssue.AMBIGUOUS)
                attached.single().also {
                    it.ensurePermission()
                    if (it.permittedSerial() != null) throw WeActUsbException(WeActUsbIssue.ABSENT)
                }
            } else {
                findBySerial(attached, originalSerial)
            }
            currentCoroutineContext().ensureActive()
            val current = attachedDevices()
            observeAttachedCount(current.size)
            if (originalSerial == null && sawMultipleWeAct) throw WeActUsbException(WeActUsbIssue.AMBIGUOUS)
            if (current.map { it.name }.toSet() != attached.map { it.name }.toSet()) {
                throw WeActUsbException(WeActUsbIssue.DETACHED)
            }
            val currentCandidate = current.singleOrNull { it.name == candidate.name }
                ?: throw WeActUsbException(WeActUsbIssue.DETACHED)
            if (currentCandidate.permittedSerial() != originalSerial) {
                throw WeActUsbException(WeActUsbIssue.DETACHED)
            }
            currentCoroutineContext().ensureActive()
            return currentCandidate.open()
        }

        private suspend fun findBySerial(attached: List<WeActUsbDevice>, serial: String): WeActUsbDevice {
            val matches = attached.filter { it.name !in peerNames }.filter {
                it.ensurePermission()
                it.permittedSerial() == serial
            }
            if (matches.isNotEmpty()) {
                val matchingPeer = attached.any { it.name in peerNames && it.permittedSerial() == serial }
                if (sharedSerial || matchingPeer || matches.size > 1) {
                    throw WeActUsbException(WeActUsbIssue.AMBIGUOUS)
                }
            }
            return matches.singleOrNull() ?: throw WeActUsbException(WeActUsbIssue.ABSENT)
        }
    }
}

internal class WeActReconnectTimeout : IOException("Timed out reopening WeAct USB")

internal suspend fun awaitWeActReconnect(
    timeoutMs: Long,
    pollMs: Long,
    nowMs: () -> Long,
    reopen: suspend () -> SerialIo,
): SerialIo {
    var deadline = nowMs() + timeoutMs
    var permissionStarted: Long? = null
    val parentNotice = currentCoroutineContext()[UsbPermissionNotice]
    var opened: SerialIo? = null
    try {
        withContext(UsbPermissionNotice { active ->
            val now = nowMs()
            if (active) permissionStarted = now
            else permissionStarted?.let { deadline += now - it; permissionStarted = null }
            parentNotice?.show?.invoke(active)
        }) {
            while (opened == null) {
                currentCoroutineContext().ensureActive()
                if (deadline - nowMs() <= 0) throw WeActReconnectTimeout()
                try {
                    opened = reopen()
                } catch (error: WeActUsbException) {
                    if (error.issue != WeActUsbIssue.ABSENT && error.issue != WeActUsbIssue.DETACHED) throw error
                    val remaining = deadline - nowMs()
                    if (remaining <= 0) throw WeActReconnectTimeout()
                    delay(minOf(pollMs, remaining))
                }
            }
        }
        currentCoroutineContext().ensureActive()
        return checkNotNull(opened).also { opened = null }
    } finally {
        opened?.close()
    }
}
