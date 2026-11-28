package ru.university.dronecv.weact

import java.io.IOException
import java.net.SocketTimeoutException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.roundToInt
import ru.university.dronecv.gimbal.DjiRsAttitudeExchange
import ru.university.dronecv.gimbal.DjiRsAttitudeExchange.Outcome
import ru.university.dronecv.gimbal.DjiRsAttitudeReader
import ru.university.dronecv.gimbal.DjiRsAttitudeReply.Angles
import ru.university.dronecv.gimbal.DjiRsAttitudeReply.InvalidReason
import ru.university.dronecv.gimbal.DjiRsGimbalPackets
import ru.university.dronecv.gimbal.DjiRsPacketTransport

internal enum class NudgeAxis { YAW, PITCH }

internal enum class NudgeSample(val label: String) {
    BEFORE("before"), AFTER("after"), SETTLED("settled"),
}

internal sealed interface NudgeEvent {
    data class Attitude(val sample: NudgeSample, val exchange: DjiRsAttitudeExchange) : NudgeEvent
    data class PositionRequested(val sequence: Int, val durationMs: Int) : NudgeEvent
    data object PositionTransmitted : NudgeEvent
    data class PositionAccepted(val sequence: Int) : NudgeEvent
    data class PositionRejected(val code: Int) : NudgeEvent
}

internal data class NudgeMeasurement(val before: Angles, val after: Angles, val settled: Angles?)

internal class NudgeAttitudeUnavailable(val sample: NudgeSample, val outcome: Outcome) :
    IOException("DJI attitude unavailable at ${sample.label}", (outcome as? Outcome.TransportError)?.cause)

internal class NudgePositionTimeout : SocketTimeoutException("No DJI position reply before timeout")
internal class NudgePositionInvalid(val reason: InvalidReason) : IOException("Invalid DJI position reply: $reason")
internal class NudgePositionRejected(val code: Int) : IOException("DJI position command failed: return_code=$code")

private const val NUDGE_DEGREES = 3
private const val POSITION_COMMAND = 0x00
private const val DURATION_TENTHS_OF_SECOND = 10
private const val DURATION_MS = DURATION_TENTHS_OF_SECOND * 100
private const val FIRST_SAMPLE_MS = DURATION_MS + 250L
private const val SECOND_SAMPLE_DELAY_MS = 350L

internal data class GimbalNudge(val axis: NudgeAxis, val positive: Boolean) {
    val degrees = if (positive) NUDGE_DEGREES else -NUDGE_DEGREES

    /** Sends at most one position request. [admitPosition] may throw to abort just before transmission. */
    fun measure(
        transport: DjiRsPacketTransport,
        timeoutNs: Long,
        nowNs: () -> Long,
        pauseMs: (Long) -> Unit,
        attitudeSequence: Int,
        positionSequence: Int,
        sampleSettling: Boolean = false,
        admitPosition: () -> Unit = {},
        observe: (NudgeEvent) -> Unit = {},
    ): NudgeMeasurement {
        val reader = DjiRsAttitudeReader(transport, attitudeSequence, nowNs)

        fun read(sample: NudgeSample): Angles {
            val exchange = reader.readOnce(timeoutNs)
            observe(NudgeEvent.Attitude(sample, exchange))
            return (exchange.outcome as? Outcome.Reply)?.value as? Angles
                ?: throw NudgeAttitudeUnavailable(sample, exchange.outcome)
        }

        val before = read(NudgeSample.BEFORE)
        val request = DjiRsGimbalPackets.encodeRequest(positionSequence, POSITION_COMMAND, payload())
        transport.prepareReceive()
        admitPosition()
        observe(NudgeEvent.PositionRequested(positionSequence, DURATION_MS))
        transport.write(request)
        val sentAt = nowNs()
        observe(NudgeEvent.PositionTransmitted)
        val code = awaitPositionAck(transport, positionSequence, timeoutNs, nowNs, sentAt)
        if (code != 0) {
            observe(NudgeEvent.PositionRejected(code))
            throw NudgePositionRejected(code)
        }
        observe(NudgeEvent.PositionAccepted(positionSequence))
        pauseMs(FIRST_SAMPLE_MS)
        val after = read(NudgeSample.AFTER)
        val settled = if (sampleSettling) {
            pauseMs(SECOND_SAMPLE_DELAY_MS)
            read(NudgeSample.SETTLED)
        } else null
        return NudgeMeasurement(before, after, settled)
    }

    private fun payload(): ByteArray {
        val tenths = (degrees * 10).toShort()
        val yaw = axis == NudgeAxis.YAW
        return ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN)
            .putShort(if (yaw) tenths else 0)
            .putShort(0)
            .putShort(if (yaw) 0 else tenths)
            // RS SDK v2.5 §2.3.4.1. A set axis bit disables that axis.
            .put(if (yaw) 0b1100 else 0b0110)
            .put(DURATION_TENTHS_OF_SECOND.toByte())
            .array()
    }
}

private fun awaitPositionAck(
    transport: DjiRsPacketTransport,
    sequence: Int,
    timeoutNs: Long,
    nowNs: () -> Long,
    startedNs: Long,
): Int {
    while (true) {
        val remainingNs = timeoutNs - (nowNs() - startedNs)
        if (remainingNs <= 0) break
        val reply = transport.receive(remainingNs) ?: break
        if (nowNs() - startedNs >= timeoutNs) break
        val invalid = DjiRsGimbalPackets.validateReply(reply, sequence, POSITION_COMMAND, payloadSize = 1)
        if (invalid == InvalidReason.SEQUENCE) continue
        if (invalid != null) throw NudgePositionInvalid(invalid)
        return reply[DjiRsGimbalPackets.PAYLOAD_OFFSET].toInt() and 0xFF
    }
    throw NudgePositionTimeout()
}

/** Signed shortest angle difference, including across the ±180° boundary. */
internal fun Angles.deltaFrom(before: Angles): Angles {
    fun delta(after: Double, start: Double): Double {
        val tenths = ((after - start) * 10).roundToInt()
        return (Math.floorMod(tenths + 1800, 3600) - 1800) / 10.0
    }
    return Angles(
        delta(yawDegrees, before.yawDegrees),
        delta(rollDegrees, before.rollDegrees),
        delta(pitchDegrees, before.pitchDegrees),
    )
}
