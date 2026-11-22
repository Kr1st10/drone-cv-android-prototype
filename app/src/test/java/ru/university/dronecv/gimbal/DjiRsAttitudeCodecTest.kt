package ru.university.dronecv.gimbal

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import ru.university.dronecv.gimbal.DjiRsAttitudeReply.InvalidReason

class DjiRsAttitudeCodecTest {
    @Test fun encodesTheReferenceReadRequest() {
        assertArrayEquals(
            bytes("AA 13 00 03 00 00 00 00 34 12 86 73 0E 02 01 88 55 6F 78"),
            DjiRsAttitudeCodec.encodeRequest(SEQUENCE),
        )
    }

    @Test fun acceptsBothEndsOfTheUnsignedSequenceRange() {
        assertArrayEquals(
            bytes("AA 13 00 03 00 00 00 00 00 00 10 BE 0E 02 01 32 93 3C B0"),
            DjiRsAttitudeCodec.encodeRequest(0),
        )
        assertArrayEquals(
            bytes("AA 13 00 03 00 00 00 00 FF FF 11 0E 0E 02 01 E4 15 DC E6"),
            DjiRsAttitudeCodec.encodeRequest(65535),
        )
        val reply = bytes("AA 1A 00 20 00 00 00 00 FF FF 69 9C 0E 02 00 01 FB F8 7B 00 81 FC 96 91 43 C0")
        assertEquals(expectedAngles, DjiRsAttitudeCodec.decodeReply(reply, 65535))
    }

    @Test fun rejectsOutOfRangeCallerSequences() {
        for (sequence in listOf(-1, 65536)) {
            assertThrows(IllegalArgumentException::class.java) { DjiRsAttitudeCodec.encodeRequest(sequence) }
            assertThrows(IllegalArgumentException::class.java) { DjiRsAttitudeCodec.decodeReply(reply(), sequence) }
        }
    }

    @Test fun decodesSignedAnglesInYawRollPitchOrder() {
        assertEquals(expectedAngles, DjiRsAttitudeCodec.decodeReply(reply(), SEQUENCE))
    }

    @Test fun distinguishesUnavailableDataAndDeviceErrorsFromAngles() {
        val unavailable = bytes("AA 1A 00 20 00 00 00 00 34 12 FE E1 0E 02 00 00 FB F8 7B 00 81 FC 8C 52 82 2F")
        val rejected = bytes("AA 1A 00 20 00 00 00 00 34 12 FE E1 0E 02 FF 01 FB F8 7B 00 81 FC DE 5F BE AF")
        assertEquals(DjiRsAttitudeReply.NotReady, DjiRsAttitudeCodec.decodeReply(unavailable, SEQUENCE))
        assertEquals(DjiRsAttitudeReply.DeviceError(255), DjiRsAttitudeCodec.decodeReply(rejected, SEQUENCE))
    }

    @Test fun rejectsInconsistentLengthsAndWrongHeaderFields() {
        assertInvalid(InvalidReason.LENGTH, reply().copyOf(25))
        assertInvalid(InvalidReason.LENGTH, reply().copyOf(27))
        assertInvalid(InvalidReason.LENGTH, reply().also { it[1] = 25 })
        assertInvalid(InvalidReason.HEADER, reply().also { it[0] = 0 })
        assertInvalid(InvalidReason.HEADER, reply().also { it[2] = 0x04 })
        assertInvalid(InvalidReason.HEADER, reply().also { it[3] = 0x03 })
        assertInvalid(InvalidReason.HEADER, reply().also { it[4] = 0x20 })
    }

    @Test fun rejectsCorruptionInTheHeaderAndThePayload() {
        assertInvalid(InvalidReason.HEADER_CRC, reply().also { it[8] = 0x35 })
        assertInvalid(InvalidReason.FRAME_CRC, reply().also { it[16] = 0 })
    }

    @Test fun rejectsUnrelatedRepliesEvenWithValidChecksums() {
        assertEquals(
            DjiRsAttitudeReply.Invalid(InvalidReason.SEQUENCE),
            DjiRsAttitudeCodec.decodeReply(reply(), SEQUENCE + 1),
        )
        assertInvalid(
            InvalidReason.COMMAND,
            bytes("AA 1A 00 20 00 00 00 00 34 12 FE E1 0E 7F 00 01 FB F8 7B 00 81 FC BA 7D 19 88"),
        )
        assertInvalid(
            InvalidReason.DATA_TYPE,
            bytes("AA 1A 00 20 00 00 00 00 34 12 FE E1 0E 02 00 02 FB F8 7B 00 81 FC A5 43 1D B8"),
        )
    }

    private fun assertInvalid(reason: InvalidReason, frame: ByteArray) {
        assertEquals(DjiRsAttitudeReply.Invalid(reason), DjiRsAttitudeCodec.decodeReply(frame, SEQUENCE))
    }

    private fun reply() = bytes("AA 1A 00 20 00 00 00 00 34 12 FE E1 0E 02 00 01 FB F8 7B 00 81 FC 38 59 F5 89")

    private fun bytes(hex: String) = hex.split(' ').map { it.toInt(16).toByte() }.toByteArray()

    private companion object {
        // Synthetic packets checked with the CRC tables shipped in the DJI R SDK v2.5 archive.
        const val SEQUENCE = 0x1234
        val expectedAngles = DjiRsAttitudeReply.Angles(yawDegrees = -179.7, rollDegrees = 12.3, pitchDegrees = -89.5)
    }
}
