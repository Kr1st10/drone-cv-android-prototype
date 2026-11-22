package ru.university.dronecv.gimbal

import java.io.IOException
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import ru.university.dronecv.gimbal.DjiRsAttitudeExchange.Event.REQUEST_SENT
import ru.university.dronecv.gimbal.DjiRsAttitudeExchange.Event.RESPONSE_RECEIVED
import ru.university.dronecv.gimbal.DjiRsAttitudeExchange.Operation
import ru.university.dronecv.gimbal.DjiRsAttitudeExchange.Outcome

class DjiRsAttitudeReaderTest {
    private val transport = TestTransport()
    private val reader = DjiRsAttitudeReader(transport, SEQUENCE, transport::nowNanos)

    @Test fun receivesAReplyBufferedDuringWrite() {
        transport.replyDuringWrite = matchingReply

        val exchange = reader.readOnce(TIMEOUT)

        assertEquals(listOf(Operation.PREPARE_RECEIVE, Operation.WRITE, Operation.RECEIVE), transport.calls)
        assertArrayEquals(bytes("AA 13 00 03 00 00 00 00 34 12 86 73 0E 02 01 88 55 6F 78"), transport.writes.single())
        assertEquals(SEQUENCE, exchange.sequence)
        assertEquals(listOf(REQUEST_SENT, RESPONSE_RECEIVED), exchange.events)
        assertEquals(Outcome.Reply(expectedAngles), exchange.outcome)
        assertEquals(listOf(TIMEOUT), transport.receiveTimeouts)
    }

    @Test fun skipsAForeignSequenceWithoutRenewingTheDeadline() {
        transport.replies.add(ReplyAfter(foreignReply, 40))
        transport.replies.add(ReplyAfter(matchingReply, 20))

        val exchange = reader.readOnce(TIMEOUT)

        assertEquals(listOf(TIMEOUT, 60L), transport.receiveTimeouts)
        assertEquals(listOf(REQUEST_SENT, RESPONSE_RECEIVED), exchange.events)
        assertEquals(Outcome.Reply(expectedAngles), exchange.outcome)
        assertEquals(1, transport.writes.size)
    }

    @Test fun skipsAForeignReplyWithCorruptedPayload() {
        val corrupted = foreignReply.copyOf().also { it[16] = 0 }
        transport.replies.add(ReplyAfter(corrupted, 40))
        transport.replies.add(ReplyAfter(matchingReply, 20))

        val exchange = reader.readOnce(TIMEOUT)

        assertEquals(Outcome.Reply(expectedAngles), exchange.outcome)
        assertEquals(1, transport.writes.size)
        assertEquals(listOf(TIMEOUT, 60L), transport.receiveTimeouts)
    }

    @Test fun reportsCorruptionEvenIfTheDamagedHeaderContainsADifferentNumber() {
        val corrupted = matchingReply.copyOf().also { it[8] = 0x35 }
        transport.replies.add(ReplyAfter(corrupted))

        assertReply(DjiRsAttitudeReply.Invalid(DjiRsAttitudeReply.InvalidReason.HEADER_CRC))
    }

    @Test fun reportsPayloadCorruption() {
        val corrupted = matchingReply.copyOf().also { it[16] = 0 }
        transport.replies.add(ReplyAfter(corrupted))

        assertReply(DjiRsAttitudeReply.Invalid(DjiRsAttitudeReply.InvalidReason.FRAME_CRC))
    }

    @Test fun reportsThatTheGimbalHasNoAnglesYet() {
        transport.replies.add(ReplyAfter(bytes("AA 1A 00 20 00 00 00 00 34 12 FE E1 0E 02 00 00 FB F8 7B 00 81 FC 8C 52 82 2F")))

        assertReply(DjiRsAttitudeReply.NotReady)
    }

    @Test fun preservesTheGimbalErrorCode() {
        transport.replies.add(ReplyAfter(bytes("AA 1A 00 20 00 00 00 00 34 12 FE E1 0E 02 FF 01 FB F8 7B 00 81 FC DE 5F BE AF")))

        assertReply(DjiRsAttitudeReply.DeviceError(255))
    }

    @Test fun timesOutWhenNoReplyArrives() {
        val exchange = reader.readOnce(TIMEOUT)

        assertEquals(listOf(TIMEOUT), transport.receiveTimeouts)
        assertEquals(listOf(REQUEST_SENT), exchange.events)
        assertEquals(Outcome.Timeout, exchange.outcome)
    }

    @Test fun timesOutIfOnlyForeignRepliesArrive() {
        transport.replies.add(ReplyAfter(foreignReply, 25))
        transport.replies.add(ReplyAfter(foreignReply, 50))

        val exchange = reader.readOnce(TIMEOUT)

        assertEquals(listOf(TIMEOUT, 75L, 25L), transport.receiveTimeouts)
        assertEquals(listOf(REQUEST_SENT), exchange.events)
        assertEquals(Outcome.Timeout, exchange.outcome)
    }

    @Test fun rejectsAReplyReturnedAfterTheReceiveDeadline() {
        transport.replies.add(ReplyAfter(matchingReply, TIMEOUT + 1))

        val exchange = reader.readOnce(TIMEOUT)

        assertEquals(listOf(REQUEST_SENT), exchange.events)
        assertEquals(Outcome.Timeout, exchange.outcome)
    }

    @Test fun reportsWriteFailureWithoutAReceivedOrSentEvent() {
        transport.failAt = Operation.WRITE

        val exchange = reader.readOnce(TIMEOUT)

        assertEquals(listOf(Operation.PREPARE_RECEIVE, Operation.WRITE), transport.calls)
        assertEquals(emptyList<DjiRsAttitudeExchange.Event>(), exchange.events)
        assertEquals(Outcome.TransportError(Operation.WRITE, transport.error), exchange.outcome)
    }

    @Test fun identifiesPrepareAndReceiveFailures() {
        transport.failAt = Operation.PREPARE_RECEIVE
        val prepareFailure = reader.readOnce(TIMEOUT)
        assertEquals(listOf(Operation.PREPARE_RECEIVE), transport.calls)
        assertEquals(emptyList<DjiRsAttitudeExchange.Event>(), prepareFailure.events)
        assertEquals(Outcome.TransportError(Operation.PREPARE_RECEIVE, transport.error), prepareFailure.outcome)

        transport.failAt = Operation.RECEIVE
        val receiveFailure = reader.readOnce(TIMEOUT)
        assertEquals(listOf(REQUEST_SENT), receiveFailure.events)
        assertEquals(Outcome.TransportError(Operation.RECEIVE, transport.error), receiveFailure.outcome)
    }

    @Test fun advancesTheSequenceAfterWriteFailureAndWrapsAtSixteenBits() {
        val wrappingReader = DjiRsAttitudeReader(transport, 0xFFFF, transport::nowNanos)
        transport.failAt = Operation.WRITE
        assertEquals(0xFFFF, wrappingReader.readOnce(TIMEOUT).sequence)

        transport.failAt = null
        transport.replies.add(ReplyAfter(foreignReply))
        assertEquals(0, wrappingReader.readOnce(TIMEOUT).sequence)
        assertArrayEquals(bytes("AA 13 00 03 00 00 00 00 00 00 10 BE 0E 02 01 32 93 3C B0"), transport.writes.single())
    }

    private fun assertReply(reply: DjiRsAttitudeReply) {
        val exchange = reader.readOnce(TIMEOUT)
        assertEquals(listOf(REQUEST_SENT, RESPONSE_RECEIVED), exchange.events)
        assertEquals(Outcome.Reply(reply), exchange.outcome)
    }

    private data class ReplyAfter(val packet: ByteArray, val delayNanos: Long = 0)

    private class TestTransport : DjiRsPacketTransport {
        val calls = mutableListOf<Operation>()
        val writes = mutableListOf<ByteArray>()
        val receiveTimeouts = mutableListOf<Long>()
        val replies = ArrayDeque<ReplyAfter>()
        val error = IOException("adapter disconnected")
        var failAt: Operation? = null
        var nowNanos = 0L
            private set
        var replyDuringWrite: ByteArray? = null
        private var receiving = false

        override fun prepareReceive() {
            record(Operation.PREPARE_RECEIVE)
            receiving = true
        }

        override fun write(packet: ByteArray) {
            check(receiving)
            record(Operation.WRITE)
            writes += packet.copyOf()
            nowNanos += TIMEOUT
            replyDuringWrite?.let { replies.add(ReplyAfter(it)) }
        }

        override fun receive(timeoutNanos: Long): ByteArray? {
            record(Operation.RECEIVE)
            receiveTimeouts += timeoutNanos
            val reply = replies.removeFirstOrNull()
            nowNanos += reply?.delayNanos ?: timeoutNanos
            return reply?.packet
        }

        private fun record(operation: Operation) {
            calls += operation
            if (failAt == operation) throw error
        }
    }

    private companion object {
        const val SEQUENCE = 0x1234
        const val TIMEOUT = 100L
        val matchingReply = bytes("AA 1A 00 20 00 00 00 00 34 12 FE E1 0E 02 00 01 FB F8 7B 00 81 FC 38 59 F5 89")
        val foreignReply = bytes("AA 1A 00 20 00 00 00 00 FF FF 69 9C 0E 02 00 01 FB F8 7B 00 81 FC 96 91 43 C0")
        val expectedAngles = DjiRsAttitudeReply.Angles(yawDegrees = -179.7, rollDegrees = 12.3, pitchDegrees = -89.5)

        fun bytes(hex: String) = hex.split(' ').map { it.toInt(16).toByte() }.toByteArray()
    }
}
