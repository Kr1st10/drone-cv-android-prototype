package ru.university.dronecv.gimbal

import java.io.IOException
import ru.university.dronecv.gimbal.DjiRsAttitudeExchange.Event
import ru.university.dronecv.gimbal.DjiRsAttitudeExchange.Operation
import ru.university.dronecv.gimbal.DjiRsAttitudeExchange.Outcome
import ru.university.dronecv.gimbal.DjiRsAttitudeReply.Invalid
import ru.university.dronecv.gimbal.DjiRsAttitudeReply.InvalidReason

/** Transport for whole RS SDK packets. The caller owns the transport and its lifetime. */
internal interface DjiRsPacketTransport {
    /** Enables reception and buffering before returning. Safe to call before each write. */
    @Throws(IOException::class)
    fun prepareReceive()

    /** Reports success after submitting the complete request to the transport. */
    @Throws(IOException::class)
    fun write(packet: ByteArray)

    /** Waits up to [timeoutNanos] for a complete packet, then returns null if none arrived. */
    @Throws(IOException::class)
    fun receive(timeoutNanos: Long): ByteArray?
}

internal data class DjiRsAttitudeExchange(
    val sequence: Int,
    val events: List<Event>,
    val outcome: Outcome,
) {
    enum class Event { REQUEST_SENT, RESPONSE_RECEIVED }

    sealed interface Outcome {
        data class Reply(val value: DjiRsAttitudeReply) : Outcome
        data object Timeout : Outcome
        data class TransportError(val operation: Operation, val cause: IOException) : Outcome
    }

    enum class Operation { PREPARE_RECEIVE, WRITE, RECEIVE }
}

/** Performs serial attitude reads. Use one reader per transport to keep sequence allocation and reception together. */
internal class DjiRsAttitudeReader(
    private val transport: DjiRsPacketTransport,
    initialSequence: Int = 0,
    private val nanoTime: () -> Long = System::nanoTime,
) {
    init {
        require(initialSequence in 0..0xFFFF)
    }

    private var nextSequence = initialSequence

    /** The positive [timeoutNanos] applies to reception after a successful write. */
    @Synchronized
    fun readOnce(timeoutNanos: Long): DjiRsAttitudeExchange {
        require(timeoutNanos > 0)
        val sequence = nextSequence
        nextSequence = (sequence + 1) and 0xFFFF
        val request = DjiRsAttitudeCodec.encodeRequest(sequence)
        val events = mutableListOf<Event>()

        fun finish(outcome: Outcome) =
            DjiRsAttitudeExchange(sequence, events.toList(), outcome)

        var operation = Operation.PREPARE_RECEIVE
        try {
            transport.prepareReceive()
            operation = Operation.WRITE
            transport.write(request)
            val sentAt = nanoTime()
            events += Event.REQUEST_SENT

            operation = Operation.RECEIVE
            while (true) {
                val remaining = timeoutNanos - (nanoTime() - sentAt)
                if (remaining <= 0) break
                val packet = transport.receive(remaining) ?: break
                if (nanoTime() - sentAt >= timeoutNanos) break

                val reply = DjiRsAttitudeCodec.decodeReply(packet, sequence)
                if (reply is Invalid && reply.reason == InvalidReason.SEQUENCE) {
                    continue
                }
                events += Event.RESPONSE_RECEIVED
                return finish(Outcome.Reply(reply))
            }
        } catch (error: IOException) {
            return finish(Outcome.TransportError(operation, error))
        }
        return finish(Outcome.Timeout)
    }
}
