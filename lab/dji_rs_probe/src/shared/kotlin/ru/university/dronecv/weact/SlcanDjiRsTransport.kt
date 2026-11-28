package ru.university.dronecv.weact

import ru.university.dronecv.gimbal.DjiRsPacketTransport
import java.io.IOException

private val bitrateCodes = mapOf(
    10_000 to '0', 20_000 to '1', 50_000 to '2', 100_000 to '3', 125_000 to '4',
    250_000 to '5', 500_000 to '6', 800_000 to '7', 1_000_000 to '8', 75_000 to 'A', 5_000 to 'D',
)

internal class SlcanCanTransmitUnconfirmed(cause: IOException) : IOException(cause.message, cause)

internal data class ClassicStreamProfile(val bitrate: Int, val txId: Int, val rxId: Int) {
    val bitrateCommand: String

    init {
        require(txId in 0..0x7FF && rxId in 0..0x7FF && txId != rxId) { "Use distinct 11-bit CAN IDs" }
        val code = requireNotNull(bitrateCodes[bitrate]) { "Unsupported WeAct CAN bitrate: $bitrate" }
        bitrateCommand = "S$code"
    }
}

/**
 * Diagnostic profile: the selected 11-bit RX ID carries contiguous RS SDK packet bytes with no
 * per-fragment header. Packets may span several classic CAN frames. This layout is tested in the
 * simulator; actual RS 5 hardware settings must be confirmed separately.
 */
internal class SlcanDjiRsTransport(
    serial: SerialIo,
    private val profile: ClassicStreamProfile,
    private val ioTimeoutNs: Long,
    private val nowNs: () -> Long = System::nanoTime,
) : DjiRsPacketTransport, AutoCloseable {
    private val wire = SlcanWire(serial, nowNs)
    private val assembler = RsPacketAssembler()
    private val pending = ArrayDeque<ByteArray>()
    private var closeNeeded = false
    private var opened = false
    private var prepared = false

    init { require(ioTimeoutNs > 0) }

    fun version(): String = wire.version(ioTimeoutNs)

    fun open() {
        check(!closeNeeded) { "CAN channel was already opened" }
        val deadline = nowNs() + ioTimeoutNs
        wire.expectAck("C", deadline)
        // Firmware without the optional enhanced mode already uses text frames.
        wire.expectAck("H0", deadline, allowRejection = true)
        wire.expectAck("M0", deadline)
        wire.expectAck(profile.bitrateCommand, deadline)
        closeNeeded = true
        wire.expectAck("O", deadline)
        opened = true
    }

    override fun prepareReceive() {
        if (!opened) throw IOException("CAN channel is closed")
        assembler.reset()
        pending.clear()
        prepared = true
    }

    override fun write(packet: ByteArray) {
        if (!prepared) throw IOException("Prepare receive before writing the RS SDK request")
        val deadline = nowNs() + ioTimeoutNs
        for (start in packet.indices step CLASSIC_CAN_BYTES) {
            val data = packet.copyOfRange(start, minOf(start + CLASSIC_CAN_BYTES, packet.size))
            try {
                wire.expectAck(ClassicCanFrame(profile.txId, data).encode(), deadline, ::onLine)
            } catch (error: IOException) {
                if (error is SlcanCommandRejected || error is SlcanAckTimeout) {
                    throw SlcanCanTransmitUnconfirmed(error)
                }
                throw error
            }
        }
    }

    override fun receive(timeoutNanos: Long): ByteArray? {
        if (!prepared) throw IOException("Prepare receive before waiting for an RS SDK response")
        val deadline = nowNs() + timeoutNanos
        while (deadline - nowNs() > 0) {
            if (pending.isNotEmpty()) return pending.removeFirst()
            when (val event = wire.next(deadline)) {
                is SlcanEvent.Line -> onLine(event.value)
                SlcanEvent.Rejected -> throw IOException("WeAct reported a SLCAN error while receiving")
                SlcanEvent.Ack -> Unit
                null -> break
            }
        }
        return null
    }

    private fun onLine(line: String) {
        if (!line.startsWith('t')) return
        val frame = ClassicCanFrame.parse(line)
        if (frame.id == profile.rxId) assembler.append(frame.data) {
            if (pending.size >= 8) throw IOException("Too many pending RS SDK packets")
            pending.addLast(it)
        }
    }

    override fun close() {
        prepared = false
        opened = false
        assembler.reset()
        pending.clear()
        if (closeNeeded) {
            closeNeeded = false
            wire.expectAck("C", nowNs() + ioTimeoutNs)
        }
    }
}

private const val SDK_SOF = 0xAA
private const val SDK_MAX_LENGTH = 0x03FF
private const val SDK_MIN_LENGTH = 16

private class RsPacketAssembler {
    private val buffer = ByteArray(SDK_MAX_LENGTH)
    private var size = 0
    private var length = 0

    fun append(data: ByteArray, emit: (ByteArray) -> Unit) {
        for (byte in data) {
            if (size == 0 && byte != SDK_SOF.toByte()) continue
            buffer[size++] = byte
            if (size == 3) {
                length = ((buffer[1].toInt() and 0xFF) or ((buffer[2].toInt() and 0xFF) shl 8)) and SDK_MAX_LENGTH
                if (length < SDK_MIN_LENGTH) reset()
            }
            if (size > 0 && size == length) {
                val packet = buffer.copyOf(size)
                reset()
                emit(packet)
            }
        }
    }

    fun reset() {
        size = 0
        length = 0
    }
}
