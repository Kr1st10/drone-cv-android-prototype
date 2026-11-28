package ru.university.dronecv.weact

import com.fazecast.jSerialComm.SerialPort
import java.io.IOException
import java.io.InterruptedIOException
import java.net.SocketTimeoutException
import java.util.concurrent.locks.LockSupport

internal class MacSerialIo private constructor(private val port: SerialPort) : SerialIo {
    override fun read(timeoutNs: Long): ByteArray? {
        val deadline = System.nanoTime() + timeoutNs
        while (deadline - System.nanoTime() > 0) {
            val available = port.bytesAvailable()
            if (available < 0 || !port.isOpen) throw IOException("USB serial port disconnected")
            if (available > 0) {
                val chunk = ByteArray(minOf(available, 256))
                val count = port.readBytes(chunk, chunk.size)
                if (count < 0) throw IOException("USB serial read failed")
                if (count > 0) return if (count == chunk.size) chunk else chunk.copyOf(count)
            }
            waitForIo(deadline)
        }
        return null
    }

    override fun write(bytes: ByteArray, timeoutNs: Long) {
        val deadline = System.nanoTime() + timeoutNs
        var sent = 0
        while (sent < bytes.size) {
            if (deadline - System.nanoTime() <= 0) throw SocketTimeoutException("USB serial write timed out")
            if (!port.isOpen) throw IOException("USB serial port disconnected")
            val count = port.writeBytes(bytes, bytes.size - sent, sent)
            if (count < 0) throw IOException("USB serial write failed")
            if (count == 0) waitForIo(deadline) else sent += count
        }
    }

    private fun waitForIo(deadline: Long) {
        val remaining = deadline - System.nanoTime()
        if (remaining > 0) LockSupport.parkNanos(minOf(remaining, 1_000_000L))
        if (Thread.currentThread().isInterrupted) throw InterruptedIOException("USB serial I/O interrupted")
    }

    override fun close() {
        if (port.isOpen && !port.closePort()) throw IOException("Could not close USB serial port")
    }

    companion object {
        fun open(path: String): MacSerialIo {
            require(System.getProperty("os.name") == "Mac OS X") { "A macOS USB callout port is required" }
            require(Regex("/dev/cu\\.usbmodem[^/]+").matches(path)) { "Use the adapter's /dev/cu.usbmodem… port" }
            val port = SerialPort.getCommPort(path)
            port.setComPortParameters(115_200, 8, SerialPort.ONE_STOP_BIT, SerialPort.NO_PARITY)
            port.setFlowControl(SerialPort.FLOW_CONTROL_DISABLED)
            port.setComPortTimeouts(SerialPort.TIMEOUT_NONBLOCKING, 0, 0)
            if (!port.openPort(0)) throw IOException("Could not open $path (absent, busy, or access denied)")
            return MacSerialIo(port)
        }
    }
}
