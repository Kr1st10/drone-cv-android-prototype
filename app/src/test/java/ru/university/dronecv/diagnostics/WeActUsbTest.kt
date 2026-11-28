package ru.university.dronecv.diagnostics

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test
import ru.university.dronecv.weact.ClassicStreamProfile
import ru.university.dronecv.weact.SerialIo
import ru.university.dronecv.weact.SlcanDjiRsTransport

class WeActUsbTest {
    @Test fun permissionWaitDoesNotConsumeReconnectDeadline() = runBlocking {
        var clock = 1_000L
        var attempts = 0
        val entered = CompletableDeferred<Unit>()
        val grant = CompletableDeferred<Unit>()
        val notices = mutableListOf<Boolean>()
        val port = IdlePort()
        val result = async {
            withContext(UsbPermissionNotice { notices += it }) {
                awaitWeActReconnect(10_000, 1, { clock }) {
                    attempts++
                    if (attempts == 1) {
                        notifyUsbPermissionRequest(true)
                        entered.complete(Unit)
                        try { grant.await() } finally { notifyUsbPermissionRequest(false) }
                        throw WeActUsbException(WeActUsbIssue.ABSENT)
                    }
                    port
                }
            }
        }
        withTimeout(1_000) { entered.await() }
        clock += 12_000
        assertEquals(listOf(true), notices)
        assertTrue(result.isActive)
        grant.complete(Unit)
        assertSame(port, withTimeout(1_000) { result.await() })
        assertEquals(listOf(true, false), notices)
        assertEquals(2, attempts)
    }

    @Test fun reconnectPropagatesPermissionFailuresAndCancellation() = runBlocking {
        for (issue in listOf(WeActUsbIssue.ACCESS_DENIED, WeActUsbIssue.PERMISSION_TIMEOUT)) {
            val error = assertThrows(WeActUsbException::class.java) {
                runBlocking { awaitWeActReconnect(10_000, 1, { 0 }) { throw WeActUsbException(issue) } }
            }
            assertEquals(issue, error.issue)
        }
        val waiting = CompletableDeferred<Unit>()
        val cancelled = CompletableDeferred<Unit>()
        val task = async {
            awaitWeActReconnect(10_000, 1, { 0 }) {
                notifyUsbPermissionRequest(true)
                waiting.complete(Unit)
                try { CompletableDeferred<Unit>().await() } finally { cancelled.complete(Unit) }
                IdlePort()
            }
        }
        withTimeout(1_000) { waiting.await() }
        task.cancelAndJoin()
        assertTrue(cancelled.isCompleted)
    }

    @Test fun skipsKnownPeerAndMatchesSerialAfterPermissionOnNewDeviceName() {
        val original = Device("001", "original")
        val other = Device("002", "other")
        var devices = listOf(original, other)
        val connection = runBlocking { WeActUsb { devices }.open() }
        connection.serial.close()

        devices = listOf(other)
        assertReopenIssue(connection, WeActUsbIssue.ABSENT)
        val returned = Device("003", "original")
        devices = listOf(other, returned)
        runBlocking { connection.reopenAfterDetach().use { assertSame(returned.port, it) } }
        assertEquals(1, returned.opens)
        assertEquals(0, other.permissionRequests)
        assertEquals(0, other.opens)
    }

    @Test fun refusesAnotherSerialEvenWhenItHasAnUnseenDeviceName() {
        val original = Device("001", "original")
        var devices = listOf(original)
        val connection = runBlocking { WeActUsb { devices }.open() }
        connection.serial.close()

        val different = Device("002", "different")
        devices = listOf(different)
        assertReopenIssue(connection, WeActUsbIssue.ABSENT)
        assertEquals(1, different.permissionRequests)
        assertEquals(0, different.opens)
    }

    @Test fun rejectsReplacementAtSameNameAfterPermission() {
        val original = Device("001", "original")
        var devices: List<WeActUsbDevice> = listOf(original)
        val connection = runBlocking { WeActUsb { devices }.open() }
        connection.serial.close()
        val replacement = Device("002", "different")
        val candidate = object : WeActUsbDevice {
            override val name = "002"
            override fun permittedSerial() = "original"
            override suspend fun ensurePermission() { devices = listOf(replacement) }
            override fun open(observeAttachedCount: ((Int) -> Unit)?): SerialIo = error("stale device opened")
        }
        devices = listOf(candidate)
        assertReopenIssue(connection, WeActUsbIssue.DETACHED)
        assertEquals(0, replacement.opens)
    }

    @Test fun refusesDuplicateSerialsWithoutOpeningEitherCandidate() {
        val original = Device("001", "same")
        var devices = listOf(original)
        val connection = runBlocking { WeActUsb { devices }.open() }
        connection.serial.close()

        val first = Device("002", "same")
        val second = Device("003", "same")
        devices = listOf(first, second)
        assertReopenIssue(connection, WeActUsbIssue.AMBIGUOUS)
        assertEquals(0, first.opens)
        assertEquals(0, second.opens)
    }

    @Test fun singleWeActWithoutSerialCanReturnAfterTheUsbListWasEmpty() {
        val original = Device("001", null)
        var devices = listOf(original)
        val connection = runBlocking { WeActUsb { devices }.open() }
        connection.serial.close()

        devices = emptyList()
        assertReopenIssue(connection, WeActUsbIssue.ABSENT)
        val returned = Device("004", null)
        devices = listOf(returned)
        runBlocking { connection.reopenAfterDetach().use { assertSame(returned.port, it) } }
        assertEquals(1, returned.opens)
    }

    @Test fun fastReconnectWithoutSerialOpensOnceAndReadsOnlyTheNewAttitudeSequence() {
        val original = Device("001", null, object : IdlePort() {
            override fun read(timeoutNs: Long): ByteArray? = throw WeActUsbException(WeActUsbIssue.DETACHED)
        })
        val port = FollowupPort()
        val returned = Device("004", null, port)
        var devices = listOf(original)
        val connection = runBlocking { WeActUsb { devices }.open() }
        devices = listOf(returned)
        val detached = assertThrows(WeActUsbException::class.java) {
            connection.serial.use { it.read(1) }
        }
        assertEquals(WeActUsbIssue.DETACHED, detached.issue)

        runBlocking {
            connection.reopenAfterDetach().use { serial ->
                val profile = ClassicStreamProfile(bitrate = 1_000_000, txId = 0x223, rxId = 0x222)
                SlcanDjiRsTransport(serial, profile, 2_000_000_000L).use { transport ->
                    transport.open()
                    assertEquals(-177.6, readDjiTurnFollowup(transport, 0x1234, System::nanoTime).yawDegrees, 0.0)
                }
            }
        }

        assertEquals(1, returned.opens)
        assertEquals(listOf("C", "H0", "M0", "S8", "O") + followupRequest + "C", port.writes)
        assertEquals(1, port.closes)
    }

    @Test fun refusesLoneCandidateIfASecondWeActWasObservedDuringExchange() {
        val original = Device("001", null)
        val second = Device("002", null)
        var devices = listOf(original)
        val connection = runBlocking { WeActUsb { devices }.open() }
        devices = listOf(original, second)
        original.reportAttachedCount(devices.size)
        connection.serial.close()

        devices = listOf(second)
        assertReopenIssue(connection, WeActUsbIssue.AMBIGUOUS)
        assertEquals(0, second.opens)
        assertEquals(0, second.permissionRequests)
    }

    private fun assertReopenIssue(connection: WeActConnection, issue: WeActUsbIssue) {
        val error = assertThrows(WeActUsbException::class.java) {
            runBlocking { connection.reopenAfterDetach().close() }
        }
        assertEquals(issue, error.issue)
    }

    private class Device(
        override val name: String,
        private val serial: String?,
        val port: SerialIo = IdlePort(),
    ) : WeActUsbDevice {
        private var attachedCountObserver: ((Int) -> Unit)? = null
        var permissionRequests = 0
            private set
        var opens = 0
            private set

        override fun permittedSerial(): String? = serial.takeIf { permissionRequests > 0 }

        override suspend fun ensurePermission() {
            permissionRequests++
        }

        override fun open(observeAttachedCount: ((Int) -> Unit)?): SerialIo {
            check(permissionRequests > 0)
            attachedCountObserver = observeAttachedCount
            opens++
            return port
        }

        fun reportAttachedCount(count: Int) = checkNotNull(attachedCountObserver)(count)
    }

    private open class IdlePort : SerialIo {
        override fun read(timeoutNs: Long): ByteArray? = error("Unexpected read")
        override fun write(bytes: ByteArray, timeoutNs: Long) = error("Unexpected write")
        override fun close() = Unit
    }

    private class FollowupPort : SerialIo {
        val writes = mutableListOf<String>()
        var closes = 0
            private set
        private var reply: ByteArray? = null

        override fun read(timeoutNs: Long): ByteArray? = reply.also { reply = null }

        override fun write(bytes: ByteArray, timeoutNs: Long) {
            val command = bytes.toString(Charsets.US_ASCII).removeSuffix("\r")
            writes += command
            reply = (if (command == followupRequest.last()) followupReply + "\r" else "\r")
                .toByteArray(Charsets.US_ASCII)
        }

        override fun close() {
            closes++
        }
    }

    private companion object {
        val followupRequest = listOf("t2238AA13000300000000", "t2238371286830E0201B2", "t223359E1CF")
        const val followupReply = "t2228AA1A002000000000\rt22283712FE110E020001\rt222810F90A00F8FF828D\rt2222C389\r"
    }
}
