package ru.university.dronecv.weact

import java.io.IOException
import java.net.SocketTimeoutException

private const val CR = 13
private const val BEL = 7
private const val MAX_LINE = 256

internal const val CLASSIC_CAN_BYTES = 8

private const val HEX_DIGITS = "0123456789ABCDEF"
private val weActVersion = Regex("""WeAct Studio .*?V[0-9]+(?:\.[0-9]+)+(?:_[0-9A-Fa-f]+)?""")

internal data class ClassicCanFrame(val id: Int, val data: ByteArray) {
    init { require(id in 0..0x7FF && data.size <= CLASSIC_CAN_BYTES) }

    fun encode(): String = buildString(5 + data.size * 2) {
        append('t')
        append(HEX_DIGITS[id shr 8])
        append(HEX_DIGITS[(id shr 4) and 0xF])
        append(HEX_DIGITS[id and 0xF])
        append(data.size)
        for (byte in data) {
            append(HEX_DIGITS[(byte.toInt() shr 4) and 0xF])
            append(HEX_DIGITS[byte.toInt() and 0xF])
        }
    }

    companion object {
        fun parse(line: String): ClassicCanFrame {
            if (!line.startsWith('t') || line.length < 5) throw IOException("Invalid SLCAN data frame")
            val id = line.substring(1, 4).takeIf { it.all { it.isAsciiHexDigit() } }?.toInt(16)
            val size = line[4].digitToIntOrNull()
            if (id == null || id !in 0..0x7FF || size == null || size !in 0..CLASSIC_CAN_BYTES ||
                line.length != 5 + size * 2 || !line.substring(5).all { it.isAsciiHexDigit() }
            ) throw IOException("Invalid SLCAN data frame")
            val data = ByteArray(size) { index ->
                val offset = 5 + index * 2
                ((line[offset].digitToInt(16) shl 4) or line[offset + 1].digitToInt(16)).toByte()
            }
            return ClassicCanFrame(id, data)
        }
    }
}

private fun Char.isAsciiHexDigit(): Boolean = this in '0'..'9' || this in 'A'..'F' || this in 'a'..'f'

internal sealed interface SlcanEvent {
    data object Ack : SlcanEvent
    data object Rejected : SlcanEvent
    data class Line(val value: String) : SlcanEvent
}

internal class SlcanCommandRejected(command: Char) : IOException("WeAct rejected SLCAN command $command")
internal class SlcanAckTimeout(command: Char) : SocketTimeoutException("WeAct did not acknowledge SLCAN command $command")

internal class SlcanWire(private val serial: SerialIo, private val nowNs: () -> Long) {
    private val line = StringBuilder()
    private var chunk = ByteArray(0)
    private var offset = 0

    /** One USB read can contain part of a line, an acknowledgement, and several frame lines. */
    fun next(deadline: Long): SlcanEvent? {
        while (deadline - nowNs() > 0) {
            if (offset == chunk.size) {
                val remaining = deadline - nowNs()
                if (remaining <= 0) return null
                chunk = serial.read(remaining) ?: return null
                offset = 0
                if (chunk.isEmpty() || deadline - nowNs() <= 0) return null
            }
            when (val byte = chunk[offset++].toInt() and 0xFF) {
                CR -> {
                    if (line.isEmpty()) return SlcanEvent.Ack
                    return SlcanEvent.Line(line.toString()).also { line.clear() }
                }
                BEL -> {
                    line.clear()
                    return SlcanEvent.Rejected
                }
                10 -> if (line.isNotEmpty()) throw IOException("Unexpected LF in SLCAN line")
                in 32..126 -> {
                    if (line.length >= MAX_LINE) throw IOException("SLCAN line exceeds $MAX_LINE bytes")
                    line.append(byte.toChar())
                }
                else -> throw IOException("Unexpected byte in SLCAN text mode")
            }
        }
        return null
    }

    private fun send(command: String, deadline: Long) {
        val remaining = deadline - nowNs()
        if (remaining <= 0) throw SocketTimeoutException("Timed out before sending ${command.first()}")
        serial.write("$command\r".toByteArray(Charsets.US_ASCII), remaining)
    }

    fun expectAck(
        command: String,
        deadline: Long,
        onLine: (String) -> Unit = {},
        allowRejection: Boolean = false,
    ) {
        send(command, deadline)
        while (true) {
            when (val response = next(deadline)) {
                SlcanEvent.Ack -> return
                SlcanEvent.Rejected -> {
                    if (allowRejection) return
                    throw SlcanCommandRejected(command.first())
                }
                is SlcanEvent.Line -> onLine(response.value)
                null -> throw SlcanAckTimeout(command.first())
            }
        }
    }

    /** The only command used by adapter-info. It does not open CAN. */
    fun version(timeoutNs: Long): String {
        val deadline = nowNs() + timeoutNs
        send("V", deadline)
        while (true) {
            when (val response = next(deadline)) {
                is SlcanEvent.Line -> if (weActVersion.matches(response.value)) return response.value
                SlcanEvent.Rejected -> throw IOException("WeAct rejected the version query")
                SlcanEvent.Ack -> Unit
                null -> throw SocketTimeoutException("No WeAct firmware version reply")
            }
        }
    }
}
