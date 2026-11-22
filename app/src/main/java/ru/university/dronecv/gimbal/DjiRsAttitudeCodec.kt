package ru.university.dronecv.gimbal

import java.nio.ByteBuffer
import java.nio.ByteOrder
import ru.university.dronecv.gimbal.DjiRsAttitudeReply.Invalid
import ru.university.dronecv.gimbal.DjiRsAttitudeReply.InvalidReason

internal sealed interface DjiRsAttitudeReply {
    data class Angles(
        val yawDegrees: Double,
        val rollDegrees: Double,
        val pitchDegrees: Double,
    ) : DjiRsAttitudeReply

    data object NotReady : DjiRsAttitudeReply
    data class DeviceError(val code: Int) : DjiRsAttitudeReply
    data class Invalid(val reason: InvalidReason) : DjiRsAttitudeReply

    enum class InvalidReason {
        LENGTH,
        HEADER,
        HEADER_CRC,
        FRAME_CRC,
        SEQUENCE,
        COMMAND,
        DATA_TYPE,
    }
}

/** Binary RS SDK v2.5 read request for the gimbal's attitude angles. */
internal object DjiRsAttitudeCodec {
    private const val START_OF_FRAME = 0xAA
    private const val LENGTH_OFFSET = 1
    private const val LENGTH_MASK = 0x03FF
    private const val VERSION_SHIFT = 10
    private const val TYPE_OFFSET = 3
    private const val REPLY_REQUIRED = 0x03
    private const val REPLY_FRAME_BIT = 0x20
    private const val ENCRYPTION_OFFSET = 4
    private const val SEQUENCE_OFFSET = 8
    private const val SEQUENCE_MAX = 0xFFFF
    private const val CRC16_OFFSET = 10
    private const val DATA_OFFSET = 12
    private const val COMMAND_DATA_OFFSET = DATA_OFFSET + 2
    private const val CRC32_BYTES = 4
    private const val REQUEST_BYTES = COMMAND_DATA_OFFSET + 1 + CRC32_BYTES
    private const val REPLY_BYTES = COMMAND_DATA_OFFSET + 8 + CRC32_BYTES

    private const val GIMBAL_COMMAND_SET = 0x0E
    private const val READ_ANGLES = 0x02
    private const val ATTITUDE_ANGLES = 0x01
    private const val DATA_NOT_READY = 0x00
    private const val SUCCESS = 0x00

    // The DJI sample uses the reflected seed and polynomials for both checksums.
    private const val CRC_SEED = 0x3AA3
    private const val CRC16_POLYNOMIAL = 0xA001
    private val CRC32_POLYNOMIAL = 0xEDB8_8320.toInt()

    /** Encodes a single read request. [sequence] is an unsigned 16-bit number set by the caller. */
    fun encodeRequest(sequence: Int): ByteArray {
        require(sequence in 0..SEQUENCE_MAX)
        val buffer = ByteBuffer.allocate(REQUEST_BYTES).order(ByteOrder.LITTLE_ENDIAN)
        val frame = buffer.array()
        buffer.put(START_OF_FRAME.toByte())
        buffer.putShort(REQUEST_BYTES.toShort())
        buffer.put(REPLY_REQUIRED.toByte())
        buffer.position(SEQUENCE_OFFSET)
        buffer.putShort(sequence.toShort())
        buffer.putShort(reflectedCrc(frame, CRC16_OFFSET, CRC16_POLYNOMIAL).toShort())
        buffer.put(GIMBAL_COMMAND_SET.toByte())
        buffer.put(READ_ANGLES.toByte())
        buffer.put(ATTITUDE_ANGLES.toByte())
        buffer.putInt(reflectedCrc(frame, REQUEST_BYTES - CRC32_BYTES, CRC32_POLYNOMIAL))
        return frame
    }

    /** Decodes one complete SDK reply for [expectedSequence]. Angles are returned in degrees. */
    fun decodeReply(frame: ByteArray, expectedSequence: Int): DjiRsAttitudeReply {
        require(expectedSequence in 0..SEQUENCE_MAX)
        if (frame.size != REPLY_BYTES) return Invalid(InvalidReason.LENGTH)

        val buffer = ByteBuffer.wrap(frame).order(ByteOrder.LITTLE_ENDIAN)
        val versionAndLength = buffer.getShort(LENGTH_OFFSET).toInt() and 0xFFFF
        if ((versionAndLength and LENGTH_MASK) != frame.size) return Invalid(InvalidReason.LENGTH)
        val isReply = (frame[TYPE_OFFSET].toInt() and REPLY_FRAME_BIT) != 0
        val version = versionAndLength ushr VERSION_SHIFT
        if (frame[0] != START_OF_FRAME.toByte() || version != 0 ||
            !isReply || frame[ENCRYPTION_OFFSET] != 0.toByte()
        ) {
            return Invalid(InvalidReason.HEADER)
        }

        val headerCrc = reflectedCrc(frame, CRC16_OFFSET, CRC16_POLYNOMIAL).toShort()
        if (buffer.getShort(CRC16_OFFSET) != headerCrc) return Invalid(InvalidReason.HEADER_CRC)

        val sequence = buffer.getShort(SEQUENCE_OFFSET).toInt() and 0xFFFF
        if (sequence != expectedSequence) return Invalid(InvalidReason.SEQUENCE)

        val frameCrcOffset = frame.size - CRC32_BYTES
        val frameCrc = reflectedCrc(frame, frameCrcOffset, CRC32_POLYNOMIAL)
        if (buffer.getInt(frameCrcOffset) != frameCrc) return Invalid(InvalidReason.FRAME_CRC)

        buffer.position(DATA_OFFSET)
        if (buffer.get() != GIMBAL_COMMAND_SET.toByte() || buffer.get() != READ_ANGLES.toByte()) {
            return Invalid(InvalidReason.COMMAND)
        }

        val returnCode = buffer.get().toInt() and 0xFF
        if (returnCode != SUCCESS) return DjiRsAttitudeReply.DeviceError(returnCode)
        return when (buffer.get().toInt()) {
            DATA_NOT_READY -> DjiRsAttitudeReply.NotReady
            ATTITUDE_ANGLES -> DjiRsAttitudeReply.Angles(
                yawDegrees = buffer.short / 10.0,
                rollDegrees = buffer.short / 10.0,
                pitchDegrees = buffer.short / 10.0,
            )
            else -> Invalid(InvalidReason.DATA_TYPE)
        }
    }

    private fun reflectedCrc(frame: ByteArray, end: Int, polynomial: Int): Int {
        var crc = CRC_SEED
        for (index in 0 until end) {
            crc = crc xor (frame[index].toInt() and 0xFF)
            repeat(8) {
                val lowBit = crc and 1
                crc = crc ushr 1
                if (lowBit != 0) crc = crc xor polynomial
            }
        }
        return crc
    }
}
