package ru.university.dronecv.weact

import java.io.IOException
import kotlin.math.abs
import ru.university.dronecv.gimbal.DjiRsPacketTransport

private const val POSITION_SEQUENCE = 0x8000
private const val MOTION_TOLERANCE_DEG = 1.0
private const val SETTLED_TOLERANCE_DEG = 0.5

internal fun GimbalNudge.run(
    transport: DjiRsPacketTransport,
    timeoutNs: Long,
    nowNs: () -> Long,
    pauseMs: (Long) -> Unit,
    output: (String) -> Unit,
) {
    var awaitingAck = false
    val measurement = try {
        measure(transport, timeoutNs, nowNs, pauseMs, 0, POSITION_SEQUENCE, sampleSettling = true) { event ->
            when (event) {
                is NudgeEvent.Attitude -> with(event.exchange) {
                    output("${event.sample.label} seq=$sequence events=$events result=$outcome")
                }
                is NudgeEvent.PositionRequested -> {
                    awaitingAck = true
                    output("nudge axis=$axis requested_deg=$degrees duration_ms=${event.durationMs} seq=${event.sequence}")
                }
                is NudgeEvent.PositionAccepted -> {
                    awaitingAck = false
                    output("position_ack seq=${event.sequence} return_code=0")
                }
                NudgeEvent.PositionTransmitted, is NudgeEvent.PositionRejected -> Unit
            }
        }
    } catch (error: IOException) {
        if (!awaitingAck) throw error
        throw IOException("Position command was attempted once. Verify the gimbal before rerunning. ${error.message}", error)
    }

    val settled = checkNotNull(measurement.settled)
    val delta = settled.deltaFrom(measurement.before)
    val drift = settled.deltaFrom(measurement.after)
    output("delta_deg yaw=${delta.yawDegrees} roll=${delta.rollDegrees} pitch=${delta.pitchDegrees}")
    output("drift_deg yaw=${drift.yawDegrees} roll=${drift.rollDegrees} pitch=${drift.pitchDegrees}")

    val observed = if (axis == NudgeAxis.YAW) delta.yawDegrees else delta.pitchDegrees
    val other = if (axis == NudgeAxis.YAW) delta.pitchDegrees else delta.yawDegrees
    requireMeasurement(abs(observed - degrees) <= MOTION_TOLERANCE_DEG, "Selected axis did not move by the requested angle")
    requireMeasurement(abs(other) <= MOTION_TOLERANCE_DEG && abs(delta.rollDegrees) <= MOTION_TOLERANCE_DEG,
        "Movement was also measured on an unselected axis")
    requireMeasurement(listOf(drift.yawDegrees, drift.rollDegrees, drift.pitchDegrees).all {
        abs(it) <= SETTLED_TOLERANCE_DEG
    }, "The two post-command readings did not settle")
    output("nudge_pass")
}

private fun requireMeasurement(condition: Boolean, message: String) {
    if (!condition) throw IOException(message)
}
