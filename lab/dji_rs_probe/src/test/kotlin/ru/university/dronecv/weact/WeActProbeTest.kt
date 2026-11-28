package ru.university.dronecv.weact

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import ru.university.dronecv.gimbal.DjiRsAttitudeExchange.Event.REQUEST_SENT
import ru.university.dronecv.gimbal.DjiRsAttitudeExchange.Event.RESPONSE_RECEIVED
import ru.university.dronecv.gimbal.DjiRsAttitudeExchange.Operation
import ru.university.dronecv.gimbal.DjiRsAttitudeExchange.Outcome
import ru.university.dronecv.gimbal.DjiRsAttitudeReader
import ru.university.dronecv.gimbal.DjiRsAttitudeReply
import java.io.IOException

class WeActProbeTest {
    @Test fun adapterInfoQueriesOnlyVersionAndHandlesALineSplitAcrossReads() {
        val serial = FakeSerial(Turn("V\r", listOf("WeAct Stu", "dio V1.0.0.3_bb264e71\r")))
        val output = mutableListOf<String>()
        val status = runProbe(
            arrayOf("adapter-info", "--port", "/dev/cu.usbmodem-test"),
            openPort = { serial },
            nowNs = serial::now,
            output = { output += it },
        )
        assertEquals(0, status)
        assertEquals(listOf("WeAct Studio V1.0.0.3_bb264e71"), output)
        assertTrue(serial.closed)
        serial.assertComplete()
    }

    @Test fun readAttitudeWithoutExplicitCanParametersDoesNotOpenThePort() {
        val errors = mutableListOf<String>()
        val result = runProbe(
            arrayOf("read-attitude", "--port", "/dev/cu.usbmodem-test"),
            openPort = { error("Should not open a port without a CAN profile") },
            error = { errors += it },
        )
        assertEquals(2, result)
        assertEquals("Specify --profile", errors.first())
    }

    @Test fun reassemblesTheReplyThatArrivesBeforeTheLastAcknowledgement() {
        val serial = session(
            Turn(TX_LAST, listOf(
                "t3228AA1A0020",
                "00000000\rt1114AABBCCDD\rt32283412FEE10E020001\r",
                "t3228FBF87B0081FC3859\rt3222F589\r\r",
            )),
        )
        val result = runExchange(serial)

        assertEquals(listOf(REQUEST_SENT, RESPONSE_RECEIVED), result.events)
        assertEquals(Outcome.Reply(DjiRsAttitudeReply.Angles(-179.7, 12.3, -89.5)), result.outcome)
        serial.assertComplete()
    }

    @Test fun firmwareThatRejectsH0CanReadAttitudeInTextMode() {
        val serial = FakeSerial(
            ack("C"), Turn("H0\r", listOf("\u0007")), ack("M0"), ack("S6"), ack("O"),
            Turn(TX_FIRST, listOf("\r")), Turn(TX_MIDDLE, listOf("\r")),
            Turn(TX_LAST, listOf(
                "\rt3228AA1A002000000000\rt32283412FEE10E020001\rt3228FBF87B0081FC3859\rt3222F589\r",
            )),
            ack("C"),
        )

        val result = runExchange(serial)

        assertEquals(Outcome.Reply(DjiRsAttitudeReply.Angles(-179.7, 12.3, -89.5)), result.outcome)
        serial.assertComplete()
    }

    @Test fun rejectedNormalModeStopsBeforeOpeningCan() {
        val serial = FakeSerial(ack("C"), ack("H0"), Turn("M0\r", listOf("\u0007")))
        val errors = mutableListOf<String>()
        val status = runProbe(
            nudgeArgs("yaw", "positive"),
            openPort = { serial },
            nowNs = serial::now,
            error = { errors += it },
        )

        assertEquals(1, status)
        assertEquals(listOf("WeAct rejected SLCAN command M"), errors)
        assertTrue(serial.closed)
        serial.assertComplete()
    }

    @Test fun missingTailTimesOutWithoutExtendingTheReceiveBudget() {
        val serial = session(Turn(TX_LAST, listOf("\rt3228AA1A002000000000\r", "t32283412FEE10E020001\r")))
        val result = runExchange(serial)

        assertEquals(listOf(REQUEST_SENT), result.events)
        assertEquals(Outcome.Timeout, result.outcome)
        assertEquals(100L, serial.now())
        serial.assertComplete()
    }

    @Test fun adapterDisconnectWhileReceivingIsATransportError() {
        val failure = IOException("simulated USB disconnect")
        val serial = session(Turn(TX_LAST, listOf("\r"), readFailure = failure))
        val result = runExchange(serial)

        assertEquals(listOf(REQUEST_SENT), result.events)
        val transportError = result.outcome as Outcome.TransportError
        assertEquals(Operation.RECEIVE, transportError.operation)
        assertSame(failure, transportError.cause)
        serial.assertComplete()
    }

    @Test fun aRejectedFragmentDoesNotCountAsACompleteRequest() {
        val serial = session(Turn(TX_LAST, listOf("\u0007")))
        val result = runExchange(serial)

        assertTrue(result.events.isEmpty())
        val transportError = result.outcome as Outcome.TransportError
        assertEquals(Operation.WRITE, transportError.operation)
        assertTrue(transportError.cause.message.orEmpty().contains("rejected"))
        serial.assertComplete()
    }

    @Test fun aMissingAcknowledgementConsumesOnlyTheOriginalWriteBudget() {
        val serial = FakeSerial(*SETUP.toTypedArray(),
            Turn(TX_FIRST, listOf("\r"), delayNs = 45),
            Turn(TX_MIDDLE, listOf("\r"), delayNs = 45),
            Turn(TX_LAST, emptyList()),
            ack("C"),
        )
        val result = runExchange(serial)

        assertTrue(result.events.isEmpty())
        val transportError = result.outcome as Outcome.TransportError
        assertEquals(Operation.WRITE, transportError.operation)
        assertEquals(100L, serial.now())
        serial.assertComplete()
    }

    @Test fun nudgeYawsOnceAndVerifiesTheAngleAcrossWrap() {
        val serial = nudgeSession(
            sdk(READ_0, BEFORE_YAW),
            sdk(MOVE_YAW, STALE_ACK, MOVE_ACK),
            sdk(READ_1, AFTER_YAW),
            sdk(READ_2, SETTLED_YAW),
        )

        val result = runNudge(serial, "yaw", "positive")

        assertEquals(0, result.status)
        assertEquals(listOf(1250L, 350L), result.pauses)
        assertTrue(result.output.contains("delta_deg yaw=3.0 roll=0.0 pitch=0.0"))
        assertTrue(result.output.contains("drift_deg yaw=0.1 roll=0.0 pitch=0.0"))
        assertEquals("nudge_pass", result.output.last())
        assertTrue(result.errors.isEmpty())
        serial.assertComplete()
    }

    @Test fun nudgePitchesOnlyInTheRequestedDirection() {
        val serial = nudgeSession(
            sdk(READ_0, BEFORE_YAW),
            sdk(MOVE_PITCH, MOVE_ACK),
            sdk(READ_1, AFTER_PITCH),
            sdk(READ_2, SETTLED_PITCH),
        )

        val result = runNudge(serial, "pitch", "negative")

        assertEquals(0, result.status)
        assertTrue(result.output.contains("delta_deg yaw=0.0 roll=0.0 pitch=-3.0"))
        serial.assertComplete()
    }

    @Test fun nudgeWithoutBaselineSendsOnlyTheReadRequest() {
        val serial = nudgeSession(sdk(READ_0))

        val result = runNudge(serial, "yaw", "positive")

        assertEquals(1, result.status)
        assertEquals(listOf("DJI attitude unavailable at before"), result.errors)
        assertTrue(result.pauses.isEmpty())
        serial.assertComplete()
    }

    @Test fun nudgeDoesNotRepeatAfterARejectedMissingOrCorruptReply() {
        val corruptAck = MOVE_ACK.dropLast(2) + "00"
        val cases = listOf(
            emptyArray<String>() to "No DJI position reply",
            arrayOf(MOVE_REJECTED) to "return_code=2",
            arrayOf(corruptAck) to "FRAME_CRC",
        )
        for ((replies, error) in cases) {
            val serial = nudgeSession(sdk(READ_0, BEFORE_YAW), sdk(MOVE_YAW, *replies))

            val result = runNudge(serial, "yaw", "positive")

            assertEquals(1, result.status)
            assertTrue(result.errors.single().contains(error))
            assertTrue(result.pauses.isEmpty())
            serial.assertComplete()
        }
    }

    @Test fun nudgeAcknowledgementAloneDoesNotPassMovementOrSettling() {
        val cases = listOf(
            Triple(NO_MOVE_1, NO_MOVE_2, "Selected axis did not move by the requested angle"),
            Triple(STILL_MOVING, SETTLED_YAW, "The two post-command readings did not settle"),
        )
        for ((after, settled, error) in cases) {
            val serial = nudgeSession(
                sdk(READ_0, BEFORE_YAW),
                sdk(MOVE_YAW, MOVE_ACK),
                sdk(READ_1, after),
                sdk(READ_2, settled),
            )

            val result = runNudge(serial, "yaw", "positive")

            assertEquals(1, result.status)
            assertEquals(listOf(error), result.errors)
            assertTrue("nudge_pass" !in result.output)
            serial.assertComplete()
        }
    }

    @Test fun nudgeRejectsAnUnsupportedAxisBeforeOpeningUsb() {
        val errors = mutableListOf<String>()
        val result = runProbe(
            nudgeArgs("roll", "positive"),
            openPort = { error("Should not open a port for an unsupported axis") },
            error = { errors += it },
        )
        assertEquals(2, result)
        assertEquals("--axis must be yaw or pitch", errors.first())
    }

    private data class NudgeResult(
        val status: Int,
        val output: List<String>,
        val errors: List<String>,
        val pauses: List<Long>,
    )

    private fun nudgeArgs(axis: String, direction: String) = arrayOf(
        "nudge", "--port", "/dev/cu.usbmodem-test", "--profile", "sdk-classic-stream",
        "--can-bitrate", "500000", "--tx-id", "0x321", "--rx-id", "0x322",
        "--timeout-ms", "1", "--axis", axis, "--direction", direction,
    )

    private fun runNudge(serial: FakeSerial, axis: String, direction: String): NudgeResult {
        val output = mutableListOf<String>()
        val errors = mutableListOf<String>()
        val pauses = mutableListOf<Long>()
        val status = runProbe(
            nudgeArgs(axis, direction),
            openPort = { serial },
            nowNs = serial::now,
            output = { output += it },
            error = { errors += it },
            pauseMs = { pauses += it },
        )
        assertTrue(serial.closed)
        return NudgeResult(status, output, errors, pauses)
    }

    private fun nudgeSession(vararg packets: List<Turn>) =
        FakeSerial(*(SETUP + packets.flatMap { it } + ack("C")).toTypedArray())

    private fun sdk(request: String, vararg responses: String): List<Turn> {
        fun frame(id: String, block: String) = "t$id${block.length / 2}$block\r"
        val replies = responses.flatMap { packet -> packet.chunked(16).map { frame("322", it) } }
        val fragments = request.chunked(16)
        return fragments.mapIndexed { index, block ->
            Turn(frame("321", block), if (index == fragments.lastIndex) replies + "\r" else listOf("\r"))
        }
    }

    private fun runExchange(port: FakeSerial) =
        SlcanDjiRsTransport(port, ClassicStreamProfile(500_000, 0x321, 0x322), 100, port::now).use { transport ->
            transport.open()
            DjiRsAttitudeReader(transport, 0x1234, port::now).readOnce(100)
        }

    private fun session(last: Turn) = FakeSerial(
        *SETUP.toTypedArray(),
        Turn(TX_FIRST, listOf("\r")),
        Turn(TX_MIDDLE, listOf("\r")),
        last,
        ack("C"),
    )

    private data class Turn(
        val expectedWrite: String,
        val reads: List<String>,
        val readFailure: IOException? = null,
        val delayNs: Long = 0,
    )

    private class FakeSerial(vararg turns: Turn) : SerialIo {
        private val script = ArrayDeque(turns.asList())
        private val reads = ArrayDeque<String>()
        private var failure: IOException? = null
        private var delayNs = 0L
        private var nowNs = 0L
        var closed = false
            private set

        fun now() = nowNs

        override fun write(bytes: ByteArray, timeoutNs: Long) {
            check(timeoutNs > 0 && !closed && reads.isEmpty() && failure == null)
            val turn = script.removeFirst()
            assertEquals(turn.expectedWrite, bytes.toString(Charsets.US_ASCII))
            reads.addAll(turn.reads)
            failure = turn.readFailure
            delayNs = turn.delayNs
        }

        override fun read(timeoutNs: Long): ByteArray? {
            check(timeoutNs > 0 && !closed)
            if (reads.isEmpty()) {
                failure?.let { failure = null; throw it }
                nowNs += timeoutNs
                return null
            }
            if (delayNs >= timeoutNs) {
                nowNs += timeoutNs
                delayNs -= timeoutNs
                return null
            }
            nowNs += delayNs
            delayNs = 0
            return reads.removeFirst().toByteArray(Charsets.US_ASCII)
        }

        override fun close() { closed = true }

        fun assertComplete() {
            assertTrue(script.isEmpty())
            assertTrue(reads.isEmpty())
        }
    }

    companion object {
        // Byte fixtures calculated with the CRC routines from DJI's v2.5 SDK download.
        private const val READ_0 = "AA13000300000000000010BE0E020132933CB0"
        private const val READ_1 = "AA130003000000000100112E0E020192506B96"
        private const val READ_2 = "AA13000300000000020011DE0E0201A85CE521"
        private const val MOVE_YAW = "AA1A00030000000000807B4E0E001E00000000000C0A0D66E1D0"
        private const val MOVE_PITCH = "AA1A00030000000000807B4E0E0000000000E2FF060AC010D181"
        private const val STALE_ACK = "AA13002000000000341294B10E0000FBEC9594"
        private const val MOVE_ACK = "AA13002000000000008003DC0E00002C0E7D32"
        private const val MOVE_REJECTED = "AA13002000000000008003DC0E0002006F73DC"
        private const val BEFORE_YAW = "AA1A0020000000000000682C0E020001FE060A00F8FFFEECB515"
        private const val AFTER_YAW = "AA1A002000000000010069BC0E0200010BF90A00F8FF95FF3345"
        private const val SETTLED_YAW = "AA1A0020000000000200694C0E0200010CF90A00F8FF9A8D94AD"
        private const val AFTER_PITCH = "AA1A002000000000010069BC0E020001FE060A00DAFF93F6BA6D"
        private const val SETTLED_PITCH = "AA1A0020000000000200694C0E020001FE060A00DAFF24B41898"
        private const val NO_MOVE_1 = "AA1A002000000000010069BC0E020001FE060A00F8FFB3B008CA"
        private const val NO_MOVE_2 = "AA1A0020000000000200694C0E020001FE060A00F8FF04F2AA3F"
        private const val STILL_MOVING = "AA1A002000000000010069BC0E02000104F90A00F8FF404D65B4"

        private fun ack(command: String) = Turn("$command\r", listOf("\r"))
        private val SETUP = listOf("C", "H0", "M0", "S6", "O").map(::ack)
        private const val TX_FIRST = "t3218AA13000300000000\r"
        private const val TX_MIDDLE = "t3218341286730E020188\r"
        private const val TX_LAST = "t3213556F78\r"
    }
}
